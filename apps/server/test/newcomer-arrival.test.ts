import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { and, eq, isNotNull } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { greetNewcomerOnce, roomVisibilityWhere } from "../src/realtime/targetedMessages.js";
import { findLiveliestLanding } from "../src/realtime/broadcast.js";
import { createUser, makeTestDb } from "./helpers/harness.js";

/**
 * Arrival experience (migration 0353, retention package):
 *   - greetNewcomerOnce — the one-time personal greeter: idempotency via the
 *     atomic greeted_at claim, and targeted-row visibility scoping (only the
 *     recipient's backlog reads include it).
 *   - findLiveliestLanding — the brand-new-account first-landing pick: gate
 *     composition (private / 18+ / annex / role-locked / nested never chosen)
 *     and the null fallback when nothing qualifies.
 */

type RoomRow = typeof schema.rooms.$inferSelect;

let n = 0;
async function mkRoom(
  db: Db,
  ownerId: string,
  opts: Partial<{
    name: string;
    type: "public" | "private";
    isNsfw: boolean;
    replyMode: "flat" | "nested";
    linkedRoomId: string;
    serverId: string;
    archivedAt: Date;
  }> = {},
): Promise<RoomRow> {
  const id = nanoid();
  const name = opts.name ?? `arrival-room-${++n}`;
  await db.insert(schema.rooms).values({
    id,
    name,
    type: opts.type ?? "public",
    ownerId,
    isNsfw: opts.isNsfw ?? false,
    replyMode: opts.replyMode ?? "flat",
    ...(opts.linkedRoomId ? { linkedRoomId: opts.linkedRoomId } : {}),
    ...(opts.serverId ? { serverId: opts.serverId } : {}),
    ...(opts.archivedAt ? { archivedAt: opts.archivedAt } : {}),
  });
  return (await db.select().from(schema.rooms).where(eq(schema.rooms.id, id)).limit(1))[0]!;
}

async function say(db: Db, roomId: string, userId: string, agoMs: number, kind = "say"): Promise<void> {
  await db.insert(schema.messages).values({
    id: nanoid(),
    roomId,
    userId,
    displayName: "someone",
    kind: kind as "say",
    body: "hello there",
    createdAt: new Date(Date.now() - agoMs),
  });
}

function fakeSocket(): { emitted: Array<{ ev: string; payload: unknown }>; emit: (ev: "message:new", payload: unknown) => void } {
  const emitted: Array<{ ev: string; payload: unknown }> = [];
  return { emitted, emit: (ev, payload) => emitted.push({ ev, payload }) };
}

describe("personal greeter (greetNewcomerOnce)", () => {
  test("greets a brand-new account exactly once — races and re-joins never double it", async () => {
    const { db } = makeTestDb();
    await createUser(db, { username: "system" });
    const owner = await createUser(db);
    const newbie = await createUser(db);
    const room = await mkRoom(db, owner.id);

    const sock = fakeSocket();
    await greetNewcomerOnce(db, sock, { id: newbie.id, username: newbie.username }, { id: room.id, name: room.name });

    const rows = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.targetUserId, newbie.id), eq(schema.messages.kind, "system")));
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.body, new RegExp(`Welcome, ${newbie.username}`));
    assert.equal(rows[0]!.roomId, room.id);
    assert.equal(sock.emitted.length, 1, "live copy emitted to the landing socket");

    // greeted_at was claimed.
    const u = (await db.select().from(schema.users).where(eq(schema.users.id, newbie.id)).limit(1))[0]!;
    assert.ok(u.greetedAt, "greeted_at stamped");

    // Second landing (another room, another tab): no second greeting.
    const room2 = await mkRoom(db, owner.id);
    const sock2 = fakeSocket();
    await greetNewcomerOnce(db, sock2, { id: newbie.id, username: newbie.username }, { id: room2.id, name: room2.name });
    const after = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.targetUserId, newbie.id));
    assert.equal(after.length, 1, "still exactly one greeting row");
    assert.equal(sock2.emitted.length, 0, "no second live emit");
  });

  test("a pre-stamped account (the migration backfill shape) is never greeted", async () => {
    const { db } = makeTestDb();
    await createUser(db, { username: "system" });
    const owner = await createUser(db);
    const veteran = await createUser(db);
    // Migration 0353 backfills greeted_at = created_at for every existing row.
    await db.update(schema.users).set({ greetedAt: new Date() }).where(eq(schema.users.id, veteran.id));
    const room = await mkRoom(db, owner.id);

    const sock = fakeSocket();
    await greetNewcomerOnce(db, sock, { id: veteran.id, username: veteran.username }, { id: room.id, name: room.name });
    const rows = await db.select().from(schema.messages).where(eq(schema.messages.targetUserId, veteran.id));
    assert.equal(rows.length, 0);
    assert.equal(sock.emitted.length, 0);
  });

  test("the greeting is a targeted row: invisible to every other viewer's backlog read", async () => {
    const { db } = makeTestDb();
    await createUser(db, { username: "system" });
    const owner = await createUser(db);
    const newbie = await createUser(db);
    const bystander = await createUser(db);
    const room = await mkRoom(db, owner.id);

    await greetNewcomerOnce(db, fakeSocket(), { id: newbie.id, username: newbie.username }, { id: room.id, name: room.name });

    const forNewbie = await db
      .select()
      .from(schema.messages)
      .where(and(roomVisibilityWhere(room.id, newbie.id, undefined, true), isNotNull(schema.messages.targetUserId)));
    assert.equal(forNewbie.length, 1, "recipient's backlog includes the greeting");

    const forBystander = await db
      .select()
      .from(schema.messages)
      .where(roomVisibilityWhere(room.id, bystander.id, undefined, true));
    assert.equal(forBystander.filter((m) => m.targetUserId != null).length, 0, "nobody else ever reads it");
  });
});

