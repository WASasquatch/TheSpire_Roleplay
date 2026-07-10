/**
 * Starter furniture for a forum: one general board plus the system
 * welcome sticky. A brand-new forum without these is a dead end — no
 * board means no New Topic affordance anywhere (and the posting tour
 * narrates into a void), which is exactly how the owner's early test
 * forums ended up before the approve path learned to seed.
 *
 * Shared by BOTH writers so they can't drift:
 *   - the application-approve path (routes/forums/applications.ts),
 *     inside its own synchronous transaction;
 *   - the boot backfill below, which repairs forums provisioned before
 *     seeding existed (or later emptied of every board).
 *
 * The welcome topic is persisted CONTENT and stays English by the
 * persisted-rows rule (shared rows can't be per-recipient).
 */
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { escapeRegExp } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { forums, messages, rooms } from "../db/schema.js";

/** The drizzle sync-transaction shape both callers hand in. */
type Tx = Pick<Db, "insert" | "select">;

export function seedForumStarter(tx: Tx, args: {
  forumId: string;
  forumName: string;
  ownerUserId: string;
  boardId: string;
  boardName: string;
}): void {
  tx.insert(rooms).values({
    id: args.boardId,
    name: args.boardName,
    type: "public",
    ownerId: args.ownerUserId,
    originalOwnerUserId: args.ownerUserId,
    lastOwnerUserId: args.ownerUserId,
    topic: "General discussion",
    replyMode: "nested",
    forumId: args.forumId,
    // Boards never hold sockets (chat joins into boards are refused for
    // everyone), so every empty-room archival path must leave them alone.
    // `persistent` is the same exemption server channels use — belt and
    // braces on top of the forumId guards in expireIfEmpty and the boot
    // zombie sweep, which once archived every board 60s after start.
    persistent: true,
  }).run();
  tx.insert(messages).values({
    id: nanoid(),
    roomId: args.boardId,
    userId: "system",
    characterId: null,
    displayName: "The Spire",
    kind: "say",
    title: "Welcome, Keeper - your forum stands",
    body: [
      `${args.forumName} is yours to tend. As its Keeper you can:`,
      "",
      "• Raise boards and shape categories from your forum settings.",
      "• Sticky and lock topics, and appoint Forum Moderators to help you tend the boards.",
      "• Welcome everyone, or gate posting behind an application - your call.",
      "• Set your forum's banner, sigil, and colors so the place feels like yours.",
      "",
      `Your forum lives at /forums - share the word. Pin this topic or sweep it away; the hall is yours.`,
    ].join("\n"),
    isSticky: true,
    lastActivityAt: new Date(),
  }).run();
}

/**
 * Boot backfill: any LIVE (non-archived — featured counts, `catalogRank`
 * sorts it first), non-system forum with zero live boards gets the starter
 * furniture. Idempotent (the zero-boards predicate is the guard); board
 * names follow the approve path's `<slug>_general` shape with a numeric
 * suffix when the global room-name index already holds it.
 *
 * HEAL before minting: the pre-fix zombie sweep archived every board 60s
 * after each boot (boards can never hold sockets), so each pass minted a
 * fresh `<slug>_general_N` and stranded the previous board's topics in an
 * archived room. When an archived starter-shaped board exists, un-archive
 * the newest one — its topics come back with it — instead of adding yet
 * another suffix. Scoped to the starter's own `<slug>_general*` name shape
 * so a board the owner deliberately deleted (the boards DELETE route
 * archives) is never resurrected against their wishes.
 */
export async function ensureForumStarterBoards(db: Db): Promise<void> {
  const bare = await db
    .select({ id: forums.id, slug: forums.slug, name: forums.name, ownerUserId: forums.ownerUserId })
    .from(forums)
    .where(and(
      eq(forums.isSystem, false),
      ne(forums.status, "archived"),
      sql`NOT EXISTS (
        SELECT 1 FROM ${rooms} r
        WHERE r.forum_id = ${forums.id} AND r.archived_at IS NULL
      )`,
    ));
  if (bare.length === 0) return;

  for (const f of bare) {
    // Heal path: newest archived `<slug>_general` / `<slug>_general_N`
    // board of THIS forum, matched in JS (slug may contain `_`, which is a
    // LIKE wildcard). `persistent: true` retro-hardens boards seeded before
    // the flag existed.
    const starterName = new RegExp(`^${escapeRegExp(f.slug)}_general(_\\d+)?$`, "i");
    const archived = (await db
      .select({ id: rooms.id, name: rooms.name, archivedAt: rooms.archivedAt })
      .from(rooms)
      .where(and(eq(rooms.forumId, f.id), isNotNull(rooms.archivedAt))))
      .filter((r) => starterName.test(r.name))
      .sort((a, b) => (b.archivedAt?.getTime() ?? 0) - (a.archivedAt?.getTime() ?? 0));
    const heal = archived[0];
    if (heal) {
      await db.update(rooms)
        .set({ archivedAt: null, persistent: true })
        .where(eq(rooms.id, heal.id));
      console.log(`[seed] restored archived starter board "${heal.name}" (topics intact) for forum "${f.slug}"`);
      continue;
    }

    // Global case-insensitive room-name uniqueness: probe for a free name
    // rather than 409ing like the approve path (a backfill has no user to
    // re-prompt). Five suffixes is plenty; a pathological clash run just
    // leaves the forum bare for the next boot + a log line.
    let boardName: string | null = null;
    for (let i = 0; i < 5; i++) {
      const candidate = i === 0 ? `${f.slug}_general` : `${f.slug}_general_${i + 1}`;
      const clash = (await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(sql`lower(${rooms.name}) = ${candidate.toLowerCase()}`)
        .limit(1))[0];
      if (!clash) { boardName = candidate; break; }
    }
    if (!boardName) {
      console.warn(`[seed] forum ${f.slug}: no free starter-board name after 5 tries, leaving bare`);
      continue;
    }
    seedForumStarter(db, {
      forumId: f.id,
      forumName: f.name,
      ownerUserId: f.ownerUserId,
      boardId: nanoid(),
      boardName,
    });
    console.log(`[seed] furnished bare forum "${f.slug}" with starter board "${boardName}"`);
  }
}
