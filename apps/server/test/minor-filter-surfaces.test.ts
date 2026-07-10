import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { ChatMessage } from "@thekeep/shared";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { SessionUser } from "../src/commands/types.js";
import { ensureSiteSettings } from "../src/settings.js";
import { rebuildMinorFilter } from "../src/realtime/minorLanguageFilter.js";
import {
  emitFiltered,
  pushTriggers,
  sendRoomBacklogTo,
} from "../src/realtime/broadcast/persistence.js";
import { notifyForumReply } from "../src/forums/notifications.js";
import { whisperCommand } from "../src/commands/builtins/whisper.js";
import { registerRoomsRoutes } from "../src/routes/rooms.js";
import { registerDirectMessageRoutes } from "../src/routes/directMessages.js";
import { registerMessageRoutes } from "../src/routes/messages.js";
import { registerSearchRoutes } from "../src/routes/search.js";
import { registerForumBoardRoutes } from "../src/routes/forums/boards.js";
import { unfurlAndAttach } from "../src/unfurl.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Per-surface coverage for the minor language filter (age plan Phase 7,
 * plan_ext.md §J). The matcher's contract lives in
 * minor-language-filter.test.ts; THESE tests pin the wiring — for every
 * read/emit surface:
 *
 *   - an under-18 viewer receives the masked variant ("well s***, that hurt"),
 *   - an adult viewer receives the ORIGINAL, and where the surface fans out
 *     a shared object, the exact same instance (byte-identical guarantee),
 *   - with the filter disabled, minors receive the original too (passthrough),
 *   - stored rows are never modified by any read.
 *
 * One shared in-memory DB + app across describes (node:test runs a file's
 * tests serially); every describe seeds its own rooms/messages with unique
 * bodies and asserts by id, so surfaces can't bleed into each other.
 */

/** A user who is 14 years old today, whatever today is. */
const MINOR_DOB = (() => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 14);
  return d.toISOString().slice(0, 10);
})();

const DIRTY = "well shit, that hurt";
const DIRTY_MASKED = "well s***, that hurt";
const DIRTY_TITLE = "the shit list";
const DIRTY_TITLE_MASKED = "the s*** list";
const CLEAN = "a perfectly nice sentence";

const FILTER_ON = { minorFilterEnabled: true, minorFilterTerms: [], minorFilterAllow: [] };
const FILTER_OFF = { minorFilterEnabled: false, minorFilterTerms: [], minorFilterAllow: [] };

/* ---------- fixtures ---------- */

const { db } = makeTestDb();

interface Emitted { event: string; payload: unknown }

/** Live-socket stand-in for both fan-out shapes (room + global). */
function fakeSocket(data: Record<string, unknown>) {
  const emitted: Emitted[] = [];
  return {
    data,
    rooms: new Set<string>(),
    emit(event: string, payload: unknown) { emitted.push({ event, payload }); },
    emitted,
  };
}
type FakeSocket = ReturnType<typeof fakeSocket>;

/** Swappable socket list + capture of room-wide `io.to(...).emit` broadcasts. */
const liveSockets: FakeSocket[] = [];
const broadcasts: Emitted[] = [];
const io = {
  fetchSockets: async () => liveSockets,
  in: (_band: string) => ({ fetchSockets: async () => liveSockets }),
  to: (_band: string) => ({
    emit(event: string, payload: unknown) { broadcasts.push({ event, payload }); },
  }),
};

function resetSockets(...sockets: FakeSocket[]): void {
  liveSockets.length = 0;
  liveSockets.push(...sockets);
  broadcasts.length = 0;
}

/** Everything delivered as `event` to this socket, including room broadcasts
 *  (which reach every socket in the band) — mechanism-independent. */
function deliveredTo(socket: FakeSocket, event: string): unknown[] {
  return [
    ...socket.emitted.filter((e) => e.event === event).map((e) => e.payload),
    ...broadcasts.filter((e) => e.event === event).map((e) => e.payload),
  ];
}

/** SessionUser-shaped snapshot for sockets / fan-out senders. */
function sessionOf(
  u: { id: string; username: string },
  opts: { minor?: boolean; role?: string } = {},
): SessionUser {
  return {
    id: u.id,
    username: u.username,
    role: opts.role ?? "user",
    activeCharacterId: null,
    birthdate: opts.minor ? MINOR_DOB : null,
    isAdult: !opts.minor,
    hideNsfw: false,
    isolateFromAdults: false,
    locale: null,
    displayName: u.username,
    chatColor: null,
  } as unknown as SessionUser;
}

async function createRoom(db2: Db, opts: { forumId?: string; name?: string } = {}): Promise<string> {
  const id = nanoid();
  await db2.insert(schema.rooms).values({
    id,
    name: opts.name ?? `room_${id.slice(0, 8)}`,
    type: "public",
    ...(opts.forumId ? { forumId: opts.forumId } : {}),
  });
  return id;
}

async function createMsg(db2: Db, opts: {
  roomId: string;
  userId: string;
  body: string;
  kind?: "say" | "whisper";
  title?: string;
  replyToId?: string;
  replyToBodySnippet?: string;
  createdAt?: Date;
  toUserId?: string;
}): Promise<string> {
  const id = nanoid();
  await db2.insert(schema.messages).values({
    id,
    roomId: opts.roomId,
    userId: opts.userId,
    displayName: "author",
    kind: opts.kind ?? "say",
    body: opts.body,
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.replyToId ? { replyToId: opts.replyToId } : {}),
    ...(opts.replyToBodySnippet ? { replyToBodySnippet: opts.replyToBodySnippet } : {}),
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    ...(opts.toUserId ? { toUserId: opts.toUserId } : {}),
  });
  return id;
}

