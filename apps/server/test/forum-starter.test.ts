import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { ensureForumStarterBoards } from "../src/forums/starter.js";
import { expireIfEmpty } from "../src/realtime/broadcast/presence.js";
import { createUser, makeTestDb } from "./helpers/harness.js";

/**
 * Starter-board lifecycle. Forum boards can NEVER hold sockets (chat joins
 * into boards are refused for everyone), so "empty" is their steady state —
 * the empty-room archival paths must leave them alone, and the boot
 * backfill must repair the forums the pre-fix zombie sweep already churned
 * (it archived every board 60s after each boot, minting `_general_2..5`
 * and stranding topics until the forum went permanently bare).
 *
 * Pins here:
 *   - seeded boards are `persistent` and carry the welcome sticky;
 *   - `expireIfEmpty` refuses to archive a board (the runtime half of the
 *     exemption; the boot sweep's candidate query is the other half);
 *   - the backfill HEALS a churned forum by un-archiving the newest
 *     `<slug>_general*` board (topics intact) instead of minting a suffix;
 *   - deliberately deleted non-starter boards are never resurrected;
 *   - featured forums are live too and get repaired like active ones.
 */

const { db } = makeTestDb();

/** io stand-in for expireIfEmpty: no sockets anywhere, swallow emits. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const io: any = {
  in: () => ({ fetchSockets: async () => [] }),
  to: () => ({ emit: () => {} }),
  emit: () => {},
};

let owner: { id: string };

async function createForum(
  db2: Db,
  opts: { slug: string; status?: "active" | "featured" | "archived" },
): Promise<string> {
  const id = nanoid();
  await db2.insert(schema.forums).values({
    id,
    slug: opts.slug,
    name: `Forum ${opts.slug}`,
    ownerUserId: owner.id,
    ...(opts.status ? { status: opts.status } : {}),
  });
  return id;
}

async function boardsOf(db2: Db, forumId: string) {
  return db2
    .select({
      id: schema.rooms.id,
      name: schema.rooms.name,
      persistent: schema.rooms.persistent,
      archivedAt: schema.rooms.archivedAt,
    })
    .from(schema.rooms)
    .where(eq(schema.rooms.forumId, forumId));
}

before(async () => {
  // The welcome sticky is authored by the "system" account (created by the
  // boot seed in prod; the harness applies migrations only).
  await db.insert(schema.users).values({
    id: "system",
    username: "system",
    email: "system@test.local",
    passwordHash: "x",
  });
  owner = await createUser(db, { username: "keeper" });
});

describe("ensureForumStarterBoards", () => {
  test("furnishes a bare active forum with a persistent starter board + welcome sticky", async () => {
    const forumId = await createForum(db, { slug: "ravenhold" });
    await ensureForumStarterBoards(db);

    const boards = await boardsOf(db, forumId);
    assert.equal(boards.length, 1);
    assert.equal(boards[0]!.name, "ravenhold_general");
    assert.equal(boards[0]!.persistent, true, "starter boards are archival-exempt by flag too");
    assert.equal(boards[0]!.archivedAt, null);

    const sticky = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.roomId, boards[0]!.id));
    assert.equal(sticky.length, 1);
    assert.equal(sticky[0]!.isSticky, true);
  });

  test("is idempotent: a furnished forum is left alone", async () => {
    const forumId = await createForum(db, { slug: "stillwater" });
    await ensureForumStarterBoards(db);
    await ensureForumStarterBoards(db);
    assert.equal((await boardsOf(db, forumId)).length, 1);
  });

  test("heals a churned forum by un-archiving the NEWEST starter board, topics intact", async () => {
    // Simulate the pre-fix churn: original board archived at boot+60s, the
    // next boot's replacement archived a day later. The owner's topics live
    // in the archived boards.
    const forumId = await createForum(db, { slug: "grimwatch" });
    const oldId = nanoid();
    const newId = nanoid();
    await db.insert(schema.rooms).values([
      {
        id: oldId, name: "grimwatch_general", type: "public", replyMode: "nested",
        forumId, archivedAt: new Date(Date.now() - 86_400_000),
      },
      {
        id: newId, name: "grimwatch_general_2", type: "public", replyMode: "nested",
        forumId, archivedAt: new Date(Date.now() - 3_600_000),
      },
    ]);
    await db.insert(schema.messages).values({
      id: nanoid(), roomId: newId, userId: owner.id, displayName: "keeper",
      kind: "say", title: "a stranded topic", body: "hello?",
    });

    await ensureForumStarterBoards(db);

    const boards = await boardsOf(db, forumId);
    assert.equal(boards.length, 2, "no third suffix board is minted");
    const live = boards.filter((b) => b.archivedAt === null);
    assert.equal(live.length, 1);
    assert.equal(live[0]!.id, newId, "the newest archived starter board is restored");
    assert.equal(live[0]!.persistent, true, "healing retro-hardens the board");
    const topics = await db.select().from(schema.messages).where(eq(schema.messages.roomId, newId));
    assert.equal(topics.length, 1, "the stranded topic came back with the board");
    assert.equal(
      boards.find((b) => b.id === oldId)!.archivedAt === null,
      false,
      "older churned boards stay archived (admin tools can still resurrect)",
    );
  });

  test("never resurrects a non-starter board the owner deliberately deleted", async () => {
    const forumId = await createForum(db, { slug: "oathbreak" });
    const deletedId = nanoid();
    await db.insert(schema.rooms).values({
      id: deletedId, name: "oathbreak_offtopic", type: "public", replyMode: "nested",
      forumId, archivedAt: new Date(),
    });

    await ensureForumStarterBoards(db);

    const boards = await boardsOf(db, forumId);
    assert.equal(boards.find((b) => b.id === deletedId)!.archivedAt === null, false, "owner's delete is respected");
    const live = boards.filter((b) => b.archivedAt === null);
    assert.equal(live.length, 1, "a fresh starter board is minted instead");
    assert.equal(live[0]!.name, "oathbreak_general");
  });

  test("repairs FEATURED forums too (featured is live, not archived)", async () => {
    const forumId = await createForum(db, { slug: "goldspire", status: "featured" });
    await ensureForumStarterBoards(db);
    assert.equal((await boardsOf(db, forumId)).length, 1);
  });

  test("leaves archived forums bare", async () => {
    const forumId = await createForum(db, { slug: "dustheap", status: "archived" });
    await ensureForumStarterBoards(db);
    assert.equal((await boardsOf(db, forumId)).length, 0);
  });
});

describe("expireIfEmpty: forum boards are exempt", () => {
  test("an empty forum board is NOT archived; an empty plain room is", async () => {
    const forumId = await createForum(db, { slug: "holdfast" });
    await ensureForumStarterBoards(db);
    const board = (await boardsOf(db, forumId))[0]!;

    assert.equal(await expireIfEmpty(io, db, board.id), false, "boards never expire on emptiness");
    const after = (await boardsOf(db, forumId))[0]!;
    assert.equal(after.archivedAt, null);

    // Control: the same call archives an ordinary empty user room, so the
    // exemption above is the board guard, not a broken sweep.
    const plainId = nanoid();
    await db.insert(schema.rooms).values({ id: plainId, name: `plain_${plainId.slice(0, 6)}`, type: "public" });
    assert.equal(await expireIfEmpty(io, db, plainId), true);
    const plain = (await db
      .select({ archivedAt: schema.rooms.archivedAt })
      .from(schema.rooms)
      .where(and(eq(schema.rooms.id, plainId), isNull(schema.rooms.archivedAt))))[0];
    assert.equal(plain, undefined, "the plain room really was archived");
  });
});
