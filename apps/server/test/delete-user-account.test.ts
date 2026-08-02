import "./helpers/env.js";
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { DELETED_USER_LABEL, deleteUserAccount } from "../src/lib/deleteUserAccount.js";
import { createUser, makeTestDb } from "./helpers/harness.js";

/**
 * Hard account deletion.
 *
 * Three separate bugs made the old bare `DELETE FROM users` not actually
 * delete anything, and each has a test here so they cannot come back:
 *
 *   1. Three NO ACTION foreign keys aborted the statement, so an affected
 *      account survived entirely (worlds and books included). That is the
 *      "deletion doesn't remove their worlds" report.
 *   2. About twenty identity-keyed tables have no foreign key at all, so no
 *      cascade reached them and they outlived the account.
 *   3. `messages.user_id` cascades, so deleting an account tore its lines out
 *      of other people's rooms instead of anonymising them.
 *
 * Plus the policy call: a book another member paid for must survive, because
 * `story_copies` is a bare pointer that cascades from `stories`.
 */

/** The reserved account the service re-points shared history at. Seeded at
 *  boot by `ensureSystemSeeds`, never by a migration, so the harness has to
 *  provide it the same way production does. */
async function seedReservedUser(db: Db): Promise<string> {
  await db.insert(schema.users).values({
    id: "system",
    username: "system",
    email: "system@test.local",
    passwordHash: "x",
    role: "admin",
  });
  return "system";
}

describe("hard account deletion", () => {
  let db: Db;
  let victim: string;
  let bystander: string;

  beforeEach(async () => {
    ({ db } = makeTestDb());
    await seedReservedUser(db);
    victim = (await createUser(db, { username: "victim" })).id;
    bystander = (await createUser(db, { username: "bystander" })).id;
  });

  async function makeRoom(): Promise<string> {
    const id = nanoid();
    await db.insert(schema.rooms).values({ id, name: `r_${id.slice(0, 6)}`, type: "public" });
    return id;
  }

  async function postMessage(roomId: string, userId: string, displayName: string): Promise<string> {
    const id = nanoid();
    await db.insert(schema.messages).values({
      id, roomId, userId, displayName, body: "hello", kind: "chat",
    });
    return id;
  }

  test("an account blocked by a NO ACTION foreign key can now be deleted at all", async () => {
    // affiliates.owner_user_id is ON DELETE NO ACTION: before this service a
    // bare delete raised FOREIGN KEY constraint failed and rolled back, so the
    // account and everything under it survived.
    await db.insert(schema.affiliates).values({
      id: nanoid(), label: "Partner", html: "<p>x</p>", ownerUserId: victim,
    });

    deleteUserAccount(db, victim);

    assert.equal((await db.select().from(schema.users).where(eq(schema.users.id, victim))).length, 0);
    // The affiliate itself belongs to the site, so it stays, just unowned.
    const aff = (await db.select().from(schema.affiliates))[0];
    assert.ok(aff);
    assert.equal(aff.ownerUserId, null);
  });

  test("worlds and books go with the account", async () => {
    const worldId = nanoid();
    await db.insert(schema.worlds).values({
      id: worldId, ownerUserId: victim, slug: "w", name: "World",
    });
    await db.insert(schema.worldPages).values({
      id: nanoid(), worldId, slug: "p", title: "Page", bodyHtml: "<p>lore</p>",
    });
    const storyId = nanoid();
    await db.insert(schema.stories).values({
      id: storyId, authorUserId: victim, slug: "s", title: "Book",
    });

    deleteUserAccount(db, victim);

    assert.equal((await db.select().from(schema.worlds)).length, 0);
    // The page went with its world, proving the cascade actually ran.
    assert.equal((await db.select().from(schema.worldPages)).length, 0);
    assert.equal((await db.select().from(schema.stories)).length, 0);
  });

  test("a book another member paid for survives, and so does their copy", async () => {
    const sold = nanoid();
    const unsold = nanoid();
    for (const [id, slug] of [[sold, "sold"], [unsold, "unsold"]] as const) {
      await db.insert(schema.stories).values({ id, authorUserId: victim, slug, title: slug });
    }
    await db.insert(schema.storyCopies).values({
      id: nanoid(), storyId: sold, ownerScope: "user", ownerId: bystander,
      ownerUserId: bystander, pricePaid: 50,
    });

    const result = deleteUserAccount(db, victim);

    assert.equal(result.storiesPreserved, 1);
    const left = await db.select().from(schema.stories);
    assert.deepEqual(left.map((s) => s.id), [sold]);
    // Handed to the reserved account so the buyer's pointer still resolves.
    assert.equal(left[0]?.authorUserId, "system");
    assert.equal((await db.select().from(schema.storyCopies)).length, 1);
  });

  test("chat history is anonymised, not torn out of other people's rooms", async () => {
    const roomId = await makeRoom();
    const theirs = await postMessage(roomId, victim, "Victim");
    const others = await postMessage(roomId, bystander, "Bystander");

    const result = deleteUserAccount(db, victim);

    assert.equal(result.messagesAnonymised, 1);
    const rows = await db.select().from(schema.messages).orderBy(schema.messages.id);
    // Both lines still exist: the conversation is readable.
    assert.equal(rows.length, 2);
    const mine = rows.find((r) => r.id === theirs);
    assert.ok(mine, "the deleted member's line should still be there");
    assert.equal(mine.displayName, DELETED_USER_LABEL);
    assert.equal(mine.userId, "system");
    assert.equal(mine.characterId, null);
    // The bystander is untouched.
    assert.equal(rows.find((r) => r.id === others)?.displayName, "Bystander");
  });

  test("identity-keyed rows no cascade can reach are purged, for the user AND their characters", async () => {
    const charId = nanoid();
    await db.insert(schema.characters).values({ id: charId, userId: victim, name: "Alt" });

    // earning_ledger has no foreign key to users at all: it keys on an
    // (scope, owner_id) pair that may point at either identity.
    const ledger = (scope: string, ownerId: string) => db.run(
      sql`INSERT INTO earning_ledger (id, scope, owner_id, xp_delta, currency_delta, reason)
          VALUES (${nanoid()}, ${scope}, ${ownerId}, 10, 0, 'test')`,
    );
    await ledger("user", victim);
    await ledger("character", charId);
    // A bystander row that must NOT be swept up.
    await ledger("user", bystander);

    const result = deleteUserAccount(db, victim);

    assert.ok(result.orphanRowsPurged >= 2, `expected both ledger rows purged, got ${result.orphanRowsPurged}`);
    const left = await db.all<{ owner_id: string }>(sql`SELECT owner_id FROM earning_ledger`);
    assert.deepEqual(left.map((r) => r.owner_id), [bystander]);
  });

  test("a user with no characters deletes cleanly", async () => {
    // Guards the identity purge against building an empty `IN ()`, which is a
    // syntax error in SQLite.
    deleteUserAccount(db, victim);
    assert.equal((await db.select().from(schema.users).where(eq(schema.users.id, victim))).length, 0);
  });

  test("without the reserved account nothing is touched", async () => {
    await db.delete(schema.users).where(eq(schema.users.username, "system"));
    const roomId = await makeRoom();
    await postMessage(roomId, victim, "Victim");

    assert.throws(() => deleteUserAccount(db, victim), /reserved/);

    // The transaction rolled back: the account and its history are intact
    // rather than half-scrubbed.
    assert.equal((await db.select().from(schema.users).where(eq(schema.users.id, victim))).length, 1);
    assert.equal((await db.select().from(schema.messages))[0]?.displayName, "Victim");
  });
});
