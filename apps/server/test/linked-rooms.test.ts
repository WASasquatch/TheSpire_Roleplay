import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { findLinkedAnnex, isInPair, linkRoomPair, unlinkRoomPair } from "../src/lib/roomLinks.js";
import { setRoomNsfw } from "../src/lib/nsfwRooms.js";
import { buildRoomSummary } from "../src/realtime/broadcast.js";
import { registerRoomsRoutes } from "../src/routes/rooms.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/** Just enough socket.io surface for the link routes' side effects
 *  (setRoomNsfw eviction sweep, broadcasts, tree pulses) over an empty
 *  room population. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeIo: any = {
  async fetchSockets() { return []; },
  in() { return { async fetchSockets() { return []; }, emit() {} }; },
  to() { return { emit() {} }; },
  emit() {},
};

/**
 * Linked SFW/18+ room pairs (migration 0343): the shape rules in
 * lib/roomLinks.ts and the wire pointers buildRoomSummary derives from the
 * stored annex→base edge. The command layer on top only adds permission
 * checks + notices; the rules pinned here are what keep a pair sane
 * (one 18+ side, same server, both public, no chains, no double links).
 */

type RoomRow = typeof schema.rooms.$inferSelect;

let n = 0;
async function mkRoom(
  db: Db,
  ownerId: string,
  opts: { isNsfw?: boolean; archived?: boolean; type?: "public" | "private" } = {},
): Promise<RoomRow> {
  const id = nanoid();
  const name = `pair-room-${++n}`;
  await db.insert(schema.rooms).values({
    id,
    name,
    slug: name,
    type: opts.type ?? "public",
    ownerId,
    isNsfw: opts.isNsfw ?? false,
    ...(opts.archived ? { archivedAt: new Date() } : {}),
  });
  return (await db.select().from(schema.rooms).where(eq(schema.rooms.id, id)).limit(1))[0]!;
}

