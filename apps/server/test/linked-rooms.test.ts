import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { findLinkedAnnex, isInPair, linkRoomPair, unlinkRoomPair } from "../src/lib/roomLinks.js";
import { setRoomNsfw } from "../src/lib/nsfwRooms.js";
import { buildRoomSummary } from "../src/realtime/broadcast.js";
import { createUser, makeTestDb } from "./helpers/harness.js";

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
