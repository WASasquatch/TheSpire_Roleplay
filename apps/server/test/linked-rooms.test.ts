import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { ChatMessage } from "@thekeep/shared";
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

/* =========================================================
 *  Staff pair oversight — merged two-channel feeds
 *  (lib/pairStaffView.ts + sendRoomBacklogTo + emitToPairStaff)
 * ========================================================= */

import { canSeePairFeeds, emitToPairStaff, findPairSibling } from "../src/lib/pairStaffView.js";
import { sendRoomBacklogTo } from "../src/realtime/broadcast.js";
import { DEFAULT_SERVER_ID } from "../src/earning/pool.js";

const MINOR_BD = new Date(Date.now() - 15 * 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10);

async function seedMsg(db: Db, roomId: string, userId: string, body: string): Promise<void> {
  await db.insert(schema.messages).values({
    id: nanoid(), roomId, userId, characterId: null,
    displayName: "author", kind: "say", body,
  });
}

function backlogSocket() {
  const emitted: { event: string; payload: unknown }[] = [];
  return {
    emitted,
    emit(event: string, payload: unknown) { emitted.push({ event, payload }); },
  };
}

async function ensurePairServerRows(db: Db, staffId?: string) {
  // The system server row is seeded at BOOT (ensureSystemServer), not by
  // migrations, so a bare harness DB needs it before serverMembers rows
  // can reference it. Owner = a throwaway user.
  const sysOwner = await createUser(db);
  await db.insert(schema.servers)
    .values({ id: DEFAULT_SERVER_ID, slug: "the-spire", name: "The Spire", ownerUserId: sysOwner.id, isSystem: true, isDefault: true })
    .onConflictDoNothing();
  if (staffId) {
    await db.insert(schema.serverMembers)
      .values({ serverId: DEFAULT_SERVER_ID, userId: staffId, role: "mod" })
      .onConflictDoNothing();
  }
}

