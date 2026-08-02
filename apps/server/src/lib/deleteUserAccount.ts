/**
 * Hard-delete a user account, for real.
 *
 * `DELETE FROM users` alone does not do this, for three reasons that were all
 * live before this module existed:
 *
 *  1. THREE FOREIGN KEYS BLOCK IT. `affiliates.owner_user_id`,
 *     `affiliates.reviewed_by` and `user_permission_overrides.set_by_user_id`
 *     are ON DELETE NO ACTION. With `foreign_keys = ON` (db/index.ts) the
 *     delete of an affected user raises FOREIGN KEY constraint failed and the
 *     whole statement aborts, so NOTHING is removed. That is what "their
 *     worlds and books don't get deleted" looks like from the outside: the
 *     cascade is wired correctly and simply never runs.
 *
 *  2. ABOUT TWENTY TABLES CARRY A USER OR IDENTITY ID WITH NO FOREIGN KEY AT
 *     ALL, so no cascade can reach them. They are keyed by an
 *     (owner_scope, owner_id) identity pair that can point at either a user or
 *     one of their characters, which is exactly why they cannot have one.
 *     `earning_ledger` is the big one; inventory, collections, pets, the
 *     Eidolon tables, arcade scores and write streaks are the rest. Left
 *     alone they outlive the account as unreachable rows.
 *
 *  3. `messages.user_id` IS CASCADE, not `set null`. The old route comment
 *     claimed otherwise. Deleting an account therefore tore every line it had
 *     ever written out of other people's rooms and forum threads. Chat is
 *     shared history, so those rows are re-pointed at the reserved system
 *     account and their snapshotted display name is replaced with a
 *     tombstone: the conversation still reads, the person is gone.
 *
 * Policy, in one line: purge what is theirs, anonymise what is shared, and
 * never destroy something another member paid for.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  affiliates,
  characters,
  messages,
  stories,
  storyCopies,
  userPermissionOverrides,
  users,
} from "../db/schema.js";

/**
 * Username of the reserved account that outlives every deletion. Seeded by
 * `ensureSystemSeeds` at boot (not by a migration) and already excluded from
 * admin listings, member counts and mention resolution BY USERNAME, so
 * re-pointing rows at it does not resurrect the person as a visible member
 * anywhere.
 *
 * Resolved by username rather than by its `"system"` id: the id is a seed
 * detail, the username is the marker every other filter in the codebase keys
 * on.
 */
const RESERVED_USERNAME = "system";

/** What a deleted member's shared history is attributed to. Matches the
 *  `(deleted user)` string the admin log and profile surfaces already use for
 *  a reference whose row has gone. */
export const DELETED_USER_LABEL = "(deleted user)";

/**
 * Tables with an (owner_scope, owner_id) identity pair and no foreign key.
 * `scopeColumn` differs across them, which is the whole reason this is a table
 * rather than a loop over one name.
 */
const IDENTITY_OWNED: ReadonlyArray<{ table: string; scopeColumn: string; idColumn: string }> = [
  { table: "earning_ledger", scopeColumn: "scope", idColumn: "owner_id" },
  { table: "identity_inventory", scopeColumn: "owner_scope", idColumn: "owner_id" },
  { table: "identity_collection", scopeColumn: "owner_scope", idColumn: "owner_id" },
  { table: "identity_pet_collection", scopeColumn: "owner_scope", idColumn: "owner_id" },
  { table: "eidolon_state", scopeColumn: "owner_scope", idColumn: "owner_id" },
  { table: "eidolon_hall", scopeColumn: "owner_scope", idColumn: "owner_id" },
  { table: "game_stats", scopeColumn: "owner_scope", idColumn: "owner_id" },
  { table: "urugal_run", scopeColumn: "owner_scope", idColumn: "owner_id" },
  { table: "scriptorium_write_streaks", scopeColumn: "owner_scope", idColumn: "owner_id" },
];

/**
 * Plain `<table>.<column> = <userId>` rows with no foreign key. Deleted
 * outright: none of them is content anyone else can see.
 */
const USER_OWNED_ROWS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "analytics_event", column: "user_id" },
  { table: "tour_seen", column: "user_id" },
];

/**
 * Provenance columns with no foreign key: "who added this", "who removed
 * that". Blanked rather than deleted, because the row belongs to someone else
 * and only its attribution mentions the departing account.
 */
const PROVENANCE_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "messages", column: "npc_voiced_by" },
  { table: "messages", column: "deleted_by_user_id" },
  { table: "pinned_messages", column: "author_user_id" },
  { table: "mod_case_evidence", column: "author_user_id" },
  { table: "server_invites", column: "created_by_user_id" },
  { table: "forum_usergroup_members", column: "added_by" },
  { table: "server_usergroup_members", column: "added_by" },
  { table: "bookmarks", column: "snapshot_author_user_id" },
];

export interface DeleteAccountResult {
  /** Chat and forum lines re-attributed rather than destroyed. */
  messagesAnonymised: number;
  /** Books kept alive because another member had bought a copy. */
  storiesPreserved: number;
  /** Identity-scoped rows removed that no cascade could have reached. */
  orphanRowsPurged: number;
}

