import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { SessionUser } from "../src/commands/types.js";
import {
  isIsolatedBetween,
  isIsolatedBetweenIds,
  isolationActiveFor,
  isolationAmong,
  isolationHiddenSetFor,
  unionGraphInto,
} from "../src/auth/ageIsolation.js";
import { registerRoomsRoutes } from "../src/routes/rooms.js";
import { registerSearchRoutes } from "../src/routes/search.js";
import { registerFriendsRoutes } from "../src/routes/friends.js";
import { registerDirectMessageRoutes } from "../src/routes/directMessages.js";
import { notify as notifyCenter } from "../src/notifications/engine.js";
import { whisperCommand } from "../src/commands/builtins/whisper.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Phase 5 minor isolation mode (age-restriction plan): the mutual
 * isolated-minor × adult-non-staff invisibility, per plan_ext §F's
 * Isolation row — predicate truth table, the block-shaped batch helpers,
 * and per-surface enforcement (chat backlog + searches, forum topic list +
 * thread, friends, DMs, whisper, notification engine), plus the inert-at-18
 * behavior. The admin set/clear + audit path is pinned in
 * admin-users-age.test.ts; the adult PUT /me/profile rejection in
 * age-profile-nsfw.test.ts.
 */

const MINOR_DOB = "2012-01-01";
const ADULT_DOB = "1990-01-01";

/** An ISO date exactly 18 years before today (UTC), valid-calendar-safe:
 *  a Feb 29 "today" clamps to Feb 28, which is still 18-or-older. */
function exactly18Dob(): string {
  const now = new Date();
  const y = now.getUTCFullYear() - 18;
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  let dd = now.getUTCDate();
  if (now.getUTCMonth() === 1 && dd === 29) dd = 28;
  return `${y}-${mm}-${String(dd).padStart(2, "0")}`;
}

type Subject = { role: string; birthdate: string | null; isolateFromAdults: boolean };
const s = (role: string, birthdate: string | null, isolateFromAdults = false): Subject =>
  ({ role, birthdate, isolateFromAdults });

/* ── Predicate unit tests (no DB) ─────────────────────────────────────── */

describe("isolationActiveFor", () => {
  test("requires the flag AND still being a minor", () => {
    assert.equal(isolationActiveFor(s("user", MINOR_DOB, true)), true);
    assert.equal(isolationActiveFor(s("user", MINOR_DOB, false)), false);
    assert.equal(isolationActiveFor(s("user", ADULT_DOB, true)), false);
    assert.equal(isolationActiveFor(s("user", null, true)), false); // legacy adult
  });

  test("inert from the 18th birthday by computation (no write anywhere)", () => {
    assert.equal(isolationActiveFor(s("user", exactly18Dob(), true)), false);
  });
});

describe("isIsolatedBetween", () => {
  const isolatedMinor = s("user", MINOR_DOB, true);
  const plainMinor = s("user", MINOR_DOB);
  const adult = s("user", ADULT_DOB);
  const legacyAdult = s("user", null);

  test("mutual: isolated minor × adult non-staff, both orders", () => {
    assert.equal(isIsolatedBetween(isolatedMinor, adult), true);
    assert.equal(isIsolatedBetween(adult, isolatedMinor), true);
    assert.equal(isIsolatedBetween(isolatedMinor, legacyAdult), true);
  });

  test("site staff exempt in both directions (mod, admin, masteradmin)", () => {
    for (const role of ["mod", "admin", "masteradmin"]) {
      assert.equal(isIsolatedBetween(isolatedMinor, s(role, ADULT_DOB)), false);
      assert.equal(isIsolatedBetween(s(role, ADULT_DOB), isolatedMinor), false);
    }
    // `trusted` is NOT staff.
    assert.equal(isIsolatedBetween(isolatedMinor, s("trusted", ADULT_DOB)), true);
  });

  test("minors see each other; adults see each other; flagless pairs pass", () => {
    assert.equal(isIsolatedBetween(isolatedMinor, plainMinor), false);
    assert.equal(isIsolatedBetween(isolatedMinor, s("user", MINOR_DOB, true)), false);
    assert.equal(isIsolatedBetween(adult, legacyAdult), false);
    assert.equal(isIsolatedBetween(plainMinor, adult), false);
  });

  test("a just-turned-18 account with the stale flag isolates nobody", () => {
    const agedOut = s("user", exactly18Dob(), true);
    assert.equal(isIsolatedBetween(agedOut, adult), false);
    assert.equal(isIsolatedBetween(agedOut, plainMinor), false);
  });
});