describe("staff pair oversight — merged feeds", () => {
  test("findPairSibling resolves both directions; parked pair resolves to null", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const base = await mkRoom(db, owner.id);
    const on = await enableAdultChannel(db, base);
    assert.ok(on.ok && on.channelRoomId);
    const fromBase = await findPairSibling(db, base.id);
    assert.equal(fromBase?.siblingId, on.channelRoomId);
    assert.equal(fromBase?.annexId, on.channelRoomId);
    const fromAnnex = await findPairSibling(db, on.channelRoomId!);
    assert.equal(fromAnnex?.siblingId, base.id);
    assert.equal(fromAnnex?.annexId, on.channelRoomId);
    await disableAdultChannel(db, ioWithChannelSockets(on.channelRoomId!, 0), (await refetch(db, base.id))!);
    assert.equal(await findPairSibling(db, base.id), null);
  });

  test("qualification: adult site/server staff only — never minors, never plain members", async () => {
    const { db } = makeTestDb();
    const siteMod = await createUser(db, { role: "mod" });
    const plainAdult = await createUser(db);
    const minorSiteAdmin = await createUser(db, { role: "admin", birthdate: MINOR_BD });
    const serverStaffAdult = await createUser(db);
    await ensurePairServerRows(db, serverStaffAdult.id);
    assert.equal(await canSeePairFeeds(db, { id: siteMod.id, role: "mod", isAdult: true }, DEFAULT_SERVER_ID), true);
    assert.equal(await canSeePairFeeds(db, { id: plainAdult.id, role: "user", isAdult: true }, DEFAULT_SERVER_ID), false);
    assert.equal(await canSeePairFeeds(db, { id: minorSiteAdmin.id, role: "admin", isAdult: false }, DEFAULT_SERVER_ID), false);
    assert.equal(await canSeePairFeeds(db, { id: serverStaffAdult.id, role: "user", isAdult: true }, DEFAULT_SERVER_ID), true);
  });

  test("backlog: staff joining either side gets BOTH channels' rows; plain adults and minors get one side", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const siteAdmin = await createUser(db, { role: "admin" });
    const plainAdult = await createUser(db);
    const minor = await createUser(db, { birthdate: MINOR_BD });
    const base = await mkRoom(db, owner.id);
    const on = await enableAdultChannel(db, base);
    assert.ok(on.ok && on.channelRoomId);
    const annexId = on.channelRoomId!;
    await seedMsg(db, base.id, owner.id, "sfw side line");
    await seedMsg(db, annexId, owner.id, "adult side line");

    async function backlogFor(viewerId: string, joinRoomId: string): Promise<ChatMessage[]> {
      const sock = backlogSocket();
      await sendRoomBacklogTo(sock as never, db, joinRoomId, viewerId);
      const bulk = sock.emitted.find((e) => e.event === "message:bulk");
      return (bulk?.payload as ChatMessage[]) ?? [];
    }

    // Site staff in the SFW side sees both feeds (annex rows keep their id).
    const staffRows = await backlogFor(siteAdmin.id, base.id);
    assert.ok(staffRows.some((m) => m.body === "sfw side line"));
    assert.ok(staffRows.some((m) => m.body === "adult side line" && m.roomId === annexId));
    // ...and standing in the 18+ side sees the SFW rows too.
    const staffRowsAnnex = await backlogFor(siteAdmin.id, annexId);
    assert.ok(staffRowsAnnex.some((m) => m.body === "sfw side line" && m.roomId === base.id));
    // A plain adult member sees only the side they joined.
    const plainRows = await backlogFor(plainAdult.id, base.id);
    assert.ok(plainRows.some((m) => m.body === "sfw side line"));
    assert.ok(!plainRows.some((m) => m.body === "adult side line"));
    // A minor in the base gets the base only (belt + braces: the annex is
    // join-blocked for them anyway).
    const minorRows = await backlogFor(minor.id, base.id);
    assert.ok(minorRows.some((m) => m.body === "sfw side line"));
    assert.ok(!minorRows.some((m) => m.body === "adult side line"));
  });

  test("live mirror: only adult staff sockets in the sibling room receive the event", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const siteMod = await createUser(db, { role: "mod" });
    const serverStaff = await createUser(db);
    const plainAdult = await createUser(db);
    const minorAdmin = await createUser(db, { role: "admin", birthdate: MINOR_BD });
    await ensurePairServerRows(db, serverStaff.id);
    const base = await mkRoom(db, owner.id);
    const on = await enableAdultChannel(db, base);
    assert.ok(on.ok && on.channelRoomId);
    const annexId = on.channelRoomId!;

    function staffSock(user: { id: string; role: string }, isAdult: boolean) {
      const emitted: string[] = [];
      // Mirror the REAL session snapshot shape (commands/types.ts): the
      // isolation guard reads birthdate (null = legacy adult) and
      // isolateFromAdults off socket.data.user.
      return {
        data: {
          userId: user.id,
          user: { id: user.id, role: user.role, isAdult, birthdate: isAdult ? null : MINOR_BD, isolateFromAdults: false },
        },
        emit(event: string) { emitted.push(event); },
        emitted,
      };
    }
    const sMod = staffSock(siteMod, true);
    const sServerStaff = staffSock(serverStaff, true);
    const sPlain = staffSock(plainAdult, true);
    const sMinorAdmin = staffSock(minorAdmin, false);
    const io = {
      in(band: string) {
        return {
          async fetchSockets() {
            return band === `room:${base.id}` ? [sMod, sServerStaff, sPlain, sMinorAdmin] : [];
          },
        };
      },
    };
    // A line lands in the ANNEX; staff standing in the BASE get the mirror.
    await emitToPairStaff(io as never, db, annexId, (s) => s.emit("message:new"));
    assert.deepEqual(sMod.emitted, ["message:new"]);
    assert.deepEqual(sServerStaff.emitted, ["message:new"]);
    assert.deepEqual(sPlain.emitted, []);
    assert.deepEqual(sMinorAdmin.emitted, []);
    // The sender's hide-set suppresses the mirror for that staffer too.
    await emitToPairStaff(io as never, db, annexId, (s) => s.emit("message:new"), new Set([siteMod.id]));
    assert.deepEqual(sMod.emitted, ["message:new"]);
    assert.equal(sServerStaff.emitted.length, 2);
    // Phase-5 isolation: an actively-isolated minor's line must NOT mirror
    // to adult SERVER staff (site role "user" — not isolation-exempt),
    // while site staff (exempt by design) still receive it.
    const isolatedMinorSender = {
      id: owner.id,
      role: "user" as const,
      birthdate: MINOR_BD,
      isolateFromAdults: true,
    };
    await emitToPairStaff(io as never, db, annexId, (s) => s.emit("message:new"), undefined, isolatedMinorSender);
    assert.equal(sMod.emitted.length, 2, "site staff stay exempt from isolation");
    assert.equal(sServerStaff.emitted.length, 2, "isolated minor's line must not reach adult server staff");
  });
});
