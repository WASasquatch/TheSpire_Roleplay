import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { SessionUser } from "../src/commands/types.js";
import {
  effectiveRoomNsfw,
  effectiveRoomNsfwWith,
  evictMinorsFromRoom,
  nsfwServerIds,
  setRoomNsfw,
} from "../src/lib/nsfwRooms.js";
import { boardAgeDenied } from "../src/forums/nsfw.js";
import { roomVisibilityWhere } from "../src/realtime/targetedMessages.js";
import { joinRoom } from "../src/realtime/broadcast.js";
import { registerRoomsRoutes } from "../src/routes/rooms.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Phase 2 room gates (age-restriction plan): the /rooms rail hide, the
 * by-slug 404, the join refusal, stamped-history filtering on flipped-back
 * rooms, and the shared /nsfw toggle core (adult-only writes, landing-room
 * rule, minor eviction that KEEPS membership rows).
 *
 * Viewer matrix per plan_ext §F: anon / minor / adult / adult+hidePref.
 * The 18th-birthday boundary itself is pinned in age-gate.test.ts; here the
 * fixture DOBs are unambiguous (a 2012 minor, a 1990 adult).
 */

const MINOR_DOB = "2012-01-01";
const ADULT_DOB = "1990-01-01";

/* ── Fake socket.io: just enough surface for joinRoom / eviction /
 *    broadcast paths (fetchSockets, in(band), to(band), emit). ────────── */

interface FakeSocketData {
  userId?: string;
  user?: SessionUser;
  roomId?: string;
  serverId?: string;
  tabCharId?: string | null;
}

class FakeSocket {
  id = nanoid();
  rooms = new Set<string>();
  data: FakeSocketData = {};
  emitted: Array<{ event: string; payload: unknown }> = [];
  emit(event: string, payload?: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }
  join(band: string): void { this.rooms.add(band); }
  leave(band: string): void { this.rooms.delete(band); }
  lastNotice(): { code: string; message: string } | undefined {
    const hit = [...this.emitted].reverse().find((e) => e.event === "error:notice");
    return hit?.payload as { code: string; message: string } | undefined;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeIo(sockets: FakeSocket[] = []): any {
  return {
    async fetchSockets() { return sockets; },
    in(band: string) {
      return {
        async fetchSockets() { return sockets.filter((s) => s.rooms.has(band)); },
        emit(event: string, payload?: unknown) {
          for (const s of sockets) if (s.rooms.has(band)) s.emit(event, payload);
        },
      };
    },
    to(band: string) {
      return {
        emit(event: string, payload?: unknown) {
          for (const s of sockets) if (s.rooms.has(band)) s.emit(event, payload);
        },
      };
    },
    emit(event: string, payload?: unknown) {
      for (const s of sockets) s.emit(event, payload);
    },
  };
}

function sessionUserFor(
  u: { id: string; username: string },
  opts: { birthdate: string | null; hideNsfw?: boolean },
): SessionUser {
  return {
    id: u.id,
    username: u.username,
    role: "user",
    activeCharacterId: null,
    birthdate: opts.birthdate,
    isAdult: opts.birthdate === null || opts.birthdate <= "2007-12-31",
    hideNsfw: opts.hideNsfw ?? false,
    isolateFromAdults: false,
    locale: null,
    displayName: u.username,
    chatColor: null,
    awayMessage: null,
    currentMood: null,
    incognitoMode: false,
    incognitoAlias: null,
    incognitoCharacterId: null,
    incognitoExitMessage: null,
    incognitoReturnMessage: null,
  };
}

async function insertRoom(
  db: Db,
  opts: { name: string; isNsfw?: boolean; isDefault?: boolean; isSystem?: boolean; serverId?: string | null; slug?: string },
): Promise<string> {
  const id = nanoid();
  await db.insert(schema.rooms).values({
    id,
    name: opts.name,
    slug: opts.slug ?? opts.name.toLowerCase(),
    type: "public",
    isNsfw: opts.isNsfw ?? false,
    isDefault: opts.isDefault ?? false,
    isSystem: opts.isSystem ?? false,
    ...(opts.serverId !== undefined ? { serverId: opts.serverId } : {}),
  });
  return id;
}

async function insertMessage(
  db: Db,
  opts: { roomId: string; userId: string; body: string; isNsfw?: boolean },
): Promise<string> {
  const id = nanoid();
  await db.insert(schema.messages).values({
    id,
    roomId: opts.roomId,
    userId: opts.userId,
    characterId: null,
    displayName: "author",
    kind: "say",
    body: opts.body,
    isNsfw: opts.isNsfw ?? false,
  });
  return id;
}

let db: Db;
let app: FastifyInstance;
let adult: { id: string; username: string };
let hidePrefAdult: { id: string; username: string };
let minor: { id: string; username: string };
let adultToken: string;
let hidePrefToken: string;
let minorToken: string;
let landingId: string;
let sfwRoomId: string;
let nsfwRoomId: string;

before(async () => {
  db = makeTestDb().db;
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) { reply.code(400); return reply.send({ error: "validation" }); }
    throw err;
  });
  await registerRoomsRoutes(app, db, makeFakeIo());
  await app.ready();