/* ── DB-backed helpers + per-surface enforcement ──────────────────────── */

let db: Db;
let app: FastifyInstance;
let io: FakeIo;
let isolatedMinor: { id: string; username: string };
let plainMinor: { id: string; username: string };
let adult: { id: string; username: string };
let staff: { id: string; username: string };
let isolatedTokenH: { authorization: string };
let plainMinorTokenH: { authorization: string };
let adultTokenH: { authorization: string };
let staffTokenH: { authorization: string };
let roomId: string;

/** Just enough socket.io for the routes/commands under test. */
class FakeSocket {
  id = nanoid();
  rooms = new Set<string>();
  data: { userId?: string; user?: SessionUser; roomId?: string } = {};
  emitted: Array<{ event: string; payload: unknown }> = [];
  emit(event: string, payload?: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }
  lastNotice(): { code: string; message: string } | undefined {
    const hit = [...this.emitted].reverse().find((e) => e.event === "error:notice");
    return hit?.payload as { code: string; message: string } | undefined;
  }
}

interface FakeIo {
  fetchSockets(): Promise<FakeSocket[]>;
  in(band: string): { fetchSockets(): Promise<FakeSocket[]>; emit(event: string, payload?: unknown): void };
  to(band: string): { emit(event: string, payload?: unknown): void };
  emit(event: string, payload?: unknown): void;
}

function makeFakeIo(sockets: FakeSocket[] = []): FakeIo {
  return {
    async fetchSockets() { return sockets; },
    in(band: string) {
      return {
        async fetchSockets() { return sockets.filter((x) => x.rooms.has(band)); },
        emit(event: string, payload?: unknown) {
          for (const x of sockets) if (x.rooms.has(band)) x.emit(event, payload);
        },
      };
    },
    to(band: string) {
      return {
        emit(event: string, payload?: unknown) {
          for (const x of sockets) if (x.rooms.has(band)) x.emit(event, payload);
        },
      };
    },
    emit() { /* global no-op */ },
  };
}

async function insertRoom(db: Db, name: string): Promise<string> {
  const id = nanoid();
  await db.insert(schema.rooms).values({ id, name, slug: name.toLowerCase(), type: "public" });
  return id;
}

async function insertMessage(
  db: Db,
  opts: { roomId: string; userId: string; body: string; title?: string; replyToId?: string },
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
    ...(opts.title ? { title: opts.title, lastActivityAt: new Date() } : {}),
    ...(opts.replyToId ? { replyToId: opts.replyToId } : {}),
  });
  return id;
}

function sessionUserFor(u: { id: string; username: string }, opts: {
  birthdate: string | null;
  role?: SessionUser["role"];
  isolateFromAdults?: boolean;
}): SessionUser {
  return {
    id: u.id,
    username: u.username,
    role: opts.role ?? "user",
    activeCharacterId: null,
    birthdate: opts.birthdate,
    isAdult: opts.birthdate === null || opts.birthdate <= "2007-12-31",
    hideNsfw: false,
    isolateFromAdults: opts.isolateFromAdults ?? false,
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

before(async () => {
  db = makeTestDb().db;
  io = makeFakeIo();
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) { reply.code(400); return reply.send({ error: "validation" }); }
    throw err;
  });
  await registerRoomsRoutes(app, db, io as never);
  await registerSearchRoutes(app, db);
  await registerFriendsRoutes(app, db, io as never);
  await registerDirectMessageRoutes(app, db, io as never);
  await app.ready();

  isolatedMinor = await createUser(db, { birthdate: MINOR_DOB, isolateFromAdults: true, username: "iso_minor" });
  plainMinor = await createUser(db, { birthdate: MINOR_DOB, username: "plain_minor" });
  adult = await createUser(db, { birthdate: ADULT_DOB, username: "some_adult" });
  staff = await createUser(db, { birthdate: ADULT_DOB, role: "mod", username: "mod_adult" });
  isolatedTokenH = auth(await tokenFor(db, isolatedMinor.id));
  plainMinorTokenH = auth(await tokenFor(db, plainMinor.id));
  adultTokenH = auth(await tokenFor(db, adult.id));
  staffTokenH = auth(await tokenFor(db, staff.id));

  roomId = await insertRoom(db, "Commons");
  await insertMessage(db, { roomId, userId: adult.id, body: "adult line" });
  await insertMessage(db, { roomId, userId: staff.id, body: "staff line" });
  await insertMessage(db, { roomId, userId: plainMinor.id, body: "plain minor line" });
  await insertMessage(db, { roomId, userId: isolatedMinor.id, body: "isolated minor line" });
});