function wireMsg(roomId: string, userId: string, body: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: nanoid(),
    roomId,
    userId,
    characterId: null,
    displayName: "author",
    kind: "say",
    body,
    color: null,
    createdAt: Date.now(),
    ...extra,
  };
}

let app: FastifyInstance;
let adult: { id: string; username: string };
let adult2: { id: string; username: string };
let minor: { id: string; username: string };
let adultTok: string;
let minorTok: string;

before(async () => {
  await ensureSiteSettings(db);
  adult = await createUser(db, { username: "adultuser" });
  adult2 = await createUser(db, { username: "adultsecond" });
  minor = await createUser(db, { username: "minoruser", birthdate: MINOR_DOB });
  adultTok = await tokenFor(db, adult.id);
  minorTok = await tokenFor(db, minor.id);

  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400);
      return reply.send({ error: "validation" });
    }
    throw err;
  });
  await registerRoomsRoutes(app, db, io as never);
  await registerDirectMessageRoutes(app, db, io as never);
  await registerMessageRoutes(app, db, io as never);
  await registerSearchRoutes(app, db);
  await registerForumBoardRoutes(app, db, io as never, "/tmp/spire-test-forums");
  await app.ready();
});

after(async () => { await app.close(); });

// Every test starts from the default config (enabled, no overlay); the
// disabled-passthrough cases flip it locally.
beforeEach(() => rebuildMinorFilter(FILTER_ON));

/* =========================================================
 *  Chat live fan-out (emitFiltered)
 * ========================================================= */

describe("emitFiltered (chat live fan-out)", () => {
  test("minor recipient gets a masked clone; adults get the shared original; the source object is untouched", async () => {
    const adultSock = fakeSocket({ userId: adult.id, user: sessionOf(adult) });
    const minorSock = fakeSocket({ userId: minor.id, user: sessionOf(minor, { minor: true }) });
    resetSockets(adultSock, minorSock);
    const msg = wireMsg("roomX", adult.id, DIRTY, {
      title: DIRTY_TITLE,
      replyToBodySnippet: DIRTY,
    });
    await emitFiltered(io as never, db, "roomX", sessionOf(adult), msg);

    const toAdult = deliveredTo(adultSock, "message:new");
    assert.equal(toAdult.length, 1);
    assert.equal(toAdult[0], msg, "adults receive the exact original instance");

    const toMinor = deliveredTo(minorSock, "message:new") as ChatMessage[];
    assert.equal(toMinor.length, 1);
    assert.notEqual(toMinor[0], msg, "minors receive a clone, never the shared object");
    assert.equal(toMinor[0]!.body, DIRTY_MASKED);
    assert.equal(toMinor[0]!.title, DIRTY_TITLE_MASKED);
    assert.equal(toMinor[0]!.replyToBodySnippet, DIRTY_MASKED);

    // The shared original was never mutated.
    assert.equal(msg.body, DIRTY);
    assert.equal(msg.title, DIRTY_TITLE);
  });

  test("no minors connected: zero masking, original delivered", async () => {
    const a1 = fakeSocket({ userId: adult.id, user: sessionOf(adult) });
    const a2 = fakeSocket({ userId: adult2.id, user: sessionOf(adult2) });
    resetSockets(a1, a2);
    const msg = wireMsg("roomX", adult.id, DIRTY);
    await emitFiltered(io as never, db, "roomX", sessionOf(adult), msg);
    for (const s of [a1, a2]) {
      const got = deliveredTo(s, "message:new");
      assert.equal(got.length, 1);
      assert.equal(got[0], msg);
    }
  });

  test("clean body with a minor present: fast path, everyone shares the original", async () => {
    const minorSock = fakeSocket({ userId: minor.id, user: sessionOf(minor, { minor: true }) });
    resetSockets(minorSock);
    const msg = wireMsg("roomX", adult.id, CLEAN);
    // A staff sender keeps the room-wide fast path (no isolation scan).
    await emitFiltered(io as never, db, "roomX", sessionOf(adult, { role: "mod" }), msg);
    assert.equal(broadcasts.length, 1, "clean message rides the single room broadcast");
    assert.equal(broadcasts[0]!.payload, msg);
  });

  test("disabled filter: minor receives the original (passthrough)", async () => {
    rebuildMinorFilter(FILTER_OFF);
    const minorSock = fakeSocket({ userId: minor.id, user: sessionOf(minor, { minor: true }) });
    resetSockets(minorSock);
    const msg = wireMsg("roomX", adult.id, DIRTY);
    await emitFiltered(io as never, db, "roomX", sessionOf(adult), msg);
    const got = deliveredTo(minorSock, "message:new");
    assert.equal(got.length, 1);
    assert.equal(got[0], msg);
  });
});

/* =========================================================
 *  Backlog on join (sendRoomBacklogTo)
 * ========================================================= */