/**
 * Remove `userId` and everything that should go with them.
 *
 * Runs as one better-sqlite3 transaction, so a constraint failure anywhere
 * leaves the account fully intact rather than half-scrubbed. Callers should
 * disconnect the user's sockets first; that is not undoable and so does not
 * belong inside the transaction.
 */
export function deleteUserAccount(db: Db, userId: string): DeleteAccountResult {
  return db.transaction((tx): DeleteAccountResult => {
    // Shared history is re-pointed here rather than destroyed, so without the
    // reserved account there is nowhere safe to put it. Fail before touching
    // anything instead of falling back to deleting other people's rooms.
    const reserved = tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, RESERVED_USERNAME))
      .limit(1)
      .all()[0];
    if (!reserved) {
      throw new Error(`cannot delete account: reserved "${RESERVED_USERNAME}" user is missing`);
    }
    const reservedId = reserved.id;

    const characterIds = tx
      .select({ id: characters.id })
      .from(characters)
      .where(eq(characters.userId, userId))
      .all()
      .map((r) => r.id);

    /* ---- 1. Keep books other members paid for -------------------------
     * story_copies is a pointer with no content of its own and cascades from
     * `stories`, so letting the author's deletion take the book would delete
     * the purchase out of the buyer's library. Those stories are handed to
     * the reserved account instead; every other story of theirs still
     * cascades away with the user row. */
    const soldStoryIds = tx
      .selectDistinct({ id: storyCopies.storyId })
      .from(storyCopies)
      .innerJoin(stories, eq(stories.id, storyCopies.storyId))
      .where(and(eq(stories.authorUserId, userId), ne(storyCopies.ownerUserId, userId)))
      .all()
      .map((r) => r.id);
    if (soldStoryIds.length > 0) {
      tx.update(stories)
        .set({ authorUserId: reservedId })
        .where(inArray(stories.id, soldStoryIds))
        .run();
    }

    /* ---- 2. Anonymise shared history ----------------------------------
     * `messages.user_id` is NOT NULL and cascades, so the row can only be
     * saved by re-pointing it. `display_name` is a snapshot taken at post
     * time, which is what actually carries the identity, so it is the thing
     * that has to be overwritten. character_id is cleared because characters
     * cascade away underneath it. */
    const anonymised = tx
      .update(messages)
      .set({ userId: reservedId, characterId: null, displayName: DELETED_USER_LABEL })
      .where(eq(messages.userId, userId))
      .run().changes;

    /* ---- 3. Clear the three blocking foreign keys ----------------------
     * Without this the DELETE below aborts and the entire account survives. */
    tx.update(affiliates).set({ ownerUserId: null }).where(eq(affiliates.ownerUserId, userId)).run();
    tx.update(affiliates).set({ reviewedBy: null }).where(eq(affiliates.reviewedBy, userId)).run();
    // set_by_user_id is NOT NULL, so the grant is re-attributed rather than
    // dropped: deleting the row would silently revoke a permission that
    // someone else still holds.
    tx.update(userPermissionOverrides)
      .set({ setByUserId: reservedId })
      .where(eq(userPermissionOverrides.setByUserId, userId))
      .run();

    /* ---- 4. Purge what no cascade can reach ---------------------------- */
    let orphanRowsPurged = 0;
    for (const { table, scopeColumn, idColumn } of IDENTITY_OWNED) {
      // Scope-aware so a character id can never be mistaken for a user id:
      // the account's own rows are scope="user", each character's are
      // scope="character". The two halves are separate statements because a
      // user with no characters has no id list to match against, and an empty
      // `IN ()` is a syntax error in SQLite.
      orphanRowsPurged += tx.run(sql`
        DELETE FROM ${sql.identifier(table)}
        WHERE ${sql.identifier(scopeColumn)} = 'user' AND ${sql.identifier(idColumn)} = ${userId}
      `).changes;
      if (characterIds.length > 0) {
        orphanRowsPurged += tx.run(sql`
          DELETE FROM ${sql.identifier(table)}
          WHERE ${sql.identifier(scopeColumn)} = 'character'
            AND ${sql.identifier(idColumn)} IN (${sql.join(characterIds.map((c) => sql`${c}`), sql`, `)})
        `).changes;
      }
    }
    // eidolon_visits keys on the VISITOR as a plain user id as well as on the
    // target identity, so it needs both halves.
    orphanRowsPurged += tx.run(sql`
      DELETE FROM eidolon_visits WHERE visitor_user_id = ${userId}
    `).changes;
    for (const { table, column } of USER_OWNED_ROWS) {
      orphanRowsPurged += tx.run(
        sql`DELETE FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${userId}`,
      ).changes;
    }
    for (const { table, column } of PROVENANCE_COLUMNS) {
      tx.run(
        sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = NULL WHERE ${sql.identifier(column)} = ${userId}`,
      );
    }

    /* ---- 5. The row itself --------------------------------------------
     * Now that nothing blocks it, this cascades through the 88 foreign keys
     * that DO point at users: characters, worlds and every page/entity/map
     * under them, the remaining stories, memberships, sessions, bans. */
    tx.delete(users).where(eq(users.id, userId)).run();

    return {
      messagesAnonymised: anonymised,
      storiesPreserved: soldStoryIds.length,
      orphanRowsPurged,
    };
  });
}
