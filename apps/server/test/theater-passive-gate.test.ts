import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import type { Role } from "@thekeep/shared";
import type { Db } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";
import { anyConnectedRoomController } from "../src/auth/roomPermissions.js";
import { applyControl, getTheater, setTheater, type TheaterState } from "../src/realtime/theaterState.js";
import { createUser, makeTestDb } from "./helpers/harness.js";

/**
 * Theater passive-control gate + playback state machine.
 *
 * The `theater:control` socket handler lets non-controllers send ONLY the
 * passive `ended`/`error` end-of-source reports, and only while no
 * controller-capable user (owner / room mod / site staff) is connected to
 * the room — when one is present their own player is the authoritative
 * reporter, and a crafted passive report was the one remaining way a plain
 * viewer could skip/restart the video for everyone. `anyConnectedRoomController`
 * is that presence check; `applyControl` is the pure state machine the
 * handler feeds. Both are covered here.
 */

let roomN = 0;
async function createRoom(db: Db, ownerId: string): Promise<string> {
  const id = nanoid();
  const n = ++roomN;
  await db.insert(schema.rooms).values({
    id,
    name: `theater-${n}`,
    slug: `theater-${n}`,
    type: "public",
    ownerId,
  });
  return id;
}

/** Socket.IO stand-in: a room whose sockets carry these handshake user
 *  snapshots (null = a socket with no snapshot at all). */
function fakeIo(socketUsers: Array<{ id: string; role: Role } | null>) {
  return {
    in: () => ({
      fetchSockets: async () => socketUsers.map((u) => ({ data: u ? { user: u } : {} })),
    }),
  };
}

describe("anyConnectedRoomController", () => {
  test("is false for an empty room and for plain viewers only", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const viewer = await createUser(db);
    const member = await createUser(db);
    const roomId = await createRoom(db, owner.id);
    await db.insert(schema.roomMembers).values({ roomId, userId: member.id, role: "member" });

    assert.equal(await anyConnectedRoomController(fakeIo([]), db, roomId), false);
    assert.equal(
      await anyConnectedRoomController(
        fakeIo([
          { id: viewer.id, role: viewer.role },
          { id: member.id, role: member.role },
        ]),
        db,
        roomId,
      ),
      false,
    );
  });

  test("sees the room owner, a promoted room mod, and a member-row owner", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const mod = await createUser(db);
    const coOwner = await createUser(db);
    const roomId = await createRoom(db, owner.id);
    await db.insert(schema.roomMembers).values([
      { roomId, userId: mod.id, role: "mod" },
      { roomId, userId: coOwner.id, role: "owner" },
    ]);

    assert.equal(await anyConnectedRoomController(fakeIo([{ id: owner.id, role: owner.role }]), db, roomId), true);
    assert.equal(await anyConnectedRoomController(fakeIo([{ id: mod.id, role: mod.role }]), db, roomId), true);
    assert.equal(await anyConnectedRoomController(fakeIo([{ id: coOwner.id, role: coOwner.role }]), db, roomId), true);
  });

  test("sees connected site staff even with no membership in the room", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const staff = await createUser(db, { role: "masteradmin" });
    const roomId = await createRoom(db, owner.id);

    assert.equal(await anyConnectedRoomController(fakeIo([{ id: staff.id, role: staff.role }]), db, roomId), true);
  });

  test("excludes the reporter and skips snapshot-less sockets", async () => {
    const { db } = makeTestDb();
    const owner = await createUser(db);
    const viewer = await createUser(db);
    const roomId = await createRoom(db, owner.id);

    // The excluded user's own controller status must not count as "someone
    // else is here" (the handler excludes the reporting socket's user).
    assert.equal(
      await anyConnectedRoomController(fakeIo([{ id: owner.id, role: owner.role }]), db, roomId, owner.id),
      false,
    );
    // A socket with no handshake snapshot is skipped, not treated as staff.
    assert.equal(
      await anyConnectedRoomController(fakeIo([null, { id: viewer.id, role: viewer.role }]), db, roomId),
      false,
    );
    // Multiple tabs of the same plain viewer still don't add up to control.
    assert.equal(
      await anyConnectedRoomController(
        fakeIo([
          { id: viewer.id, role: viewer.role },
          { id: viewer.id, role: viewer.role },
        ]),
        db,
        roomId,
      ),
      false,
    );
  });
});