describe("linkRoomPair shape rules", () => {
  test("refuses malformed pairs with the precise error", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const sfw = await mkRoom(db, owner.id);
    const nsfw = await mkRoom(db, owner.id, { isNsfw: true });

    assert.deepEqual(await linkRoomPair(db, sfw, sfw), { ok: false, error: "SELF" });
    assert.deepEqual(
      await linkRoomPair(db, { ...sfw, forumId: "f1" }, nsfw),
      { ok: false, error: "FORUM_BOARD" },
    );
    assert.deepEqual(
      await linkRoomPair(db, sfw, { ...nsfw, isSystem: true }),
      { ok: false, error: "SYSTEM" },
    );
    assert.deepEqual(
      await linkRoomPair(db, sfw, { ...nsfw, archivedAt: new Date() }),
      { ok: false, error: "ARCHIVED" },
    );
    assert.deepEqual(
      await linkRoomPair(db, sfw, { ...nsfw, serverId: "other-server" }),
      { ok: false, error: "DIFFERENT_SERVER" },
    );
    assert.deepEqual(
      await linkRoomPair(db, sfw, { ...nsfw, type: "private" }),
      { ok: false, error: "NOT_PUBLIC" },
    );
    // Both SFW / both 18+ → no way to tell base from annex.
    const sfw2 = await mkRoom(db, owner.id);
    assert.deepEqual(await linkRoomPair(db, sfw, sfw2), { ok: false, error: "NEED_ONE_NSFW" });
    assert.deepEqual(
      await linkRoomPair(db, { ...sfw, isNsfw: true }, nsfw),
      { ok: false, error: "NEED_ONE_NSFW" },
    );
  });

  test("links a valid pair (either argument order) and blocks double-links", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const sfw = await mkRoom(db, owner.id);
    const nsfw = await mkRoom(db, owner.id, { isNsfw: true });

    // 18+ side passed FIRST still resolves to annex=nsfw, base=sfw.
    const linked = await linkRoomPair(db, nsfw, sfw);
    assert.ok(linked.ok);
    assert.equal(linked.base.id, sfw.id);
    assert.equal(linked.annex.id, nsfw.id);

    const annex = await findLinkedAnnex(db, sfw.id);
    assert.equal(annex?.id, nsfw.id);
    assert.equal(await isInPair(db, (await refetch(db, sfw.id))!), true);
    assert.equal(await isInPair(db, (await refetch(db, nsfw.id))!), true);

    // Neither side can join a second pair.
    const third = await mkRoom(db, owner.id, { isNsfw: true });
    assert.deepEqual(
      await linkRoomPair(db, (await refetch(db, sfw.id))!, third),
      { ok: false, error: "ALREADY_LINKED" },
    );
    const sfw3 = await mkRoom(db, owner.id);
    assert.deepEqual(
      await linkRoomPair(db, sfw3, (await refetch(db, nsfw.id))!),
      { ok: false, error: "ALREADY_LINKED" },
    );
  });

  test("unlinks from either side; unlinking an unpaired room is a no-op", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const lone = await mkRoom(db, owner.id);
    assert.equal(await unlinkRoomPair(db, lone), null);

    const sfw = await mkRoom(db, owner.id);
    const nsfw = await mkRoom(db, owner.id, { isNsfw: true });
    assert.ok((await linkRoomPair(db, sfw, nsfw)).ok);

    // From the annex side.
    const fromAnnex = await unlinkRoomPair(db, (await refetch(db, nsfw.id))!);
    assert.deepEqual(fromAnnex, { baseId: sfw.id, annexId: nsfw.id });
    assert.equal((await refetch(db, nsfw.id))!.linkedRoomId, null);

    // Re-link, then from the base side.
    assert.ok((await linkRoomPair(db, (await refetch(db, sfw.id))!, (await refetch(db, nsfw.id))!)).ok);
    const fromBase = await unlinkRoomPair(db, (await refetch(db, sfw.id))!);
    assert.deepEqual(fromBase, { baseId: sfw.id, annexId: nsfw.id });
    assert.equal((await refetch(db, nsfw.id))!.linkedRoomId, null);
  });
});

describe("linked-pair 18+ flag lock", () => {
  test("setRoomNsfw refuses flips on either side of a live pair", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const sfw = await mkRoom(db, owner.id);
    const nsfw = await mkRoom(db, owner.id, { isNsfw: true });
    assert.ok((await linkRoomPair(db, sfw, nsfw)).ok);

    // The flags ARE the pair's structure (which side hides behind the
    // toggle); both refusals fire before any io use, so a bare stub is safe.
    const io = undefined as never;
    const actor = { id: owner.id, isAdult: true, locale: null };
    const offAnnex = await setRoomNsfw({ db, io, room: (await refetch(db, nsfw.id))!, value: false, actor });
    assert.equal(offAnnex.ok, false);
    assert.equal((offAnnex as { code: string }).code, "LINKED_PAIR");
    const onBase = await setRoomNsfw({ db, io, room: (await refetch(db, sfw.id))!, value: true, actor });
    assert.equal(onBase.ok, false);
    assert.equal((onBase as { code: string }).code, "LINKED_PAIR");
  });
});

describe("linked-pair wire pointers", () => {
  test("buildRoomSummary ships both directions, and drops a parked annex", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const sfw = await mkRoom(db, owner.id);
    const nsfw = await mkRoom(db, owner.id, { isNsfw: true });
    assert.ok((await linkRoomPair(db, sfw, nsfw)).ok);

    const baseSummary = await buildRoomSummary(db, (await refetch(db, sfw.id))!);
    assert.equal(baseSummary.linkedNsfwRoomId, nsfw.id);
    assert.equal(baseSummary.linkedSfwRoomId, null);

    const annexSummary = await buildRoomSummary(db, (await refetch(db, nsfw.id))!);
    assert.equal(annexSummary.linkedSfwRoomId, sfw.id);
    assert.equal(annexSummary.linkedNsfwRoomId, null);

    // Parked (archived) annex: the base stops advertising a toggle target.
    await db.update(schema.rooms).set({ archivedAt: new Date() }).where(eq(schema.rooms.id, nsfw.id));
    const afterPark = await buildRoomSummary(db, (await refetch(db, sfw.id))!);
    assert.equal(afterPark.linkedNsfwRoomId, null);
  });
});

