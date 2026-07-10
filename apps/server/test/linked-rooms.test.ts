import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { enableAdultChannel, disableAdultChannel } from "../src/lib/adultChannel.js";
import { findLinkedAnnex, isInPair } from "../src/lib/roomLinks.js";
import { setRoomNsfw } from "../src/lib/nsfwRooms.js";
import { buildRoomSummary } from "../src/realtime/broadcast.js";
import { createUser, makeTestDb } from "./helpers/harness.js";

/**
 * Per-room 18+ CHANNEL (migration 0343 + lib/adultChannel.ts): the hidden
 * companion feed behind a room's SFW/18+ toggle. Pinned here: the enable /
 * disable lifecycle (create, park-with-history, revive), the guard rails
 * (occupied channel, name collision, whole-room-18+ rooms), the wire
 * pointers buildRoomSummary derives, and the whole-room 18+ flag lock.
 */

type RoomRow = typeof schema.rooms.$inferSelect;

/** io stub whose channel room holds `occupants` fake sockets. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ioWithChannelSockets(channelRoomId: string, occupants: number): any {
  return {
    async fetchSockets() { return []; },
    in(band: string) {
      const n = band === `room:${channelRoomId}` ? occupants : 0;
      return { async fetchSockets() { return Array.from({ length: n }, () => ({})); }, emit() {} };
    },
    to() { return { emit() {} }; },
    emit() {},
  };
}

let n = 0;
async function mkRoom(
  db: Db,
  ownerId: string,
  opts: { isNsfw?: boolean; name?: string } = {},
): Promise<RoomRow> {
  const id = nanoid();
  const name = opts.name ?? `channel-room-${++n}`;
  await db.insert(schema.rooms).values({
    id,
    name,
    slug: name.toLowerCase(),
    type: "public",
    ownerId,
    isNsfw: opts.isNsfw ?? false,
  });
  return (await db.select().from(schema.rooms).where(eq(schema.rooms.id, id)).limit(1))[0]!;
}

async function refetch(db: Db, id: string): Promise<RoomRow | undefined> {
  return (await db.select().from(schema.rooms).where(eq(schema.rooms.id, id)).limit(1))[0];
}

describe("18+ channel lifecycle", () => {
  test("enable creates the hidden channel; disable parks it; re-enable revives the SAME feed", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const base = await mkRoom(db, owner.id);

    // The channel belongs to the ROOM's owner, mirrors the base, and is
    // flagged + linked.
    const on = await enableAdultChannel(db, base);
    assert.ok(on.ok && on.changed && on.channelRoomId);
    const channel = (await refetch(db, on.channelRoomId!))!;
    assert.equal(channel.name, `${base.name}_Adult`);
    assert.equal(channel.isNsfw, true);
    assert.equal(channel.linkedRoomId, base.id);
    assert.equal(channel.ownerId, owner.id);

    // Idempotent enable.
    const again = await enableAdultChannel(db, base);
    assert.ok(again.ok && !again.changed && again.channelRoomId === channel.id);

    // Disable parks the feed but KEEPS the link edge for revival.
    const off = await disableAdultChannel(db, ioWithChannelSockets(channel.id, 0), base);
    assert.ok(off.ok && off.changed);
    const parked = (await refetch(db, channel.id))!;
    assert.ok(parked.archivedAt);
    assert.equal(parked.linkedRoomId, base.id);
    // A parked channel is invisible to the wire lookup...
    assert.equal(await findLinkedAnnex(db, base.id), null);
    // ...and idempotent disable reports no change.
    const offAgain = await disableAdultChannel(db, ioWithChannelSockets(channel.id, 0), base);
    assert.ok(offAgain.ok && !offAgain.changed);

    // Re-enable revives the SAME room — history intact, no new row.
    const revive = await enableAdultChannel(db, base);
    assert.ok(revive.ok && revive.changed);
    assert.equal(revive.channelRoomId, channel.id);
    assert.equal((await refetch(db, channel.id))!.archivedAt, null);
  });

  test("disable refuses while people are inside the 18+ channel", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const base = await mkRoom(db, owner.id);
    const on = await enableAdultChannel(db, base);
    assert.ok(on.ok && on.channelRoomId);
    const busy = await disableAdultChannel(db, ioWithChannelSockets(on.channelRoomId!, 2), base);
    assert.deepEqual(busy, { ok: false, error: "CHANNEL_OCCUPIED" });
    assert.equal((await refetch(db, on.channelRoomId!))!.archivedAt, null);
  });

  test("SYSTEM rooms get channels too — the channel mirrors system-ness and the ownerless owner", async () => {
    // The seeded core rooms (the landing, Bazaar, …) are the rooms a
    // community most wants an adult side on; the channel is a core
    // age-gating surface, never a user-rooms-only perk.
    const { db } = makeTestDb();
    const id = nanoid();
    await db.insert(schema.rooms).values({
      id, name: "system-base", slug: "system-base", type: "public", isSystem: true, ownerId: null,
    });
    const base = (await refetch(db, id))!;
    const on = await enableAdultChannel(db, base);
    assert.ok(on.ok && on.changed && on.channelRoomId);
    const channel = (await refetch(db, on.channelRoomId!))!;
    assert.equal(channel.isSystem, true);
    assert.equal(channel.ownerId, null);
    assert.equal(channel.isNsfw, true);
    assert.equal(channel.linkedRoomId, base.id);
  });

  test("enable guard rails: whole-room 18+, name collision, over-long names", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);

    const nsfwRoom = await mkRoom(db, owner.id, { isNsfw: true });
    assert.deepEqual(await enableAdultChannel(db, nsfwRoom), { ok: false, error: "ROOM_IS_NSFW" });

    const base = await mkRoom(db, owner.id);
    await mkRoom(db, owner.id, { name: `${base.name}_Adult` }); // unrelated squatter
    assert.deepEqual(await enableAdultChannel(db, base), { ok: false, error: "NAME_TAKEN" });

    const long = await mkRoom(db, owner.id, { name: "x".repeat(35) });
    assert.deepEqual(await enableAdultChannel(db, long), { ok: false, error: "NAME_TOO_LONG" });
  });
});

describe("18+ channel wire pointers", () => {
  test("buildRoomSummary ships both directions; a parked channel vanishes from the wire", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const base = await mkRoom(db, owner.id);
    const on = await enableAdultChannel(db, base);
    assert.ok(on.ok && on.channelRoomId);

    const baseSummary = await buildRoomSummary(db, (await refetch(db, base.id))!);
    assert.equal(baseSummary.linkedNsfwRoomId, on.channelRoomId);
    assert.equal(baseSummary.linkedSfwRoomId, null);
    const channelSummary = await buildRoomSummary(db, (await refetch(db, on.channelRoomId!))!);
    assert.equal(channelSummary.linkedSfwRoomId, base.id);
    assert.equal(channelSummary.linkedNsfwRoomId, null);

    assert.ok((await disableAdultChannel(db, ioWithChannelSockets(on.channelRoomId!, 0), base)).ok);
    const afterPark = await buildRoomSummary(db, (await refetch(db, base.id))!);
    assert.equal(afterPark.linkedNsfwRoomId, null);
  });
});

describe("whole-room 18+ flag lock", () => {
  test("locks both sides of a LIVE channel pairing; a parked channel doesn't lock the base", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const base = await mkRoom(db, owner.id);
    const on = await enableAdultChannel(db, base);
    assert.ok(on.ok && on.channelRoomId);

    // Refusals fire before any io use, so a bare stub is safe.
    const io = undefined as never;
    const actor = { id: owner.id, isAdult: true, locale: null };
    const flipBase = await setRoomNsfw({ db, io, room: (await refetch(db, base.id))!, value: true, actor });
    assert.equal(flipBase.ok, false);
    assert.equal((flipBase as { code: string }).code, "LINKED_PAIR");
    const flipChannel = await setRoomNsfw({ db, io, room: (await refetch(db, on.channelRoomId!))!, value: false, actor });
    assert.equal(flipChannel.ok, false);
    assert.equal((flipChannel as { code: string }).code, "LINKED_PAIR");
    // isInPair sees live AND parked pairings (the flag lock narrows to live).
    assert.equal(await isInPair(db, (await refetch(db, base.id))!), true);

    // Park the channel: the base's whole-room flag unlocks (the inert edge
    // must not hold the room hostage); enabling later on an 18+ base then
    // refuses cleanly.
    assert.ok((await disableAdultChannel(db, ioWithChannelSockets(on.channelRoomId!, 0), base)).ok);
    const nowOk = await setRoomNsfw({
      db,
      io: ioWithChannelSockets("none", 0),
      room: (await refetch(db, base.id))!,
      value: true,
      actor,
    });
    assert.equal(nowOk.ok, true);
    assert.deepEqual(
      await enableAdultChannel(db, (await refetch(db, base.id))!),
      { ok: false, error: "ROOM_IS_NSFW" },
    );
  });
});
