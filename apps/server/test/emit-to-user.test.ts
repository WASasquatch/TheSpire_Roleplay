import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { emitToUser, socketsForUser, socketsForUsers } from "../src/realtime/presence.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/**
 * Characterization test for the consolidated per-user socket fan-out helper
 * (apps/server/src/realtime/presence.ts), extracted byte-identically from the
 * inline "one io.fetchSockets(), filter by socket.data.userId, emit" copies
 * across notifications/servers/roomReads/earning/titles/incognito.
 *
 * Pins the exact behavior the inline loop produced:
 *  - emits ONCE per socket whose data.userId matches (every tab/device),
 *  - never emits to a socket owned by a different user,
 *  - forwards the event name + payload verbatim,
 *  - a socket with no userId on its data is skipped (never matches).
 */

type FakeSocket = {
  data: { userId?: string };
  calls: Array<{ event: string; args: unknown[] }>;
  emit(event: string, ...args: unknown[]): void;
};

function makeSocket(userId?: string): FakeSocket {
  const s: FakeSocket = {
    data: userId === undefined ? {} : { userId },
    calls: [],
    emit(event: string, ...args: unknown[]) {
      s.calls.push({ event, args });
    },
  };
  return s;
}

function makeIo(sockets: FakeSocket[]): Io {
  return { fetchSockets: async () => sockets } as unknown as Io;
}

describe("emitToUser", () => {
  test("emits to every socket owned by the target user", async () => {
    const a1 = makeSocket("u1");
    const a2 = makeSocket("u1");
    const b1 = makeSocket("u2");
    const io = makeIo([a1, a2, b1]);

    await emitToUser(io, "u1", "servers:changed", { addedServerId: null });

    assert.deepEqual(a1.calls, [{ event: "servers:changed", args: [{ addedServerId: null }] }]);
    assert.deepEqual(a2.calls, [{ event: "servers:changed", args: [{ addedServerId: null }] }]);
    assert.deepEqual(b1.calls, [], "other users' sockets are untouched");
  });

  test("no matching sockets => no emits, no throw", async () => {
    const b1 = makeSocket("u2");
    const io = makeIo([b1]);
    await emitToUser(io, "u1", "room:muted", { roomId: "r1", muted: true });
    assert.deepEqual(b1.calls, []);
  });

  test("sockets with no userId are skipped", async () => {
    const anon = makeSocket(undefined);
    const mine = makeSocket("u1");
    const io = makeIo([anon, mine]);
    await emitToUser(io, "u1", "room:muted", { roomId: "r1", muted: true });
    assert.deepEqual(anon.calls, []);
    assert.equal(mine.calls.length, 1);
    assert.equal(mine.calls[0]?.event, "room:muted");
  });

  test("forwards the payload object by reference (no clone/mutation)", async () => {
    const mine = makeSocket("u1");
    const io = makeIo([mine]);
    const payload = { roomId: "r1", serverId: null, unread: 3, hasMention: false };
    await emitToUser(io, "u1", "room:unread", payload);
    assert.equal(mine.calls[0]?.args[0], payload, "same object reference is emitted");
  });
});

/**
 * Characterization for the multi-event / liveness / disconnect / two-user
 * callers (pulse, forceLogoutUser, emitMutualSettled, award, incognito exit,
 * notifyBlockChange) that need the socket handles rather than a single fan-out.
 * Pins the exact match rules the inline `fetchSockets().filter(...)` loops had.
 */
describe("socketsForUser", () => {
  test("returns only the target user's sockets, in fetch order", async () => {
    const a1 = makeSocket("u1");
    const b1 = makeSocket("u2");
    const a2 = makeSocket("u1");
    const io = makeIo([a1, b1, a2]);
    const got = await socketsForUser(io, "u1");
    assert.deepEqual(got, [a1, a2], "both u1 sockets, order preserved, u2 excluded");
  });

  test("no matches => empty array (liveness callers read .length === 0)", async () => {
    const io = makeIo([makeSocket("u2")]);
    assert.deepEqual(await socketsForUser(io, "u1"), []);
  });

  test("sockets without a userId never match", async () => {
    const anon = makeSocket(undefined);
    const mine = makeSocket("u1");
    const io = makeIo([anon, mine]);
    assert.deepEqual(await socketsForUser(io, "u1"), [mine]);
  });
});

describe("socketsForUsers", () => {
  test("returns sockets for any user in the set, in fetch order", async () => {
    const a = makeSocket("u1");
    const b = makeSocket("u2");
    const c = makeSocket("u3");
    const io = makeIo([a, b, c]);
    assert.deepEqual(await socketsForUsers(io, ["u1", "u3"]), [a, c]);
  });

  test("accepts a Set as well as an array", async () => {
    const a = makeSocket("u1");
    const b = makeSocket("u2");
    const io = makeIo([a, b]);
    assert.deepEqual(await socketsForUsers(io, new Set(["u2"])), [b]);
  });

  test("empty id list => no matches (guard-free path still safe)", async () => {
    const io = makeIo([makeSocket("u1")]);
    assert.deepEqual(await socketsForUsers(io, []), []);
  });

  test("sockets without a userId never match (falsy uid excluded)", async () => {
    const anon = makeSocket(undefined);
    const mine = makeSocket("u1");
    const io = makeIo([anon, mine]);
    assert.deepEqual(await socketsForUsers(io, ["u1"]), [mine]);
  });
});