async function refetch(db: Db, id: string): Promise<RoomRow | undefined> {
  return (await db.select().from(schema.rooms).where(eq(schema.rooms.id, id)).limit(1))[0];
}

describe("POST /rooms/link + /rooms/unlink (Room Builder pathway)", () => {
  test("owner links existing rooms, auto-flagging the unflagged 18+ side; strangers are refused", async () => {
    const { db } = makeTestDb();
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof ZodError) { reply.code(400); return reply.send({ error: "validation" }); }
      throw err;
    });
    await registerRoomsRoutes(app, db, fakeIo);
    await app.ready();

    const owner = await createUser(db, { birthdate: "1990-01-01" });
    const stranger = await createUser(db, { birthdate: "1990-01-01" });
    const ownerTok = await tokenFor(db, owner.id);
    const strangerTok = await tokenFor(db, stranger.id);
    // The prod shape this pathway exists for: two plain public rooms that
    // already exist, NEITHER flagged yet (owners never ran /nsfw).
    const base = await mkRoom(db, owner.id);
    const adultRoom = await mkRoom(db, owner.id);

    // A stranger with no edit rights on the rooms is refused.
    const denied = await app.inject({
      method: "POST",
      url: "/rooms/link",
      headers: auth(strangerTok),
      payload: { sfwRoomId: base.id, nsfwRoomId: adultRoom.id },
    });
    assert.equal(denied.statusCode, 403);

    // The owner links; the chosen 18+ side gets flagged as part of linking.
    const ok = await app.inject({
      method: "POST",
      url: "/rooms/link",
      headers: auth(ownerTok),
      payload: { sfwRoomId: base.id, nsfwRoomId: adultRoom.id },
    });
    assert.equal(ok.statusCode, 200);
    const annexRow = (await refetch(db, adultRoom.id))!;
    assert.equal(annexRow.isNsfw, true);
    assert.equal(annexRow.linkedRoomId, base.id);

    // Double-link refused.
    const third = await mkRoom(db, owner.id, { isNsfw: true });
    const dup = await app.inject({
      method: "POST",
      url: "/rooms/link",
      headers: auth(ownerTok),
      payload: { sfwRoomId: base.id, nsfwRoomId: third.id },
    });
    assert.equal(dup.statusCode, 400);

    // Unlink from the Builder; a second unlink reports "not linked".
    const un = await app.inject({
      method: "POST",
      url: "/rooms/unlink",
      headers: auth(ownerTok),
      payload: { roomId: base.id },
    });
    assert.equal(un.statusCode, 200);
    assert.equal((await refetch(db, adultRoom.id))!.linkedRoomId, null);
    const unAgain = await app.inject({
      method: "POST",
      url: "/rooms/unlink",
      headers: auth(ownerTok),
      payload: { roomId: base.id },
    });
    assert.equal(unAgain.statusCode, 400);

    await app.close();
  });

  test("refuses when the picked SFW side is itself flagged 18+", async () => {
    const { db } = makeTestDb();
    const app = Fastify();
    await registerRoomsRoutes(app, db, fakeIo);
    await app.ready();
    const owner = await createUser(db, { birthdate: "1990-01-01" });
    const tok = await tokenFor(db, owner.id);
    const flagged = await mkRoom(db, owner.id, { isNsfw: true });
    const other = await mkRoom(db, owner.id);
    const r = await app.inject({
      method: "POST",
      url: "/rooms/link",
      headers: auth(tok),
      payload: { sfwRoomId: flagged.id, nsfwRoomId: other.id },
    });
    assert.equal(r.statusCode, 400);
    await app.close();
  });
});