describe("DB helpers", () => {
  test("isIsolatedBetweenIds mirrors the predicate; missing rows are safe", async () => {
    assert.equal(await isIsolatedBetweenIds(db, isolatedMinor.id, adult.id), true);
    assert.equal(await isIsolatedBetweenIds(db, adult.id, isolatedMinor.id), true);
    assert.equal(await isIsolatedBetweenIds(db, isolatedMinor.id, staff.id), false);
    assert.equal(await isIsolatedBetweenIds(db, isolatedMinor.id, plainMinor.id), false);
    assert.equal(await isIsolatedBetweenIds(db, adult.id, adult.id), false);
    assert.equal(await isIsolatedBetweenIds(db, adult.id, "no_such_user"), false);
  });

  test("isolationHiddenSetFor: per-viewer classes", async () => {
    const everyone = [isolatedMinor.id, plainMinor.id, adult.id, staff.id];
    const minorViewer = { role: "user", birthdate: MINOR_DOB, isolateFromAdults: true };
    const hiddenFromIsolated = await isolationHiddenSetFor(db, minorViewer, everyone);
    assert.deepEqual([...hiddenFromIsolated], [adult.id]);

    const adultViewer = { role: "user", birthdate: ADULT_DOB, isolateFromAdults: false };
    const hiddenFromAdult = await isolationHiddenSetFor(db, adultViewer, everyone);
    assert.deepEqual([...hiddenFromAdult], [isolatedMinor.id]);

    // Staff, anonymous, and plain minors filter nothing.
    assert.equal((await isolationHiddenSetFor(db, { role: "mod", birthdate: ADULT_DOB, isolateFromAdults: false }, everyone)).size, 0);
    assert.equal((await isolationHiddenSetFor(db, null, everyone)).size, 0);
    assert.equal((await isolationHiddenSetFor(db, { role: "user", birthdate: MINOR_DOB, isolateFromAdults: false }, everyone)).size, 0);
  });

  test("isolationAmong links only isolated-minor × adult-non-staff pairs", async () => {
    const graph = await isolationAmong(db, [isolatedMinor.id, plainMinor.id, adult.id, staff.id]);
    assert.deepEqual([...(graph.get(isolatedMinor.id) ?? [])], [adult.id]);
    assert.deepEqual([...(graph.get(adult.id) ?? [])], [isolatedMinor.id]);
    assert.equal(graph.has(plainMinor.id), false);
    assert.equal(graph.has(staff.id), false);
    // No isolated minors among the ids → empty map (the fast path).
    assert.equal((await isolationAmong(db, [plainMinor.id, adult.id, staff.id])).size, 0);
  });

  test("unionGraphInto merges without dropping either side", () => {
    const a = new Map([["x", new Set(["y"])]]);
    const b = new Map([["x", new Set(["z"])], ["w", new Set(["x"])]]);
    const merged = unionGraphInto(a, b);
    assert.deepEqual([...(merged.get("x") ?? [])].sort(), ["y", "z"]);
    assert.deepEqual([...(merged.get("w") ?? [])], ["x"]);
  });
});