describe("sendRoomBacklogTo (join backlog)", () => {
  let roomId: string;
  let dirtyId: string;
  before(async () => {
    roomId = await createRoom(db);
    dirtyId = await createMsg(db, {
      roomId,
      userId: adult.id,
      body: DIRTY,
      title: DIRTY_TITLE,
      replyToBodySnippet: DIRTY,
    });
  });

  async function backlogFor(viewerId: string): Promise<ChatMessage[]> {
    const sock = fakeSocket({});
    await sendRoomBacklogTo(sock as never, db, roomId, viewerId);
    const bulk = sock.emitted.find((e) => e.event === "message:bulk");
    assert.ok(bulk, "backlog emitted");
    return bulk!.payload as ChatMessage[];
  }

  test("minor viewer: body, title, and quote snippet masked", async () => {
    const row = (await backlogFor(minor.id)).find((m) => m.id === dirtyId);
    assert.ok(row);
    assert.equal(row!.body, DIRTY_MASKED);
    assert.equal(row!.title, DIRTY_TITLE_MASKED);
    assert.equal(row!.replyToBodySnippet, DIRTY_MASKED);
  });

  test("adult viewer: original", async () => {
    const row = (await backlogFor(adult.id)).find((m) => m.id === dirtyId);
    assert.equal(row!.body, DIRTY);
    assert.equal(row!.title, DIRTY_TITLE);
  });

  test("disabled filter: minor sees the original (passthrough)", async () => {
    rebuildMinorFilter(FILTER_OFF);
    const row = (await backlogFor(minor.id)).find((m) => m.id === dirtyId);
    assert.equal(row!.body, DIRTY);
  });

  test("stored row is never modified by masked reads", async () => {
    await backlogFor(minor.id);
    const stored = (await db.select().from(schema.messages))
      .find((m) => m.id === dirtyId);
    assert.equal(stored!.body, DIRTY);
    assert.equal(stored!.title, DIRTY_TITLE);
  });
});

/* =========================================================
 *  HTTP backlog routes (older pages + jump window)
 * ========================================================= */

describe("GET /rooms/:id/messages + /around", () => {
  let roomId: string;
  let dirtyId: string;
  before(async () => {
    roomId = await createRoom(db);
    dirtyId = await createMsg(db, {
      roomId,
      userId: adult.id,
      body: DIRTY,
      createdAt: new Date(Date.now() - 5_000),
    });
  });

  async function fetchOlder(tok: string): Promise<ChatMessage[]> {
    const res = await app.inject({
      method: "GET",
      url: `/rooms/${roomId}/messages?before=${Date.now() + 60_000}`,
      headers: auth(tok),
    });
    assert.equal(res.statusCode, 200);
    return (res.json() as { messages: ChatMessage[] }).messages;
  }

  async function fetchAround(tok: string): Promise<ChatMessage[]> {
    const res = await app.inject({
      method: "GET",
      url: `/rooms/${roomId}/messages/around?messageId=${dirtyId}`,
      headers: auth(tok),
    });
    assert.equal(res.statusCode, 200);
    return (res.json() as { messages: ChatMessage[] }).messages;
  }

  test("older pages: minor masked, adult original", async () => {
    const forMinor = (await fetchOlder(minorTok)).find((m) => m.id === dirtyId);
    assert.equal(forMinor!.body, DIRTY_MASKED);
    const forAdult = (await fetchOlder(adultTok)).find((m) => m.id === dirtyId);
    assert.equal(forAdult!.body, DIRTY);
  });

  test("jump window: minor masked, adult original", async () => {
    const forMinor = (await fetchAround(minorTok)).find((m) => m.id === dirtyId);
    assert.equal(forMinor!.body, DIRTY_MASKED);
    const forAdult = (await fetchAround(adultTok)).find((m) => m.id === dirtyId);
    assert.equal(forAdult!.body, DIRTY);
  });

  test("disabled filter: minor sees originals on both", async () => {
    rebuildMinorFilter(FILTER_OFF);
    assert.equal((await fetchOlder(minorTok)).find((m) => m.id === dirtyId)!.body, DIRTY);
    assert.equal((await fetchAround(minorTok)).find((m) => m.id === dirtyId)!.body, DIRTY);
  });
});

/* =========================================================
 *  Both searches
 * ========================================================= */