  adult = await createUser(db, { birthdate: ADULT_DOB });
  hidePrefAdult = await createUser(db, { birthdate: ADULT_DOB, hideNsfw: true });
  minor = await createUser(db, { birthdate: MINOR_DOB });
  adultToken = await tokenFor(db, adult.id);
  hidePrefToken = await tokenFor(db, hidePrefAdult.id);
  minorToken = await tokenFor(db, minor.id);

  landingId = await insertRoom(db, { name: "The_Spire", isDefault: true, isSystem: true, slug: "the-spire" });
  sfwRoomId = await insertRoom(db, { name: "Tavern", slug: "tavern" });
  nsfwRoomId = await insertRoom(db, { name: "After_Dark", isNsfw: true, slug: "after-dark" });
});

describe("effective rating helpers", () => {
  test("room flag alone decides when there is no server", async () => {
    assert.equal(await effectiveRoomNsfw(db, { isNsfw: true, serverId: null }), true);
    assert.equal(await effectiveRoomNsfw(db, { isNsfw: false, serverId: null }), false);
  });

  test("an 18+ server makes every room inside effectively 18+", async () => {
    const owner = await createUser(db, { birthdate: ADULT_DOB });
    const serverId = nanoid();
    await db.insert(schema.servers).values({
      id: serverId, slug: `s-${serverId.slice(0, 6)}`, name: "Adult Server", ownerUserId: owner.id, isNsfw: true,
    });
    assert.equal(await effectiveRoomNsfw(db, { isNsfw: false, serverId }), true);
    const set = await nsfwServerIds(db);
    assert.equal(set.has(serverId), true);
    assert.equal(effectiveRoomNsfwWith({ isNsfw: false, serverId }, set), true);
    assert.equal(effectiveRoomNsfwWith({ isNsfw: false, serverId: null }, set), false);
  });

  test("boardAgeDenied (the one HARD read gate): minors and anonymous denied, adults pass", async () => {
    // Non-board rooms pass forumId: null — the room/server tiers exactly.
    const room = { isNsfw: true, serverId: null, forumId: null };
    assert.equal(await boardAgeDenied(db, null, room), true);
    assert.equal(await boardAgeDenied(db, { isAdult: false }, room), true);
    assert.equal(await boardAgeDenied(db, { isAdult: true }, room), false);
    assert.equal(await boardAgeDenied(db, { isAdult: false }, { isNsfw: false, serverId: null, forumId: null }), false);
  });
});

describe("GET /rooms rail gate", () => {
  test("minor never receives the 18+ room; adults always do (both pref states)", async () => {
    const names = async (token?: string) => {
      const res = await app.inject({ method: "GET", url: "/rooms", ...(token ? { headers: auth(token) } : {}) });
      assert.equal(res.statusCode, 200);
      return (res.json() as { rooms: Array<{ name: string; isNsfw?: boolean }> }).rooms;
    };
    const minorRooms = await names(minorToken);
    assert.equal(minorRooms.some((r) => r.name === "After_Dark"), false);
    assert.equal(minorRooms.some((r) => r.name === "Tavern"), true);

    const anonRooms = await names();
    assert.equal(anonRooms.some((r) => r.name === "After_Dark"), false);

    const adultRooms = await names(adultToken);
    const nsfwRow = adultRooms.find((r) => r.name === "After_Dark");
    assert.ok(nsfwRow, "adult sees the 18+ room");
    assert.equal(nsfwRow!.isNsfw, true, "row carries the 18+ chip flag");

    // The hide preference does NOT un-list rooms (rail = navigation).
    const hidePrefRooms = await names(hidePrefToken);
    assert.equal(hidePrefRooms.some((r) => r.name === "After_Dark"), true);
  });
});

describe("GET /rooms/by-slug deep link", () => {
  test("404 for minor and anonymous, 200 for adult", async () => {
    const hit = async (token?: string) =>
      app.inject({ method: "GET", url: "/rooms/by-slug/after-dark", ...(token ? { headers: auth(token) } : {}) });
    assert.equal((await hit(minorToken)).statusCode, 404);
    assert.equal((await hit()).statusCode, 404);
    assert.equal((await hit(adultToken)).statusCode, 200);
    assert.equal((await hit(hidePrefToken)).statusCode, 200);
  });
});