describe("chat history + searches", () => {
  test("scroll-up history drops isolated-pair authors both ways; staff and plain minors see all", async () => {
    const bodies = async (h: Record<string, string>) => {
      const res = await app.inject({ method: "GET", url: `/rooms/${roomId}/messages?before=${Date.now() + 1000}`, headers: h });
      assert.equal(res.statusCode, 200);
      return (res.json() as { messages: Array<{ body: string }> }).messages.map((m) => m.body);
    };
    const forIsolated = await bodies(isolatedTokenH);
    assert.equal(forIsolated.includes("adult line"), false, "adult-authored line hidden from the isolated minor");
    assert.equal(forIsolated.includes("staff line"), true, "staff stays visible");
    assert.equal(forIsolated.includes("isolated minor line"), true, "own line survives");

    const forAdult = await bodies(adultTokenH);
    assert.equal(forAdult.includes("isolated minor line"), false, "isolated minor hidden from the adult");
    assert.equal(forAdult.includes("plain minor line"), true, "non-isolated minor still visible");

    assert.equal((await bodies(staffTokenH)).includes("isolated minor line"), true);
    assert.equal((await bodies(plainMinorTokenH)).includes("adult line"), true);
  });

  test("per-room and server-wide search drop isolated-pair hits", async () => {
    await insertMessage(db, { roomId, userId: adult.id, body: "sekrit needle from adult" });
    await insertMessage(db, { roomId, userId: isolatedMinor.id, body: "sekrit needle from minor" });
    const roomHits = async (h: Record<string, string>) => {
      const res = await app.inject({ method: "GET", url: `/rooms/${roomId}/messages/search?q=sekrit`, headers: h });
      assert.equal(res.statusCode, 200);
      return (res.json() as { hits: Array<{ snippet: string }> }).hits.map((x) => x.snippet);
    };
    assert.deepEqual(await roomHits(isolatedTokenH), ["sekrit needle from minor"]);
    assert.deepEqual(await roomHits(adultTokenH), ["sekrit needle from adult"]);
    assert.equal((await roomHits(staffTokenH)).length, 2);

    const globalHits = async (h: Record<string, string>) => {
      const res = await app.inject({ method: "GET", url: "/search/messages?q=sekrit", headers: h });
      assert.equal(res.statusCode, 200);
      return (res.json() as { hits: Array<{ snippet: string }> }).hits.map((x) => x.snippet);
    };
    assert.deepEqual(await globalHits(isolatedTokenH), ["sekrit needle from minor"]);
    assert.deepEqual(await globalHits(adultTokenH), ["sekrit needle from adult"]);
    assert.equal((await globalHits(staffTokenH)).length, 2);
  });
});

describe("forum topic list + thread (the routes blocks never covered)", () => {
  let boardId: string;
  let adultTopicId: string;
  let minorTopicId: string;

  before(async () => {
    boardId = await insertRoom(db, "Board");
    adultTopicId = await insertMessage(db, { roomId: boardId, userId: adult.id, body: "adult topic body", title: "Adult topic" });
    minorTopicId = await insertMessage(db, { roomId: boardId, userId: isolatedMinor.id, body: "minor topic body", title: "Minor topic" });
    // A mixed thread: minor-authored topic with one adult reply + one staff reply.
    await insertMessage(db, { roomId: boardId, userId: adult.id, body: "adult reply", replyToId: minorTopicId });
    await insertMessage(db, { roomId: boardId, userId: staff.id, body: "staff reply", replyToId: minorTopicId });
  });

  test("topic list: isolated-pair authors drop, pagination totals stay exact", async () => {
    const topics = async (h: Record<string, string>) => {
      const res = await app.inject({ method: "GET", url: `/rooms/${boardId}/topics`, headers: h });
      assert.equal(res.statusCode, 200);
      return res.json() as { topics: Array<{ title?: string }>; totalCount: number };
    };
    const forIsolated = await topics(isolatedTokenH);
    assert.equal(forIsolated.topics.some((t) => t.title === "Adult topic"), false);
    assert.equal(forIsolated.topics.some((t) => t.title === "Minor topic"), true);
    assert.equal(forIsolated.totalCount, 1, "COUNT inherits the filter (no ghost pages)");

    const forAdult = await topics(adultTokenH);
    assert.equal(forAdult.topics.some((t) => t.title === "Minor topic"), false);
    assert.equal(forAdult.topics.some((t) => t.title === "Adult topic"), true);

    assert.equal((await topics(staffTokenH)).topics.length, 2);
    assert.equal((await topics(plainMinorTokenH)).topics.length, 2);
  });

  test("thread route: isolated topic author 404s the thread; isolated repliers drop from a visible one", async () => {
    const thread = (id: string, h: Record<string, string>) =>
      app.inject({ method: "GET", url: `/rooms/${boardId}/messages/${id}/thread`, headers: h });

    assert.equal((await thread(adultTopicId, isolatedTokenH)).statusCode, 404);
    assert.equal((await thread(minorTopicId, adultTokenH)).statusCode, 404);
    assert.equal((await thread(adultTopicId, adultTokenH)).statusCode, 200);
    assert.equal((await thread(minorTopicId, staffTokenH)).statusCode, 200);

    const visible = await thread(minorTopicId, isolatedTokenH);
    assert.equal(visible.statusCode, 200);
    const replies = (visible.json() as { replies: Array<{ body: string }> }).replies.map((r) => r.body);
    assert.equal(replies.includes("adult reply"), false, "adult reply hidden inside the visible thread");
    assert.equal(replies.includes("staff reply"), true);
  });
});