describe("search: per-room + server-wide", () => {
  let roomId: string;
  const nonce = `zqmark${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
  let body: string;
  before(async () => {
    roomId = await createRoom(db);
    body = `${nonce} shit ${nonce}`;
    await createMsg(db, {
      roomId,
      userId: adult.id,
      body,
      title: DIRTY_TITLE,
    });
  });

  async function roomSearch(tok: string): Promise<Array<{ snippet: string }>> {
    const res = await app.inject({
      method: "GET",
      url: `/rooms/${roomId}/messages/search?q=${nonce}`,
      headers: auth(tok),
    });
    assert.equal(res.statusCode, 200);
    return (res.json() as { hits: Array<{ snippet: string }> }).hits;
  }

  async function serverSearch(tok: string): Promise<Array<{ snippet: string; title?: string }>> {
    const res = await app.inject({
      method: "GET",
      url: `/search/messages?q=${nonce}`,
      headers: auth(tok),
    });
    assert.equal(res.statusCode, 200);
    return (res.json() as { hits: Array<{ snippet: string; title?: string }> }).hits;
  }

  test("per-room search: minor snippet masked, adult original", async () => {
    const forMinor = await roomSearch(minorTok);
    assert.ok(forMinor.length >= 1);
    assert.equal(forMinor[0]!.snippet, `${nonce} s*** ${nonce}`);
    const forAdult = await roomSearch(adultTok);
    assert.equal(forAdult[0]!.snippet, body);
  });

  test("server-wide search: minor snippet + topic title masked, adult original", async () => {
    const forMinor = await serverSearch(minorTok);
    assert.ok(forMinor.length >= 1);
    assert.equal(forMinor[0]!.snippet, `${nonce} s*** ${nonce}`);
    assert.equal(forMinor[0]!.title, DIRTY_TITLE_MASKED);
    const forAdult = await serverSearch(adultTok);
    assert.equal(forAdult[0]!.snippet, body);
    assert.equal(forAdult[0]!.title, DIRTY_TITLE);
  });

  test("disabled filter: minor sees originals in both searches", async () => {
    rebuildMinorFilter(FILTER_OFF);
    assert.equal((await roomSearch(minorTok))[0]!.snippet, body);
    const wide = await serverSearch(minorTok);
    assert.equal(wide[0]!.snippet, body);
    assert.equal(wide[0]!.title, DIRTY_TITLE);
  });
});

/* =========================================================
 *  Export (rendered log + embedded signed manifest)
 * ========================================================= */

describe("GET /rooms/:id/export", () => {
  let roomId: string;
  before(async () => {
    roomId = await createRoom(db);
    await createMsg(db, { roomId, userId: adult.id, body: DIRTY });
  });

  async function exportHtml(tok: string): Promise<string> {
    const res = await app.inject({
      method: "GET",
      url: `/rooms/${roomId}/export`,
      headers: auth(tok),
    });
    assert.equal(res.statusCode, 200);
    return res.body;
  }

  test("minor requester: masked in the log AND the embedded manifest", async () => {
    const html = await exportHtml(minorTok);
    assert.ok(html.includes(DIRTY_MASKED), "rendered body masked");
    assert.ok(!html.includes("shit"), "no original body anywhere in the file (manifest included)");
  });

  test("adult requester: original body", async () => {
    const html = await exportHtml(adultTok);
    assert.ok(html.includes(DIRTY));
  });

  test("disabled filter: minor export passes through", async () => {
    rebuildMinorFilter(FILTER_OFF);
    const html = await exportHtml(minorTok);
    assert.ok(html.includes(DIRTY));
  });
});

/* =========================================================
 *  Forum surfaces: topic list, thread reader, board cards
 * ========================================================= */

describe("forum topic list + thread reader (/rooms/:id/topics, .../thread)", () => {
  let roomId: string;
  let topicId: string;
  let replyId: string;
  before(async () => {
    roomId = await createRoom(db);
    topicId = await createMsg(db, {
      roomId,
      userId: adult.id,
      body: DIRTY,
      title: DIRTY_TITLE,
    });
    replyId = await createMsg(db, {
      roomId,
      userId: adult2.id,
      body: DIRTY,
      replyToId: topicId,
      replyToBodySnippet: DIRTY,
    });
  });

  async function topics(tok: string): Promise<ChatMessage[]> {
    const res = await app.inject({
      method: "GET",
      url: `/rooms/${roomId}/topics`,
      headers: auth(tok),
    });
    assert.equal(res.statusCode, 200);
    return (res.json() as { topics: ChatMessage[] }).topics;
  }

  async function thread(tok: string): Promise<{ topic: ChatMessage; replies: ChatMessage[] }> {
    const res = await app.inject({
      method: "GET",
      url: `/rooms/${roomId}/messages/${replyId}/thread`,
      headers: auth(tok),
    });
    assert.equal(res.statusCode, 200);
    return res.json() as { topic: ChatMessage; replies: ChatMessage[] };
  }

  test("topic list: minor sees masked title + body, adult the originals", async () => {
    const forMinor = (await topics(minorTok)).find((t) => t.id === topicId);
    assert.equal(forMinor!.title, DIRTY_TITLE_MASKED);
    assert.equal(forMinor!.body, DIRTY_MASKED);
    const forAdult = (await topics(adultTok)).find((t) => t.id === topicId);
    assert.equal(forAdult!.title, DIRTY_TITLE);
    assert.equal(forAdult!.body, DIRTY);
  });

  test("thread reader: minor sees masked topic + replies (incl. quote snippet), adult the originals", async () => {
    const forMinor = await thread(minorTok);
    assert.equal(forMinor.topic.title, DIRTY_TITLE_MASKED);
    assert.equal(forMinor.topic.body, DIRTY_MASKED);
    const reply = forMinor.replies.find((r) => r.id === replyId);
    assert.equal(reply!.body, DIRTY_MASKED);
    assert.equal(reply!.replyToBodySnippet, DIRTY_MASKED);
    const forAdult = await thread(adultTok);
    assert.equal(forAdult.topic.body, DIRTY);
    assert.equal(forAdult.replies.find((r) => r.id === replyId)!.body, DIRTY);
  });

  test("disabled filter: minor sees originals", async () => {
    rebuildMinorFilter(FILTER_OFF);
    const list = (await topics(minorTok)).find((t) => t.id === topicId);
    assert.equal(list!.title, DIRTY_TITLE);
    assert.equal((await thread(minorTok)).topic.body, DIRTY);
  });
});

describe("board topic cards (GET /forums/boards/:roomId/topics)", () => {
  let boardRoomId: string;
  let topicId: string;
  before(async () => {
    const forumId = nanoid();
    await db.insert(schema.forums).values({
      id: forumId,
      slug: `f${forumId.slice(0, 8).toLowerCase().replace(/[^a-z0-9_]/g, "_")}`,
      name: "Test Forum",
      ownerUserId: adult.id,
    });
    boardRoomId = await createRoom(db, { forumId });
    topicId = await createMsg(db, {
      roomId: boardRoomId,
      userId: adult.id,
      body: DIRTY,
      title: DIRTY_TITLE,
    });
  });

  async function cards(tok: string): Promise<Array<{ id: string; title: string; snippet: string }>> {
    const res = await app.inject({
      method: "GET",
      url: `/forums/boards/${boardRoomId}/topics`,
      headers: auth(tok),
    });
    assert.equal(res.statusCode, 200);
    return (res.json() as { topics: Array<{ id: string; title: string; snippet: string }> }).topics;
  }

  test("minor viewer: card title + snippet masked; adult original; disabled passthrough", async () => {
    const forMinor = (await cards(minorTok)).find((t) => t.id === topicId);
    assert.equal(forMinor!.title, DIRTY_TITLE_MASKED);
    assert.equal(forMinor!.snippet, DIRTY_MASKED);
    const forAdult = (await cards(adultTok)).find((t) => t.id === topicId);
    assert.equal(forAdult!.title, DIRTY_TITLE);
    assert.equal(forAdult!.snippet, DIRTY);
    rebuildMinorFilter(FILTER_OFF);
    const off = (await cards(minorTok)).find((t) => t.id === topicId);
    assert.equal(off!.title, DIRTY_TITLE);
    assert.equal(off!.snippet, DIRTY);
  });
});

/* =========================================================
 *  Whisper emit path
 * ========================================================= */

describe("whisper emit path", () => {
  let roomId: string;
  before(async () => {
    roomId = await createRoom(db);
  });

  async function whisper(
    from: { id: string; username: string },
    fromMinor: boolean,
    toUsername: string,
    text: string,
  ): Promise<void> {
    const ctx = {
      db,
      io,
      roomId,
      user: sessionOf(from, { minor: fromMinor }),
      args: [toUsername, ...text.split(" ")],
      argsText: `${toUsername} ${text}`,
      socket: fakeSocket({}),
      registry: new Map(),
    };
    await whisperCommand.run(ctx as never);
  }

  test("minor recipient reads it masked; adult sender's echo stays original", async () => {
    const senderSock = fakeSocket({ userId: adult.id, roomId, user: sessionOf(adult) });
    const targetSock = fakeSocket({ userId: minor.id, roomId, user: sessionOf(minor, { minor: true }) });
    resetSockets(senderSock, targetSock);
    await whisper(adult, false, minor.username, DIRTY);
    const echo = deliveredTo(senderSock, "message:new") as ChatMessage[];
    assert.equal(echo.length, 1);
    assert.equal(echo[0]!.body, DIRTY, "adult sender echo unmasked");
    const got = deliveredTo(targetSock, "message:new") as ChatMessage[];
    assert.equal(got.length, 1);
    assert.equal(got[0]!.body, DIRTY_MASKED, "minor recipient masked");
  });

  test("minor sender's own echo is masked; adult recipient reads the original", async () => {
    const senderSock = fakeSocket({ userId: minor.id, roomId, user: sessionOf(minor, { minor: true }) });
    const targetSock = fakeSocket({ userId: adult.id, roomId, user: sessionOf(adult) });
    resetSockets(senderSock, targetSock);
    await whisper(minor, true, adult.username, DIRTY);
    assert.equal((deliveredTo(senderSock, "message:new") as ChatMessage[])[0]!.body, DIRTY_MASKED);
    assert.equal((deliveredTo(targetSock, "message:new") as ChatMessage[])[0]!.body, DIRTY);
  });

  test("disabled filter: minor recipient reads the original", async () => {
    rebuildMinorFilter(FILTER_OFF);
    const targetSock = fakeSocket({ userId: minor.id, roomId, user: sessionOf(minor, { minor: true }) });
    resetSockets(targetSock);
    await whisper(adult, false, minor.username, DIRTY);
    assert.equal((deliveredTo(targetSock, "message:new") as ChatMessage[])[0]!.body, DIRTY);
  });
});

/* =========================================================
 *  message:update fan-out (edits, unfurl, cross-room whisper)
 * ========================================================= */

describe("message:update (emitMessageUpdate + whisper-edit overlay)", () => {
  let roomId: string;
  before(async () => {
    roomId = await createRoom(db);
  });

  /** Every `message:update` this socket saw (direct + room broadcast). */
  function updatesFor(sock: FakeSocket): ChatMessage[] {
    return deliveredTo(sock, "message:update") as ChatMessage[];
  }

  test("edit that introduces profanity: minor masked, adult original, no room-wide raw broadcast", async () => {
    const adultSock = fakeSocket({ userId: adult.id, user: sessionOf(adult) });
    const minorSock = fakeSocket({ userId: minor.id, user: sessionOf(minor, { minor: true }) });
    resetSockets(adultSock, minorSock);
    const msgId = await createMsg(db, { roomId, userId: adult.id, body: CLEAN });

    const res = await app.inject({
      method: "PATCH",
      url: `/messages/${msgId}`,
      headers: auth(adultTok),
      payload: { body: DIRTY },
    });
    assert.equal(res.statusCode, 200);

    // With a minor connected the update must go per-socket: a room-wide
    // broadcast would land the ORIGINAL on the minor (the pre-fix leak).
    assert.equal(broadcasts.filter((e) => e.event === "message:update").length, 0);
    const toAdult = adultSock.emitted.filter((e) => e.event === "message:update")
      .map((e) => e.payload as ChatMessage);
    assert.equal(toAdult.length, 1);
    assert.equal(toAdult[0]!.body, DIRTY, "adult receives the original edit");
    const toMinor = minorSock.emitted.filter((e) => e.event === "message:update")
      .map((e) => e.payload as ChatMessage);
    assert.equal(toMinor.length, 1);
    assert.equal(toMinor[0]!.body, DIRTY_MASKED, "minor receives the masked edit");

    // The stored row keeps what the author wrote.
    const stored = (await db.select().from(schema.messages)).find((m) => m.id === msgId);
    assert.equal(stored!.body, DIRTY);
  });

  test("unfurl attach: the follow-up update still carries the masked body for the minor", async () => {
    const adultSock = fakeSocket({ userId: adult.id, user: sessionOf(adult) });
    const minorSock = fakeSocket({ userId: minor.id, user: sessionOf(minor, { minor: true }) });
    resetSockets(adultSock, minorSock);

    // Pre-seed the unfurl cache so no network fetch happens; unfurlAndAttach
    // then attaches the card and re-broadcasts the row — the exact zero-user-
    // action sequence that used to replace the minor's masked line with the
    // original 1-2s after send.
    const url = `https://example.test/${nanoid(8)}`;
    await db.insert(schema.ogUnfurlCache).values({
      url,
      json: JSON.stringify({ url, title: "Example page" }),
      fetchedAt: new Date(),
    });
    const body = `${DIRTY} ${url}`;
    const msgId = await createMsg(db, { roomId, userId: adult.id, body });

    await unfurlAndAttach(db, io as never, { messageId: msgId, roomId, kind: "say", body });

    assert.equal(broadcasts.filter((e) => e.event === "message:update").length, 0);
    const toMinor = minorSock.emitted.filter((e) => e.event === "message:update")
      .map((e) => e.payload as ChatMessage);
    assert.equal(toMinor.length, 1);
    assert.ok(toMinor[0]!.body.startsWith(DIRTY_MASKED), "minor body stays masked on the unfurl update");
    assert.ok(!toMinor[0]!.body.includes("shit"), "no original profanity for the minor");
    assert.equal(toMinor[0]!.linkPreview?.url, url, "the card still attaches for the minor");
    const toAdult = adultSock.emitted.filter((e) => e.event === "message:update")
      .map((e) => e.payload as ChatMessage);
    assert.equal(toAdult[0]!.body, body, "adult receives the original with the card");
  });

  test("whisper edit: the cross-room minor recipient reads every update masked", async () => {
    // Recipient is viewing from ANOTHER room, so the overlay loop (not the
    // room fan-out) is what reaches them.
    const minorSock = fakeSocket({
      userId: minor.id,
      roomId: "somewhere-else",
      user: sessionOf(minor, { minor: true }),
    });
    resetSockets(minorSock);
    const msgId = await createMsg(db, {
      roomId,
      userId: adult.id,
      kind: "whisper",
      toUserId: minor.id,
      body: CLEAN,
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/messages/${msgId}`,
      headers: auth(adultTok),
      payload: { body: DIRTY },
    });
    assert.equal(res.statusCode, 200);

    const toMinor = updatesFor(minorSock).filter((m) => m.id === msgId);
    assert.ok(toMinor.length >= 1, "overlay delivered the update to the cross-room recipient");
    for (const m of toMinor) {
      assert.equal(m.body, DIRTY_MASKED, "every delivery to the minor is masked");
    }
  });

  test("disabled filter: the minor receives the original update (passthrough)", async () => {
    rebuildMinorFilter(FILTER_OFF);
    const minorSock = fakeSocket({ userId: minor.id, user: sessionOf(minor, { minor: true }) });
    resetSockets(minorSock);
    const msgId = await createMsg(db, { roomId, userId: adult.id, body: CLEAN });
    const res = await app.inject({
      method: "PATCH",
      url: `/messages/${msgId}`,
      headers: auth(adultTok),
      payload: { body: DIRTY },
    });
    assert.equal(res.statusCode, 200);
    const got = updatesFor(minorSock).filter((m) => m.id === msgId);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.body, DIRTY);
  });
});

/* =========================================================
 *  Message delete fan-out (DELETE /messages/:id)
 * ========================================================= */

describe("message delete fan-out", () => {
  let roomId: string;
  before(async () => {
    roomId = await createRoom(db);
  });

  function updatesFor(sock: FakeSocket): ChatMessage[] {
    return deliveredTo(sock, "message:update") as ChatMessage[];
  }

  test("unstamped row: minor gets the masked wire (title), adult the original; body strips for both", async () => {
    const adultSock = fakeSocket({ userId: adult.id, user: sessionOf(adult) });
    const minorSock = fakeSocket({ userId: minor.id, user: sessionOf(minor, { minor: true }) });
    resetSockets(adultSock, minorSock);
    const msgId = await createMsg(db, { roomId, userId: adult.id, body: DIRTY, title: DIRTY_TITLE });

    const res = await app.inject({ method: "DELETE", url: `/messages/${msgId}`, headers: auth(adultTok) });
    assert.equal(res.statusCode, 200);

    const toAdult = updatesFor(adultSock).filter((m) => m.id === msgId);
    assert.equal(toAdult.length, 1);
    assert.equal(toAdult[0]!.title, DIRTY_TITLE, "adult keeps the original title");
    assert.equal(toAdult[0]!.body, "", "deleted wire strips the body for end users");
    const toMinor = updatesFor(minorSock).filter((m) => m.id === msgId);
    assert.equal(toMinor.length, 1);
    assert.equal(toMinor[0]!.title, DIRTY_TITLE_MASKED, "minor reads the masked title");
  });

  test("18+-stamped row: the delete update is withheld from minor sockets entirely", async () => {
    // A row stamped while its room was 18+, deleted after the room flipped
    // back SFW with a minor legitimately present: same stamped-row posture
    // as emitMessageUpdate — the update (title, reply snippet) never
    // crosses to a non-adult socket at all.
    const adultSock = fakeSocket({ userId: adult.id, user: sessionOf(adult) });
    const minorSock = fakeSocket({ userId: minor.id, user: sessionOf(minor, { minor: true }) });
    resetSockets(adultSock, minorSock);
    const msgId = await createMsg(db, { roomId, userId: adult.id, body: DIRTY, title: DIRTY_TITLE });
    await db.update(schema.messages).set({ isNsfw: true }).where(eq(schema.messages.id, msgId));

    const res = await app.inject({ method: "DELETE", url: `/messages/${msgId}`, headers: auth(adultTok) });
    assert.equal(res.statusCode, 200);

    const toAdult = updatesFor(adultSock).filter((m) => m.id === msgId);
    assert.equal(toAdult.length, 1, "adults still hear about the deletion");
    assert.equal(
      updatesFor(minorSock).filter((m) => m.id === msgId).length,
      0,
      "no message:update for the stamped row reaches a minor socket",
    );
  });
});

/* =========================================================
 *  DMs: live fan-out, echoes, history, previews, snippets
 * ========================================================= */

describe("direct messages", () => {
  test("adult → minor: recipient sockets masked, sender echo + response original; inbox snippet masked", async () => {
    const senderSock = fakeSocket({ userId: adult.id, user: sessionOf(adult) });
    const recipientSock = fakeSocket({ userId: minor.id, user: sessionOf(minor, { minor: true }) });
    resetSockets(senderSock, recipientSock);

    const res = await app.inject({
      method: "POST",
      url: `/me/dms/with/${minor.id}/messages`,
      headers: auth(adultTok),
      payload: { body: DIRTY },
    });
    assert.equal(res.statusCode, 201);
    const sent = res.json() as { message: { id: string; body: string }; conversationId: string };
    assert.equal(sent.message.body, DIRTY, "adult sender's HTTP echo original");

    const toSender = deliveredTo(senderSock, "dm:new") as Array<{ message: { body: string } }>;
    assert.equal(toSender[0]!.message.body, DIRTY);
    const toMinor = deliveredTo(recipientSock, "dm:new") as Array<{ message: { body: string } }>;
    assert.equal(toMinor[0]!.message.body, DIRTY_MASKED);

    // Notification Center row for the minor recipient persists MASKED.
    const rows = await db.select().from(schema.notifications);
    const dmRow = rows.find((r) => r.userId === minor.id && r.kind === "dm");
    assert.ok(dmRow, "dm notification row written");
    assert.ok(dmRow!.snippet!.includes("s***"));
    assert.ok(!dmRow!.snippet!.includes("shit"));

    // History: the minor reads the thread masked, the adult original.
    const minorHistory = await app.inject({
      method: "GET",
      url: `/me/dms/${sent.conversationId}/messages`,
      headers: auth(minorTok),
    });
    assert.equal(minorHistory.statusCode, 200);
    const minorPage = (minorHistory.json() as { messages: Array<{ id: string; body: string }> }).messages;
    assert.equal(minorPage.find((m) => m.id === sent.message.id)!.body, DIRTY_MASKED);

    const adultHistory = await app.inject({
      method: "GET",
      url: `/me/dms/${sent.conversationId}/messages`,
      headers: auth(adultTok),
    });
    const adultPage = (adultHistory.json() as { messages: Array<{ id: string; body: string }> }).messages;
    assert.equal(adultPage.find((m) => m.id === sent.message.id)!.body, DIRTY);

    // Conversation-list preview masks for the minor.
    const list = await app.inject({ method: "GET", url: "/me/dms", headers: auth(minorTok) });
    const convs = (list.json() as { conversations: Array<{ id: string; lastMessagePreview: string | null }> }).conversations;
    const conv = convs.find((c) => c.id === sent.conversationId);
    assert.ok(conv!.lastMessagePreview!.includes("s***"));
    assert.ok(!conv!.lastMessagePreview!.includes("shit"));

    // The stored DM row keeps what the author wrote.
    const stored = (await db.select().from(schema.directMessages))
      .find((m) => m.id === sent.message.id);
    assert.equal(stored!.body, DIRTY);

    // Disabled filter: the minor reads the original (passthrough).
    rebuildMinorFilter(FILTER_OFF);
    const offHistory = await app.inject({
      method: "GET",
      url: `/me/dms/${sent.conversationId}/messages`,
      headers: auth(minorTok),
    });
    const offPage = (offHistory.json() as { messages: Array<{ id: string; body: string }> }).messages;
    assert.equal(offPage.find((m) => m.id === sent.message.id)!.body, DIRTY);
  });

  test("minor sender: own HTTP echo + socket echo masked; edit fan-out masks for the minor side", async () => {
    const minorSock = fakeSocket({ userId: minor.id, user: sessionOf(minor, { minor: true }) });
    const adultSock = fakeSocket({ userId: adult2.id, user: sessionOf(adult2) });
    resetSockets(minorSock, adultSock);

    const res = await app.inject({
      method: "POST",
      url: `/me/dms/with/${adult2.id}/messages`,
      headers: auth(minorTok),
      payload: { body: DIRTY },
    });
    assert.equal(res.statusCode, 201);
    const sent = res.json() as { message: { id: string; body: string }; conversationId: string };
    assert.equal(sent.message.body, DIRTY_MASKED, "minor sender's HTTP echo masked");
    assert.equal(
      (deliveredTo(minorSock, "dm:new") as Array<{ message: { body: string } }>)[0]!.message.body,
      DIRTY_MASKED,
    );
    assert.equal(
      (deliveredTo(adultSock, "dm:new") as Array<{ message: { body: string } }>)[0]!.message.body,
      DIRTY,
      "adult recipient reads the original",
    );

    // Edit: profanity edited INTO the message must not reach the minor raw.
    resetSockets(minorSock, adultSock);
    minorSock.emitted.length = 0;
    adultSock.emitted.length = 0;
    const edited = await app.inject({
      method: "PATCH",
      url: `/me/dms/messages/${sent.message.id}`,
      headers: auth(minorTok),
      payload: { body: `${DIRTY} again` },
    });
    assert.equal(edited.statusCode, 200);
    assert.equal((edited.json() as { message: { body: string } }).message.body, `${DIRTY_MASKED} again`);
    assert.equal(
      (deliveredTo(minorSock, "dm:update") as Array<{ message: { body: string } }>)[0]!.message.body,
      `${DIRTY_MASKED} again`,
    );
    assert.equal(
      (deliveredTo(adultSock, "dm:update") as Array<{ message: { body: string } }>)[0]!.message.body,
      `${DIRTY} again`,
    );
  });
});

/* =========================================================
 *  Notification snippet writers
 * ========================================================= */

describe("chat mention snippet (pushTriggers)", () => {
  let roomId: string;
  before(async () => {
    roomId = await createRoom(db);
  });

  test("minor recipient's inbox row is written masked; adult's original", async () => {
    resetSockets();
    const msg = wireMsg(roomId, adult.id, `hey you ${DIRTY}`, {
      mentions: [
        { name: minor.username, userId: minor.id, characterId: null },
        { name: adult2.username, userId: adult2.id, characterId: null },
      ],
    });
    await pushTriggers(io as never, db, msg, sessionOf(adult), "say");
    const rows = (await db.select().from(schema.notifications))
      .filter((r) => r.kind === "chat_mention" && r.metadataJson?.includes(msg.id));
    const minorRow = rows.find((r) => r.userId === minor.id);
    const adultRow = rows.find((r) => r.userId === adult2.id);
    assert.ok(minorRow && adultRow, "both mention rows written");
    assert.equal(minorRow!.snippet, `hey you ${DIRTY_MASKED}`);
    assert.equal(adultRow!.snippet, `hey you ${DIRTY}`);
  });

  test("disabled filter: minor's row passes through", async () => {
    rebuildMinorFilter(FILTER_OFF);
    resetSockets();
    // Fresh room: the engine dedupes by (room, sender) inside a 2-minute
    // window, so reusing the first test's room would suppress this row.
    const room2 = await createRoom(db);
    const msg = wireMsg(room2, adult.id, `ping two ${DIRTY}`, {
      mentions: [{ name: minor.username, userId: minor.id, characterId: null }],
    });
    await pushTriggers(io as never, db, msg, sessionOf(adult), "say");
    const row = (await db.select().from(schema.notifications))
      .find((r) => r.kind === "chat_mention" && r.userId === minor.id && r.metadataJson?.includes(msg.id));
    assert.equal(row!.snippet, `ping two ${DIRTY}`);
  });
});

describe("forum reply notification writer (notifyForumReply)", () => {
  let forumId: string;
  let boardRoomId: string;
  let topicId: string;

  before(async () => {
    forumId = nanoid();
    await db.insert(schema.forums).values({
      id: forumId,
      slug: `n${forumId.slice(0, 8).toLowerCase().replace(/[^a-z0-9_]/g, "_")}`,
      name: "Notify Forum",
      ownerUserId: adult.id,
    });
    boardRoomId = await createRoom(db, { forumId });
    // Topic authored by adult2 (gets a "reply" row); the minor watches it.
    topicId = await createMsg(db, {
      roomId: boardRoomId,
      userId: adult2.id,
      body: CLEAN,
      title: DIRTY_TITLE,
    });
    await db.insert(schema.forumTopicWatches).values({ userId: minor.id, topicId });
  });

  test("minor recipient's row persists masked title + snippet; adult's row is original", async () => {
    resetSockets();
    const replyId = await createMsg(db, {
      roomId: boardRoomId,
      userId: adult.id,
      body: DIRTY,
      replyToId: topicId,
    });
    await notifyForumReply(db, io as never, {
      forumId,
      boardRoomId,
      topic: { id: topicId, userId: adult2.id, title: DIRTY_TITLE },
      messageId: replyId,
      body: DIRTY,
      actor: { id: adult.id, displayName: adult.username },
    });
    const rows = (await db.select().from(schema.forumNotifications))
      .filter((r) => r.messageId === replyId);
    const minorRow = rows.find((r) => r.userId === minor.id);
    const adultRow = rows.find((r) => r.userId === adult2.id);
    assert.ok(minorRow && adultRow, "watch + reply rows written");
    assert.equal(minorRow!.snippet, DIRTY_MASKED);
    assert.equal(minorRow!.topicTitle, DIRTY_TITLE_MASKED);
    assert.equal(adultRow!.snippet, DIRTY);
    assert.equal(adultRow!.topicTitle, DIRTY_TITLE);
  });

  test("disabled filter: minor's row passes through", async () => {
    rebuildMinorFilter(FILTER_OFF);
    resetSockets();
    const replyId = await createMsg(db, {
      roomId: boardRoomId,
      userId: adult.id,
      body: DIRTY,
      replyToId: topicId,
    });
    await notifyForumReply(db, io as never, {
      forumId,
      boardRoomId,
      topic: { id: topicId, userId: adult2.id, title: DIRTY_TITLE },
      messageId: replyId,
      body: DIRTY,
      actor: { id: adult.id, displayName: adult.username },
    });
    const row = (await db.select().from(schema.forumNotifications))
      .find((r) => r.messageId === replyId && r.userId === minor.id);
    assert.equal(row!.snippet, DIRTY);
    assert.equal(row!.topicTitle, DIRTY_TITLE);
  });
});
