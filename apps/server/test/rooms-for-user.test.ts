import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { roomsForUser } from "../src/realtime/broadcast.js";

/**
 * Characterization test for the consolidated `roomsForUser` helper
 * (apps/server/src/realtime/broadcast.ts, finding M3), extracted from the
 * verbatim "walk the user's sockets, collect every `room:` they're joined to,
 * dedupe across tabs" copies in routes/worlds.ts, commands/builtins/world.ts,
 * commands/builtins/incognito.ts (seeded), and the two fused broadcast.ts loops.
 *
 * Pins:
 *  - one pass, match by `socket.data.userId`;
 *  - only `room:`-prefixed socket.io rooms count (the socket's own id room and
 *    any other namespace are ignored);
 *  - deduped across tabs;
 *  - `seedRoomId` (incognito's `ctx.roomId`) is included even with no live
 *    socket in it, and lands FIRST in insertion order;
 *  - other users' rooms are never leaked in.
 */

type FakeSocket = { data: { userId?: string }; rooms: Set<string> };

function fakeIo(sockets: FakeSocket[]): Parameters<typeof roomsForUser>[0] {
  return { fetchSockets: async () => sockets } as unknown as Parameters<typeof roomsForUser>[0];
}

function sock(userId: string | undefined, rooms: string[]): FakeSocket {
  return { data: userId === undefined ? {} : { userId }, rooms: new Set(rooms) };
}

describe("roomsForUser", () => {
  test("collects only room:-prefixed rooms for the target user, deduped", async () => {
    const io = fakeIo([
      sock("u1", ["sock-id-abc", "room:r1", "room:r2"]),
      sock("u1", ["sock-id-def", "room:r2"]), // r2 repeated across tabs
      sock("u2", ["room:r9"]), // other user ignored
    ]);
    assert.deepEqual(await roomsForUser(io, "u1"), ["r1", "r2"]);
  });

  test("no seed and no sockets => empty", async () => {
    assert.deepEqual(await roomsForUser(fakeIo([]), "u1"), []);
  });

  test("sockets with no userId are skipped", async () => {
    const io = fakeIo([sock(undefined, ["room:r1"]), sock("u1", ["room:r2"])]);
    assert.deepEqual(await roomsForUser(io, "u1"), ["r2"]);
  });

  test("seedRoomId is included first even with no socket in it", async () => {
    const io = fakeIo([sock("u1", ["room:r1"])]);
    assert.deepEqual(await roomsForUser(io, "u1", "seed"), ["seed", "r1"]);
  });

  test("seedRoomId already occupied is not duplicated and stays first", async () => {
    const io = fakeIo([sock("u1", ["room:r1", "room:seed"])]);
    assert.deepEqual(await roomsForUser(io, "u1", "seed"), ["seed", "r1"]);
  });

  test("empty-string seed is honored (only undefined means no seed)", async () => {
    const io = fakeIo([sock("u1", ["room:r1"])]);
    assert.deepEqual(await roomsForUser(io, "u1", ""), ["", "r1"]);
  });
});