describe("friends", () => {
  before(async () => {
    // Pre-existing accepted friendship across the fence (made before the
    // toggle) + a pending request from the adult.
    await db.insert(schema.friends).values({
      frienderUserId: adult.id,
      frienderCharacterId: null,
      friendedUserId: isolatedMinor.id,
      friendedCharacterId: null,
      status: "accepted",
    });
    await db.insert(schema.friends).values({
      frienderUserId: staff.id,
      frienderCharacterId: null,
      friendedUserId: isolatedMinor.id,
      friendedCharacterId: null,
      status: "accepted",
    });
  });

  test("accepted ties are hidden, not severed, in both directions; staff stays", async () => {
    const list = async (h: Record<string, string>) => {
      const res = await app.inject({ method: "GET", url: "/me/friends", headers: h });
      assert.equal(res.statusCode, 200);
      return (res.json() as { friends: Array<{ userId: string }> }).friends.map((f) => f.userId);
    };
    const mine = await list(isolatedTokenH);
    assert.equal(mine.includes(adult.id), false, "adult friend hidden from the isolated minor");
    assert.equal(mine.includes(staff.id), true, "staff friend stays");
    assert.equal((await list(adultTokenH)).includes(isolatedMinor.id), false, "minor hidden from the adult");
    // The row itself survives (keep-but-hide).
    const row = await db.select().from(schema.friends)
      .where(eq(schema.friends.frienderUserId, adult.id));
    assert.equal(row.length, 1);
  });

  test("friend requests across the fence behave as no-such-user; staff pass the gate", async () => {
    const send = (h: Record<string, string>, username: string) =>
      app.inject({ method: "POST", url: "/me/friend-requests", headers: h, payload: { username } });
    assert.equal((await send(isolatedTokenH, adult.username)).statusCode, 404);
    assert.equal((await send(adultTokenH, isolatedMinor.username)).statusCode, 404);
    // Staff × isolated minor passes the gate; the pre-seeded accepted row
    // resolves as 200 already_friends (proof the pair wasn't 404'd).
    const staffRes = await send(staffTokenH, isolatedMinor.username);
    assert.equal(staffRes.statusCode, 200);
    assert.equal((staffRes.json() as { status: string }).status, "already_friends");
    assert.equal((await send(isolatedTokenH, plainMinor.username)).statusCode, 201);
  });
});

describe("direct messages", () => {
  let convId: string;

  before(async () => {
    // A pre-isolation DM thread between the adult and the isolated minor.
    convId = nanoid();
    const [aId, bId] = [adult.id, isolatedMinor.id].sort();
    await db.insert(schema.directConversations).values({
      id: convId,
      userAId: aId,
      userACharacterId: null,
      userBId: bId,
      userBCharacterId: null,
      lastMessageAt: new Date(),
    });
    await db.insert(schema.directMessages).values({
      id: nanoid(),
      conversationId: convId,
      senderUserId: adult.id,
      senderCharacterId: null,
      displayName: adult.username,
      avatarUrl: null,
      body: "old dm from the adult",
    });
  });

  test("the thread is hidden from both sides' inboxes while the mode is on", async () => {
    const convs = async (h: Record<string, string>) => {
      const res = await app.inject({ method: "GET", url: "/me/dms", headers: h });
      assert.equal(res.statusCode, 200);
      return (res.json() as { conversations: Array<{ id: string }> }).conversations.map((c) => c.id);
    };
    assert.equal((await convs(isolatedTokenH)).includes(convId), false);
    assert.equal((await convs(adultTokenH)).includes(convId), false);
  });

  test("new sends across the fence 404 like a missing user; staff can DM the minor", async () => {
    const send = (h: Record<string, string>, targetId: string) =>
      app.inject({ method: "POST", url: `/me/dms/with/${targetId}/messages`, headers: h, payload: { body: "hi" } });
    assert.equal((await send(isolatedTokenH, adult.id)).statusCode, 404);
    assert.equal((await send(adultTokenH, isolatedMinor.id)).statusCode, 404);
    assert.equal((await send(staffTokenH, isolatedMinor.id)).statusCode, 201);
    assert.equal((await send(isolatedTokenH, plainMinor.id)).statusCode, 201);
  });

  test("inbox counts exclude the hidden thread's unread", async () => {
    const res = await app.inject({ method: "GET", url: "/me/inbox-counts", headers: isolatedTokenH });
    assert.equal(res.statusCode, 200);
    const counts = (res.json() as { counts: Array<{ characterId: string | null; unreadDms: number }> }).counts;
    const master = counts.find((c) => c.characterId === null);
    // The staff DM from the test above IS counted; the adult's old line is not.
    assert.equal(master!.unreadDms, 1);
  });
});

