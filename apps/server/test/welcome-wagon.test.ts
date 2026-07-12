import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { maybeFireFirstWords } from "../src/realtime/welcomeWagon.js";
import { createUser, makeTestDb } from "./helpers/harness.js";

/**
 * Welcome wagon (migration 0353): the one-time "X just said their first
 * words" bell notification. Pinned here: single-fire semantics (the atomic
 * first_spoke_at claim), recipient scoping (online, same server, never the
 * newcomer), and the exclusions — blocked pairs, isolated minor↔adult
 * pairings, private rooms, role-locked rooms, non-speech kinds.
 */

const SYSTEM_SERVER = "server_spire_system";
const ADULT_DOB = "1990-01-01";
const MINOR_DOB = "2012-01-01";

type RoomRow = typeof schema.rooms.$inferSelect;

let n = 0;
async function mkRoom(
  db: Db,
  ownerId: string,
  opts: Partial<{ type: "public" | "private"; replyMode: "flat" | "nested" }> = {},
): Promise<RoomRow> {
  const id = nanoid();
  await db.insert(schema.rooms).values({
    id,
    name: `wagon-room-${++n}`,
    type: opts.type ?? "public",
    ownerId,
    replyMode: opts.replyMode ?? "flat",
  });
  return (await db.select().from(schema.rooms).where(eq(schema.rooms.id, id)).limit(1))[0]!;
}