describe("liveliest-room first landing (findLiveliestLanding)", () => {
  test("picks the public flat room with the most recent human chat; every gated shape is skipped", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const talker = await createUser(db);

    // The should-win room: public, SFW, flat, default server, second-most
    // recent chat... but every LOUDER competitor below is gated.
    const good = await mkRoom(db, owner.id, { name: "Good_Tavern" });
    await say(db, good.id, talker.id, 60_000);

    // Private room with the freshest chat — never chosen.
    const priv = await mkRoom(db, owner.id, { type: "private" });
    await say(db, priv.id, talker.id, 1_000);

    // 18+ room (minor safety is viewer-agnostic: SFW only) — never chosen.
    const nsfw = await mkRoom(db, owner.id, { isNsfw: true });
    await say(db, nsfw.id, talker.id, 2_000);

    // 18+ annex (linkedRoomId) — never chosen.
    const annex = await mkRoom(db, owner.id, { linkedRoomId: good.id });
    await say(db, annex.id, talker.id, 3_000);

    // Nested-mode room (topic feed, hostile to a newcomer) — never chosen.
    const nested = await mkRoom(db, owner.id, { replyMode: "nested" });
    await say(db, nested.id, talker.id, 4_000);

    // Sub-server room — the first landing stays on the default server.
    const other = await createUser(db);
    const subServerId = nanoid();
    await db.insert(schema.servers).values({ id: subServerId, slug: "elsewhere", name: "Elsewhere", ownerUserId: other.id, joinMode: "open" });
    const sub = await mkRoom(db, owner.id, { serverId: subServerId });
    await say(db, sub.id, talker.id, 5_000);

    // Role-locked room (room_role_gates kind='access') — never chosen. The
    // usergroup needs a live server row to hang off (fresh test DBs have no
    // seeded system server), but the gate itself is what locks the room.
    const locked = await mkRoom(db, owner.id);
    await say(db, locked.id, talker.id, 6_000);
    const groupId = nanoid();
    await db.insert(schema.serverUsergroups).values({ id: groupId, serverId: subServerId, name: "Inner Circle" });
    await db.insert(schema.roomRoleGates).values({ roomId: locked.id, usergroupId: groupId, kind: "access" });

    // Archived room — never chosen.
    const parked = await mkRoom(db, owner.id, { archivedAt: new Date() });
    await say(db, parked.id, talker.id, 7_000);

    const pick = await findLiveliestLanding(db);
    assert.ok(pick, "a qualifying room was found");
    assert.equal(pick!.id, good.id);
  });

  test("system/whisper noise doesn't make a room 'lively'; recency orders qualifying rooms", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const talker = await createUser(db);

    const noisy = await mkRoom(db, owner.id);
    await say(db, noisy.id, talker.id, 1_000, "system");
    await say(db, noisy.id, talker.id, 2_000, "whisper");

    const older = await mkRoom(db, owner.id);
    await say(db, older.id, talker.id, 120_000);
    const fresher = await mkRoom(db, owner.id);
    await say(db, fresher.id, talker.id, 30_000);

    const pick = await findLiveliestLanding(db);
    assert.equal(pick?.id, fresher.id, "human recency wins; system/whisper lines don't count");
  });

  test("fallback path: no qualifying activity → null (caller degrades to the canonical landing)", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    // Rooms exist but nobody has spoken in 24h.
    await mkRoom(db, owner.id);
    const priv = await mkRoom(db, owner.id, { type: "private" });
    await say(db, priv.id, owner.id, 1_000); // gated activity only
    assert.equal(await findLiveliestLanding(db), null);
  });
});