describe("applyControl passive actions", () => {
  const t0 = 1_000_000;
  function seed(roomId: string, partial?: Partial<TheaterState>): void {
    setTheater(roomId, {
      index: 0,
      isPlaying: true,
      positionSec: 100,
      updatedAtMs: t0,
      lastIndexChangeAt: t0,
      errorSkips: 0,
      ...partial,
    });
  }

  test("ended advances, wraps under loop all, and stops on the last source under loop off", () => {
    const wrap = nanoid();
    seed(wrap, { index: 2 });
    const wrapped = applyControl(wrap, "ended", { index: 2, len: 3, loop: "all", now: t0 + 5000 });
    assert.equal(wrapped.index, 0);
    assert.equal(wrapped.positionSec, 0);
    assert.equal(wrapped.isPlaying, true);

    const mid = nanoid();
    seed(mid, { index: 0 });
    assert.equal(applyControl(mid, "ended", { index: 0, len: 3, loop: "off", now: t0 + 5000 }).index, 1);

    const last = nanoid();
    seed(last, { index: 2 });
    const stopped = applyControl(last, "ended", { index: 2, len: 3, loop: "off", now: t0 + 5000 });
    assert.equal(stopped.index, 2);
    assert.equal(stopped.isPlaying, false);
  });

  test("loop one restarts the same source from zero", () => {
    const roomId = nanoid();
    seed(roomId, { index: 1 });
    const st = applyControl(roomId, "ended", { index: 1, len: 3, loop: "one", now: t0 + 5000 });
    assert.equal(st.index, 1);
    assert.equal(st.positionSec, 0);
    assert.equal(st.isPlaying, true);
  });

  test("ignores an ended for a stale index and debounces rapid duplicates", () => {
    const roomId = nanoid();
    seed(roomId, { index: 1 });
    const stale = applyControl(roomId, "ended", { index: 0, len: 3, loop: "all", now: t0 + 5000 });
    assert.equal(stale.index, 1);
    assert.equal(stale.positionSec, 100);

    const first = applyControl(roomId, "ended", { index: 1, len: 3, loop: "all", now: t0 + 5000 });
    assert.equal(first.index, 2);
    // A second report right behind it (well inside the 2s debounce of the
    // index change above) must not advance again.
    const dup = applyControl(roomId, "ended", { index: 2, len: 3, loop: "all", now: t0 + 5500 });
    assert.equal(dup.index, 2);
  });

  test("error skips forward and a fully dead playlist stops instead of hot-looping", () => {
    const roomId = nanoid();
    seed(roomId, { index: 0 });
    const skipped = applyControl(roomId, "error", { index: 0, len: 2, loop: "all", now: t0 + 5000 });
    assert.equal(skipped.index, 1);
    assert.equal(skipped.errorSkips, 1);
    const dead = applyControl(roomId, "error", { index: 1, len: 2, loop: "all", now: t0 + 10_000 });
    assert.equal(dead.isPlaying, false);
    assert.equal(dead.errorSkips, 0);
  });

  test("progress re-anchors small corrections and rejects far-off or stale reports", () => {
    const roomId = nanoid();
    seed(roomId);
    // 10s of wall clock elapsed → expected ≈ 110. A report 15s behind is a
    // buffering controller: accept.
    const nudged = applyControl(roomId, "progress", { index: 0, positionSec: 95, len: 3, loop: "off", now: t0 + 10_000 });
    assert.equal(nudged.positionSec, 95);
    assert.equal(nudged.updatedAtMs, t0 + 10_000);

    // A report far off the live timeline (a just-joined session at 0) must
    // not yank the room.
    seed(roomId);
    applyControl(roomId, "progress", { index: 0, positionSec: 0, len: 3, loop: "off", now: t0 + 10_000 });
    assert.equal(getTheater(roomId)?.positionSec, 100);

    // A stale-index report is ignored outright.
    seed(roomId, { index: 2 });
    applyControl(roomId, "progress", { index: 0, positionSec: 95, len: 3, loop: "off", now: t0 + 10_000 });
    assert.equal(getTheater(roomId)?.positionSec, 100);
  });
});