/** io stub: `online` = [{userId, serverId?}] fake live sockets. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeIo(online: Array<{ userId: string; serverId?: string }>): any {
  const socks = online.map((o) => ({
    data: { userId: o.userId, serverId: o.serverId ?? SYSTEM_SERVER, roomId: "somewhere" },
    emit() {},
  }));
  return {
    async fetchSockets() { return socks; },
    in() { return { async fetchSockets() { return []; }, emit() {} }; },
    to() { return { emit() {} }; },
    emit() {},
  };
}

async function firstWordsRowsFor(db: Db, userId: string) {
  const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
  return rows.filter((r) => r.kind === "first_words");
}

describe("welcome wagon (maybeFireFirstWords)", () => {
  test("first public message notifies online same-server members once — and only once, ever", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const newbie = await createUser(db);
    const friendly = await createUser(db);
    const elsewhere = await createUser(db);
    const room = await mkRoom(db, owner.id);

    const io = fakeIo([
      { userId: newbie.id },
      { userId: friendly.id },
      { userId: elsewhere.id, serverId: "server_other" },
    ]);
    await maybeFireFirstWords(io, db, { id: newbie.id }, room.id, "say", newbie.username);

    const rows = await firstWordsRowsFor(db, friendly.id);
    assert.equal(rows.length, 1, "online same-server member got the ping");
    assert.match(rows[0]!.title, /just said their first words/);
    assert.match(rows[0]!.title, new RegExp(room.name));
    assert.equal(rows[0]!.targetKind, "room");
    assert.equal(rows[0]!.targetId, room.id, "deep-links to the room");
    assert.equal(rows[0]!.actorUserId, newbie.id);

    assert.equal((await firstWordsRowsFor(db, newbie.id)).length, 0, "the newcomer is never pinged");
    assert.equal((await firstWordsRowsFor(db, elsewhere.id)).length, 0, "other-server viewers are not pinged");

    const u = (await db.select().from(schema.users).where(eq(schema.users.id, newbie.id)).limit(1))[0]!;
    assert.ok(u.firstSpokeAt, "first_spoke_at claimed");

    // A second (and third) message never re-fires.
    await maybeFireFirstWords(io, db, { id: newbie.id }, room.id, "say", newbie.username);
    await maybeFireFirstWords(io, db, { id: newbie.id }, room.id, "me", newbie.username);
    assert.equal((await firstWordsRowsFor(db, friendly.id)).length, 1, "single-fire, forever");
  });

  test("blocked pairs are excluded in both directions", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const newbie = await createUser(db);
    const blocker = await createUser(db); // blocked the newcomer
    const blocked = await createUser(db); // the newcomer blocked them
    const neutral = await createUser(db);
    await db.insert(schema.blocks).values({ blockerUserId: blocker.id, blockedUserId: newbie.id });
    await db.insert(schema.blocks).values({ blockerUserId: newbie.id, blockedUserId: blocked.id });
    const room = await mkRoom(db, owner.id);

    const io = fakeIo([{ userId: blocker.id }, { userId: blocked.id }, { userId: neutral.id }]);
    await maybeFireFirstWords(io, db, { id: newbie.id }, room.id, "say", newbie.username);

    assert.equal((await firstWordsRowsFor(db, neutral.id)).length, 1);
    assert.equal((await firstWordsRowsFor(db, blocker.id)).length, 0, "someone who blocked the newcomer hears nothing");
    assert.equal((await firstWordsRowsFor(db, blocked.id)).length, 0, "someone the newcomer blocked hears nothing");
  });

  test("isolated minor ↔ adult pairings are excluded", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db, { birthdate: ADULT_DOB });
    const minor = await createUser(db, { birthdate: MINOR_DOB, isolateFromAdults: true });
    const adult = await createUser(db, { birthdate: ADULT_DOB });
    const peer = await createUser(db, { birthdate: MINOR_DOB });
    const room = await mkRoom(db, owner.id);

    const io = fakeIo([{ userId: adult.id }, { userId: peer.id }]);
    await maybeFireFirstWords(io, db, { id: minor.id }, room.id, "say", minor.username);

    assert.equal((await firstWordsRowsFor(db, adult.id)).length, 0, "isolated minor never surfaces to an adult");
    assert.equal((await firstWordsRowsFor(db, peer.id)).length, 1, "fellow minor still gets the ping");
  });

  test("private rooms: silent, but the once-ever claim is still consumed", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const newbie = await createUser(db);
    const listener = await createUser(db);
    const priv = await mkRoom(db, owner.id, { type: "private" });
    const pub = await mkRoom(db, owner.id);

    const io = fakeIo([{ userId: listener.id }]);
    await maybeFireFirstWords(io, db, { id: newbie.id }, priv.id, "say", newbie.username);
    assert.equal((await firstWordsRowsFor(db, listener.id)).length, 0, "a private room never announces");

    // Their next PUBLIC message is no longer "first words" — stays silent.
    await maybeFireFirstWords(io, db, { id: newbie.id }, pub.id, "say", newbie.username);
    assert.equal((await firstWordsRowsFor(db, listener.id)).length, 0);
  });

  test("role-locked rooms and non-speech kinds never announce", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const newbieA = await createUser(db);
    const newbieB = await createUser(db);
    const listener = await createUser(db);
    const locked = await mkRoom(db, owner.id);
    // The usergroup needs a live server row to hang off (fresh test DBs have
    // no seeded system server); the gate row is what locks the room.
    const serverId = nanoid();
    await db.insert(schema.servers).values({ id: serverId, slug: "gate-home", name: "Gate Home", ownerUserId: owner.id, joinMode: "open" });
    const groupId = nanoid();
    await db.insert(schema.serverUsergroups).values({ id: groupId, serverId, name: "Gated" });
    await db.insert(schema.roomRoleGates).values({ roomId: locked.id, usergroupId: groupId, kind: "access" });
    const pub = await mkRoom(db, owner.id);

    const io = fakeIo([{ userId: listener.id }]);
    await maybeFireFirstWords(io, db, { id: newbieA.id }, locked.id, "say", newbieA.username);
    assert.equal((await firstWordsRowsFor(db, listener.id)).length, 0, "role-locked rooms never announce");

    // Non-speech kinds don't count as speaking at all: the claim survives
    // and the later real message still fires.
    await maybeFireFirstWords(io, db, { id: newbieB.id }, pub.id, "system", newbieB.username);
    await maybeFireFirstWords(io, db, { id: newbieB.id }, pub.id, "poll", newbieB.username);
    let u = (await db.select().from(schema.users).where(eq(schema.users.id, newbieB.id)).limit(1))[0]!;
    assert.equal(u.firstSpokeAt, null, "non-speech kinds never claim first words");
    await maybeFireFirstWords(io, db, { id: newbieB.id }, pub.id, "say", newbieB.username);
    assert.equal((await firstWordsRowsFor(db, listener.id)).length, 1);
    u = (await db.select().from(schema.users).where(eq(schema.users.id, newbieB.id)).limit(1))[0]!;
    assert.ok(u.firstSpokeAt);
  });

  test("effectively 18+ rooms never announce (own flag or server flag)", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const newbieA = await createUser(db);
    const newbieB = await createUser(db);
    const listener = await createUser(db);

    // Room's own 18+ flag: the fan-out reaches every online socket on the
    // server (minors included) with the room name in the title, so the gate
    // has to hold at fan-out time.
    const nsfwRoom = await mkRoom(db, owner.id);
    await db.update(schema.rooms).set({ isNsfw: true }).where(eq(schema.rooms.id, nsfwRoom.id));
    const io = fakeIo([{ userId: listener.id }]);
    await maybeFireFirstWords(io, db, { id: newbieA.id }, nsfwRoom.id, "say", newbieA.username);
    assert.equal((await firstWordsRowsFor(db, listener.id)).length, 0, "an 18+ room never announces");

    // SFW room inside an 18+ server: the EFFECTIVE rating (server OR room)
    // is what gates.
    const serverId = nanoid();
    await db.insert(schema.servers).values({ id: serverId, slug: "adult-home", name: "Adult Home", ownerUserId: owner.id, joinMode: "open", isNsfw: true });
    const annex = await mkRoom(db, owner.id);
    await db.update(schema.rooms).set({ serverId }).where(eq(schema.rooms.id, annex.id));
    const io2 = fakeIo([{ userId: listener.id, serverId }]);
    await maybeFireFirstWords(io2, db, { id: newbieB.id }, annex.id, "say", newbieB.username);
    assert.equal((await firstWordsRowsFor(db, listener.id)).length, 0, "a room inside an 18+ server never announces");
  });
});