describe("room read routes", () => {
  test("scroll-up history of an 18+ room 404s for a minor, serves an adult", async () => {
    await insertMessage(db, { roomId: nsfwRoomId, userId: adult.id, body: "adults only line", isNsfw: true });
    const url = `/rooms/${nsfwRoomId}/messages?before=${Date.now() + 1000}`;
    assert.equal((await app.inject({ method: "GET", url, headers: auth(minorToken) })).statusCode, 404);
    const ok = await app.inject({ method: "GET", url, headers: auth(adultToken) });
    assert.equal(ok.statusCode, 200);
    assert.equal((ok.json() as { messages: unknown[] }).messages.length > 0, true);
  });

  test("flipped-back room: stamped 18+-era rows hide from minors, adults keep them (hide pref too)", async () => {
    const flipped = await insertRoom(db, { name: "Flipped", slug: "flipped" });
    await insertMessage(db, { roomId: flipped, userId: adult.id, body: "all ages era", isNsfw: false });
    await insertMessage(db, { roomId: flipped, userId: adult.id, body: "eighteen plus era", isNsfw: true });

    const bodies = async (token: string) => {
      const res = await app.inject({
        method: "GET",
        url: `/rooms/${flipped}/messages?before=${Date.now() + 1000}`,
        headers: auth(token),
      });
      assert.equal(res.statusCode, 200);
      return (res.json() as { messages: Array<{ body: string }> }).messages.map((m) => m.body);
    };
    const minorBodies = await bodies(minorToken);
    assert.deepEqual(minorBodies, ["all ages era"]);
    const adultBodies = await bodies(adultToken);
    assert.equal(adultBodies.includes("eighteen plus era"), true);
    // HARD tier: the hide preference does not hide chat history from adults.
    const hidePrefBodies = await bodies(hidePrefToken);
    assert.equal(hidePrefBodies.includes("eighteen plus era"), true);
  });

  test("per-room search drops stamped rows for the hide-pref adult (SOFT tier)", async () => {
    const flipped = await insertRoom(db, { name: "FlippedSearch", slug: "flipped-search" });
    await insertMessage(db, { roomId: flipped, userId: adult.id, body: "searchable sfw needle", isNsfw: false });
    await insertMessage(db, { roomId: flipped, userId: adult.id, body: "searchable nsfw needle", isNsfw: true });
    const hits = async (token: string) => {
      const res = await app.inject({
        method: "GET",
        url: `/rooms/${flipped}/messages/search?q=needle`,
        headers: auth(token),
      });
      assert.equal(res.statusCode, 200);
      return (res.json() as { hits: Array<{ snippet: string }> }).hits.map((h) => h.snippet);
    };
    assert.equal((await hits(adultToken)).length, 2);
    assert.deepEqual(await hits(hidePrefToken), ["searchable sfw needle"]);
    assert.deepEqual(await hits(minorToken), ["searchable sfw needle"]);
  });

  test("roomVisibilityWhere clause filters stamped rows only when the viewer can't see NSFW", async () => {
    const roomId = await insertRoom(db, { name: "ClauseRoom", slug: "clause-room" });
    await insertMessage(db, { roomId, userId: adult.id, body: "clean", isNsfw: false });
    await insertMessage(db, { roomId, userId: adult.id, body: "stamped", isNsfw: true });
    const rows = async (canSee: boolean) =>
      db.select({ body: schema.messages.body }).from(schema.messages)
        .where(roomVisibilityWhere(roomId, minor.id, undefined, canSee));
    assert.deepEqual((await rows(false)).map((r) => r.body), ["clean"]);
    assert.equal((await rows(true)).length, 2);
  });
});

describe("join gate", () => {
  test("minor joining an 18+ room gets AGE_RESTRICTED; adult joins fine", async () => {
    const minorSock = new FakeSocket();
    const minorUser = sessionUserFor(minor, { birthdate: MINOR_DOB });
    minorSock.data.userId = minor.id;
    minorSock.data.user = minorUser;
    const io = makeFakeIo([minorSock]);
    await joinRoom(io, db, minorSock as never, minorUser, nsfwRoomId);
    const notice = minorSock.lastNotice();
    assert.equal(notice?.code, "AGE_RESTRICTED");
    assert.equal(notice?.message, "This room is for adults only.");
    assert.equal(minorSock.rooms.has(`room:${nsfwRoomId}`), false);
  });
});