describe("whisper command", () => {
  test("an isolated pair whispers into 'no such user'; the row is never written", async () => {
    const sock = new FakeSocket();
    const ctx = {
      db,
      io: makeFakeIo() as never,
      socket: sock as never,
      user: sessionUserFor(isolatedMinor, { birthdate: MINOR_DOB, isolateFromAdults: true }),
      roomId,
      argsText: `${adult.username} psst`,
      args: [adult.username, "psst"],
      invokedAs: "whisper",
      registry: {} as never,
    };
    await whisperCommand.run(ctx as never);
    assert.equal(sock.lastNotice()?.code, "WHISPER_NO_USER");
    const rows = await db.select().from(schema.messages).where(eq(schema.messages.toUserId, adult.id));
    assert.equal(rows.length, 0);
  });

  test("staff can whisper the isolated minor", async () => {
    const sock = new FakeSocket();
    const ctx = {
      db,
      io: makeFakeIo() as never,
      socket: sock as never,
      user: sessionUserFor(staff, { birthdate: ADULT_DOB, role: "mod" }),
      roomId,
      argsText: `${isolatedMinor.username} you ok?`,
      args: [isolatedMinor.username, "you", "ok?"],
      invokedAs: "whisper",
      registry: {} as never,
    };
    await whisperCommand.run(ctx as never);
    assert.notEqual(sock.lastNotice()?.code, "WHISPER_NO_USER");
    const rows = await db.select().from(schema.messages).where(eq(schema.messages.toUserId, isolatedMinor.id));
    assert.equal(rows.length, 1);
  });
});

describe("notification engine", () => {
  test("rows from an isolated-pair actor are suppressed; staff actor lands", async () => {
    const fire = (userId: string, actorId: string, actorName: string) =>
      notifyCenter(db, io as never, {
        userId,
        category: "friend",
        kind: "friend_request",
        actor: { id: actorId, name: actorName },
        title: `${actorName} sent you a friend request`,
        push: false,
      });
    await fire(isolatedMinor.id, adult.id, adult.username);
    await fire(adult.id, isolatedMinor.id, isolatedMinor.username);
    await fire(isolatedMinor.id, staff.id, staff.username);

    const rowsFor = async (userId: string) =>
      db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
    const minorRows = await rowsFor(isolatedMinor.id);
    assert.equal(minorRows.some((r) => r.actorUserId === adult.id), false, "adult actor suppressed for the minor");
    assert.equal(minorRows.some((r) => r.actorUserId === staff.id), true, "staff actor lands");
    assert.equal((await rowsFor(adult.id)).some((r) => r.actorUserId === isolatedMinor.id), false);
  });
});

describe("inert at 18 end-to-end", () => {
  test("a stale flag on an of-age account hides nothing and nobody hides them", async () => {
    const agedOut = await createUser(db, { birthdate: exactly18Dob(), isolateFromAdults: true, username: "aged_out" });
    const agedOutH = auth(await tokenFor(db, agedOut.id));
    await insertMessage(db, { roomId, userId: agedOut.id, body: "aged out line" });

    const bodies = async (h: Record<string, string>) => {
      const res = await app.inject({ method: "GET", url: `/rooms/${roomId}/messages?before=${Date.now() + 1000}`, headers: h });
      return (res.json() as { messages: Array<{ body: string }> }).messages.map((m) => m.body);
    };
    assert.equal((await bodies(adultTokenH)).includes("aged out line"), true, "adults see the aged-out account");
    assert.equal((await bodies(agedOutH)).includes("adult line"), true, "the aged-out account sees adults");
  });
});