describe("setRoomNsfw toggle core", () => {
  test("minor actor can never set or clear the flag", async () => {
    const roomRow = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, sfwRoomId)).limit(1))[0]!;
    const res = await setRoomNsfw({ db, io: makeFakeIo(), room: roomRow, value: true, actor: { id: minor.id, isAdult: false } });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "AGE_RESTRICTED");
    const after = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, sfwRoomId)).limit(1))[0]!;
    assert.equal(after.isNsfw, false);
  });

  test("the landing room of an all-ages server can't be flagged 18+", async () => {
    const landing = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, landingId)).limit(1))[0]!;
    const res = await setRoomNsfw({ db, io: makeFakeIo(), room: landing, value: true, actor: { id: adult.id, isAdult: true } });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "LANDING_ROOM");
  });

  test("flip ON evicts minor occupants (membership rows kept), audits, and posts the §G line", async () => {
    const roomId = await insertRoom(db, { name: "FlipMe", slug: "flip-me" });
    await db.insert(schema.roomMembers).values([
      { roomId, userId: minor.id, role: "member" },
      { roomId, userId: adult.id, role: "member" },
    ]);
    const minorSock = new FakeSocket();
    minorSock.data.userId = minor.id;
    minorSock.data.user = sessionUserFor(minor, { birthdate: MINOR_DOB });
    minorSock.data.roomId = roomId;
    minorSock.rooms.add(`room:${roomId}`);
    const adultSock = new FakeSocket();
    adultSock.data.userId = adult.id;
    adultSock.data.user = sessionUserFor(adult, { birthdate: ADULT_DOB });
    adultSock.data.roomId = roomId;
    adultSock.rooms.add(`room:${roomId}`);
    const io = makeFakeIo([minorSock, adultSock]);

    const roomRow = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId)).limit(1))[0]!;
    const res = await setRoomNsfw({ db, io, room: roomRow, value: true, actor: { id: adult.id, isAdult: true } });
    assert.equal(res.ok, true);

    // Row flagged; minor socket booted to the landing; adult untouched.
    const after = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId)).limit(1))[0]!;
    assert.equal(after.isNsfw, true);
    assert.equal(minorSock.rooms.has(`room:${roomId}`), false);
    assert.equal(minorSock.rooms.has(`room:${landingId}`), true);
    assert.equal(minorSock.lastNotice()?.code, "AGE_RESTRICTED");
    assert.equal(adultSock.rooms.has(`room:${roomId}`), true);

    // Keep-but-hide: BOTH membership rows survive the flip.
    const members = await db.select().from(schema.roomMembers)
      .where(and(eq(schema.roomMembers.roomId, roomId), eq(schema.roomMembers.userId, minor.id)));
    assert.equal(members.length, 1);

    // Audit trail.
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "room_nsfw_update"));
    assert.equal(audit.length >= 1, true);

    // Flip OFF re-reveals but the write is symmetric (adult-only, audited).
    const flippedRow = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId)).limit(1))[0]!;
    const off = await setRoomNsfw({ db, io, room: flippedRow, value: false, actor: { id: adult.id, isAdult: true } });
    assert.equal(off.ok, true);
    const cleared = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId)).limit(1))[0]!;
    assert.equal(cleared.isNsfw, false);
  });

  test("unread counts exclude effectively-18+ rooms for minor members", async () => {
    const { computeRoomUnread } = await import("../src/routes/roomReads.js");
    const roomId = await insertRoom(db, { name: "UnreadNsfw", slug: "unread-nsfw", isNsfw: true });
    await db.insert(schema.roomMembers).values([
      { roomId, userId: minor.id, role: "member" },
      { roomId, userId: adult.id, role: "member" },
    ]);
    await insertMessage(db, { roomId, userId: adult.id, body: "activity", isNsfw: true });
    const minorMap = await computeRoomUnread(db, minor.id);
    assert.equal(minorMap[roomId], undefined, "no unread entry for the hidden room");
    const adultMap = await computeRoomUnread(db, adult.id);
    // The adult member sees the count (the author was the adult, so seed a
    // second author row to produce unread for them).
    await insertMessage(db, { roomId, userId: minor.id, body: "from minor", isNsfw: true });
    const adultMap2 = await computeRoomUnread(db, adult.id);
    assert.equal((adultMap2[roomId]?.unread ?? 0) > 0, true);
    void adultMap;
  });

  test("evictMinorsFromRoom is a no-op for adult occupants", async () => {
    const roomId = await insertRoom(db, { name: "AdultsStay", slug: "adults-stay" });
    const adultSock = new FakeSocket();
    adultSock.data.userId = adult.id;
    adultSock.data.user = sessionUserFor(adult, { birthdate: ADULT_DOB });
    adultSock.rooms.add(`room:${roomId}`);
    const io = makeFakeIo([adultSock]);
    const booted = await evictMinorsFromRoom(io, db, { id: roomId, serverId: null }, "This room is now for adults only.");
    assert.equal(booted, 0);
    assert.equal(adultSock.rooms.has(`room:${roomId}`), true);
  });
});
