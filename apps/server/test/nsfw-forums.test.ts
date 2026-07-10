import "./helpers/env.js";
import { tmpdir } from "node:os";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { CommandContext, SessionUser } from "../src/commands/types.js";
import { boardAgeDenied, effectiveBoardNsfw, forumIsNsfw, nsfwForumIds } from "../src/forums/nsfw.js";
import { notifyForumReply, listForumNotifications, unreadForumNotifications } from "../src/forums/notifications.js";
import { addMessage } from "../src/realtime/broadcast.js";
import { registerRoomsRoutes } from "../src/routes/rooms.js";
import { registerMessageRoutes } from "../src/routes/messages.js";
import { registerForumCatalogRoutes } from "../src/routes/forums/catalog.js";
import { registerForumBoardRoutes } from "../src/routes/forums/boards.js";
import { registerForumTopicRoutes } from "../src/routes/forums/topics.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Phase 3 forum gates (age-restriction plan): the NSFW topic tag (compose
 * stamp + reply inheritance + the re-tag route with its retro-stamp), the
 * SOFT list filters and HARD thread gate, whole-18+-forum hiding across
 * catalog/discover/detail/boards, notification write-skip + read-time
 * re-filter, and the per-room-search members-only-board bugfix (§I1).
 *
 * Viewer matrix per plan_ext §F: anon / minor / adult / adult+hidePref.
 */

const MINOR_DOB = "2012-01-01";
const ADULT_DOB = "1990-01-01";

/* ── Fake socket.io: enough surface for addMessage's fan-out + the route
 *    handlers (fetchSockets, in(band), to(band), emit). ─────────────────── */

class FakeSocket {
  id = nanoid();
  rooms = new Set<string>();
  data: Record<string, unknown> = {};
  emitted: Array<{ event: string; payload: unknown }> = [];
  emit(event: string, payload?: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }
  join(band: string): void { this.rooms.add(band); }
  leave(band: string): void { this.rooms.delete(band); }
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
    emit() { /* global no-op */ },
  };
}

function sessionUserFor(
  u: { id: string; username: string },
  opts: { birthdate: string | null },
): SessionUser {
  return {
    id: u.id,
    username: u.username,
    role: "user",
    activeCharacterId: null,
    birthdate: opts.birthdate,
    isAdult: opts.birthdate === null || opts.birthdate <= "2007-12-31",
    hideNsfw: false,
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

/** Synthetic CommandContext for addMessage (the forum:post shape). */
function ctxFor(db: Db, user: SessionUser, roomId: string): CommandContext {
  return {
    db,
    io: makeFakeIo(),
    socket: new FakeSocket() as never,
    user,
    roomId,
    argsText: "",
    args: [],
    invokedAs: "",
    registry: {} as never,
  } as CommandContext;
}

async function insertForum(
  db: Db,
  opts: { name: string; ownerUserId: string; isNsfw?: boolean; publicBrowsing?: boolean; sfwBannerUrl?: string | null; bannerImageUrl?: string | null; tagline?: string },
): Promise<string> {
  const id = nanoid();
  await db.insert(schema.forums).values({
    id,
    slug: opts.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
    name: opts.name,
    ownerUserId: opts.ownerUserId,
    isNsfw: opts.isNsfw ?? false,
    publicBrowsing: opts.publicBrowsing ?? false,
    ...(opts.sfwBannerUrl !== undefined ? { sfwBannerUrl: opts.sfwBannerUrl } : {}),
    ...(opts.bannerImageUrl !== undefined ? { bannerImageUrl: opts.bannerImageUrl } : {}),
    ...(opts.tagline !== undefined ? { tagline: opts.tagline } : {}),
  });
  return id;
}

async function insertBoard(
  db: Db,
  opts: { name: string; forumId: string; ownerId: string; isNsfw?: boolean; membersOnly?: boolean },
): Promise<string> {
  const id = nanoid();
  await db.insert(schema.rooms).values({
    id,
    name: opts.name,
    slug: opts.name.toLowerCase(),
    type: "public",
    ownerId: opts.ownerId,
    replyMode: "nested",
    forumId: opts.forumId,
    isNsfw: opts.isNsfw ?? false,
    forumMembersOnly: opts.membersOnly ?? false,
  });
  return id;
}

async function insertTopic(
  db: Db,
  opts: { roomId: string; userId: string; title: string; body?: string; isNsfw?: boolean; categoryId?: string | null },
): Promise<string> {
  const id = nanoid();
  await db.insert(schema.messages).values({
    id,
    roomId: opts.roomId,
    userId: opts.userId,
    characterId: null,
    displayName: "author",
    kind: "say",
    body: opts.body ?? `${opts.title} body`,
    title: opts.title,
    isNsfw: opts.isNsfw ?? false,
    threadCategoryId: opts.categoryId ?? null,
    lastActivityAt: new Date(),
  });
  return id;
}

async function insertReply(
  db: Db,
  opts: { roomId: string; userId: string; topicId: string; body: string; isNsfw?: boolean },
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
    replyToId: opts.topicId,
    isNsfw: opts.isNsfw ?? false,
  });
  return id;
}

let db: Db;
let app: FastifyInstance;
let owner: { id: string; username: string };   // adult forum owner
let adult: { id: string; username: string };
let hidePrefAdult: { id: string; username: string };
let minor: { id: string; username: string };
let ownerToken: string;
let adultToken: string;
let hidePrefToken: string;
let minorToken: string;
let forumId: string;          // all-ages forum, public browsing ON
let boardId: string;          // its open board
let sfwTopicId: string;
let nsfwTopicId: string;
let nsfwReplyId: string;
let adultForumId: string;     // whole-forum 18+, public browsing ON
let adultBoardId: string;

before(async () => {
  db = makeTestDb().db;
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) { reply.code(400); return reply.send({ error: "validation" }); }
    throw err;
  });
  const io = makeFakeIo();
  await registerRoomsRoutes(app, db, io);
  await registerMessageRoutes(app, db, io);
  await registerForumCatalogRoutes(app, db, io);
  await registerForumBoardRoutes(app, db, io, tmpdir());
  await registerForumTopicRoutes(app, db);
  await app.ready();

  owner = await createUser(db, { birthdate: ADULT_DOB });
  adult = await createUser(db, { birthdate: ADULT_DOB });
  hidePrefAdult = await createUser(db, { birthdate: ADULT_DOB, hideNsfw: true });
  minor = await createUser(db, { birthdate: MINOR_DOB });
  ownerToken = await tokenFor(db, owner.id);
  adultToken = await tokenFor(db, adult.id);
  hidePrefToken = await tokenFor(db, hidePrefAdult.id);
  minorToken = await tokenFor(db, minor.id);

  forumId = await insertForum(db, { name: "Common Hall", ownerUserId: owner.id, publicBrowsing: true });
  boardId = await insertBoard(db, { name: "OpenBoard", forumId, ownerId: owner.id });
  sfwTopicId = await insertTopic(db, { roomId: boardId, userId: adult.id, title: "All ages topic" });
  nsfwTopicId = await insertTopic(db, { roomId: boardId, userId: adult.id, title: "Adults only topic", isNsfw: true });
  nsfwReplyId = await insertReply(db, { roomId: boardId, userId: adult.id, topicId: nsfwTopicId, body: "grown up reply", isNsfw: true });

  adultForumId = await insertForum(db, {
    name: "Velvet Hall",
    ownerUserId: owner.id,
    isNsfw: true,
    publicBrowsing: true,
    tagline: "adults only tagline",
    bannerImageUrl: "/uploads/forums/real-banner.png",
    sfwBannerUrl: "/uploads/forums/safe-banner.png",
  });
  adultBoardId = await insertBoard(db, { name: "VelvetBoard", forumId: adultForumId, ownerId: owner.id });
  await insertTopic(db, { roomId: adultBoardId, userId: adult.id, title: "Velvet topic" });
});

describe("forum rating helpers", () => {
  test("effectiveBoardNsfw folds the parent forum's flag over the room tier", async () => {
    assert.equal(await forumIsNsfw(db, adultForumId), true);
    assert.equal(await forumIsNsfw(db, forumId), false);
    assert.equal(await forumIsNsfw(db, null), false);
    assert.equal(await effectiveBoardNsfw(db, { isNsfw: false, serverId: null, forumId: adultForumId }), true);
    assert.equal(await effectiveBoardNsfw(db, { isNsfw: false, serverId: null, forumId }), false);
    assert.equal(await effectiveBoardNsfw(db, { isNsfw: true, serverId: null, forumId }), true);
    const set = await nsfwForumIds(db);
    assert.equal(set.has(adultForumId), true);
    assert.equal(set.has(forumId), false);
  });

  test("boardAgeDenied: minors and anonymous denied, adults pass", async () => {
    const board = { isNsfw: false, serverId: null, forumId: adultForumId };
    assert.equal(await boardAgeDenied(db, null, board), true);
    assert.equal(await boardAgeDenied(db, { isAdult: false }, board), true);
    assert.equal(await boardAgeDenied(db, { isAdult: true }, board), false);
  });
});

describe("compose-time stamp + reply inheritance (addMessage)", () => {
  test("a tagged topic persists is_nsfw = 1; its replies inherit at insert", async () => {
    const author = sessionUserFor(adult, { birthdate: ADULT_DOB });
    const topicId = await addMessage(ctxFor(db, author, boardId), {
      kind: "say",
      body: "spicy prose",
      title: "Composed NSFW",
      isNsfw: true,
    });
    assert.ok(topicId);
    const topicRow = (await db.select().from(schema.messages).where(eq(schema.messages.id, topicId!)).limit(1))[0]!;
    assert.equal(topicRow.isNsfw, true);

    const replyId = await addMessage(ctxFor(db, author, boardId), {
      kind: "say",
      body: "a reply in an all ages room",
      replyToId: topicId!,
    });
    assert.ok(replyId);
    const replyRow = (await db.select().from(schema.messages).where(eq(schema.messages.id, replyId!)).limit(1))[0]!;
    assert.equal(replyRow.isNsfw, true, "reply inherits max(room flag, topic flag)");
  });

  test("an untagged topic in an all-ages board stays unstamped", async () => {
    const author = sessionUserFor(adult, { birthdate: ADULT_DOB });
    const topicId = await addMessage(ctxFor(db, author, boardId), {
      kind: "say",
      body: "plain prose",
      title: "Composed SFW",
    });
    assert.ok(topicId);
    const row = (await db.select().from(schema.messages).where(eq(schema.messages.id, topicId!)).limit(1))[0]!;
    assert.equal(row.isNsfw, false);
  });
});

describe("PATCH /messages/:id/nsfw (the re-tag route)", () => {
  test("adult author tags own topic; replies retro-stamp; clearing never lowers reply stamps", async () => {
    const tId = await insertTopic(db, { roomId: boardId, userId: adult.id, title: "Retag me" });
    const rId = await insertReply(db, { roomId: boardId, userId: owner.id, topicId: tId, body: "child" });

    const on = await app.inject({ method: "PATCH", url: `/messages/${tId}/nsfw`, headers: auth(adultToken), payload: { nsfw: true } });
    assert.equal(on.statusCode, 200);
    assert.equal((on.json() as { isNsfw: boolean }).isNsfw, true);
    const child = (await db.select().from(schema.messages).where(eq(schema.messages.id, rId)).limit(1))[0]!;
    assert.equal(child.isNsfw, true, "children retro-stamped on tag");

    const off = await app.inject({ method: "PATCH", url: `/messages/${tId}/nsfw`, headers: auth(adultToken), payload: { nsfw: false } });
    assert.equal(off.statusCode, 200);
    const topicAfter = (await db.select().from(schema.messages).where(eq(schema.messages.id, tId)).limit(1))[0]!;
    assert.equal(topicAfter.isNsfw, false, "the topic's own tag clears (all-ages room)");
    // Reply stamps are NEVER lowered: is_nsfw on a reply doubles as the
    // write-time era stamp (18+-era rows in a flipped-back room), and the
    // route can't tell a tag-inherited stamp from an era stamp — so a clear
    // keeps children over-hidden rather than erasing era protection.
    const childAfter = (await db.select().from(schema.messages).where(eq(schema.messages.id, rId)).limit(1))[0]!;
    assert.equal(childAfter.isNsfw, true, "children keep their stamp on clear (era stamps never lowered)");

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "topic_nsfw_update"));
    assert.equal(audits.length >= 2, true, "both flips audited");
  });

  test("minors can never set or clear the tag, even on their own topic", async () => {
    const mineId = await insertTopic(db, { roomId: boardId, userId: minor.id, title: "Minor authored" });
    const res = await app.inject({ method: "PATCH", url: `/messages/${mineId}/nsfw`, headers: auth(minorToken), payload: { nsfw: true } });
    assert.equal(res.statusCode, 403);
    const row = (await db.select().from(schema.messages).where(eq(schema.messages.id, mineId)).limit(1))[0]!;
    assert.equal(row.isNsfw, false);
  });

  test("a stranger adult is refused; the forum owner (manage_prefixes tier) may re-tag", async () => {
    const tId = await insertTopic(db, { roomId: boardId, userId: adult.id, title: "Owner retag target" });
    const stranger = await app.inject({ method: "PATCH", url: `/messages/${tId}/nsfw`, headers: auth(hidePrefToken), payload: { nsfw: true } });
    assert.equal(stranger.statusCode, 403);
    const asOwner = await app.inject({ method: "PATCH", url: `/messages/${tId}/nsfw`, headers: auth(ownerToken), payload: { nsfw: true } });
    assert.equal(asOwner.statusCode, 200);
  });

  test("replies and non-forum rooms are rejected; clearing can't drop below an 18+ room", async () => {
    const replyRes = await app.inject({ method: "PATCH", url: `/messages/${nsfwReplyId}/nsfw`, headers: auth(adultToken), payload: { nsfw: false } });
    assert.equal(replyRes.statusCode, 400);

    // Chat (non-forum) message → 400.
    const chatRoomId = nanoid();
    await db.insert(schema.rooms).values({ id: chatRoomId, name: "PlainChat", slug: "plainchat", type: "public" });
    const chatMsgId = await insertTopic(db, { roomId: chatRoomId, userId: adult.id, title: "not a forum" });
    const chatRes = await app.inject({ method: "PATCH", url: `/messages/${chatMsgId}/nsfw`, headers: auth(adultToken), payload: { nsfw: false } });
    assert.equal(chatRes.statusCode, 400);

    // 18+ BOARD room: the room's effective state is the floor, so clearing
    // the tag leaves the stamp in place.
    const hotBoardId = await insertBoard(db, { name: "HotBoard", forumId, ownerId: owner.id, isNsfw: true });
    const hotTopicId = await insertTopic(db, { roomId: hotBoardId, userId: adult.id, title: "Hot topic", isNsfw: true });
    const clear = await app.inject({ method: "PATCH", url: `/messages/${hotTopicId}/nsfw`, headers: auth(adultToken), payload: { nsfw: false } });
    assert.equal(clear.statusCode, 200);
    assert.equal((clear.json() as { isNsfw: boolean }).isNsfw, true, "floor holds");
  });
});

describe("topic lists (SOFT tier)", () => {
  test("GET /rooms/:id/topics filters per viewer and flags visible rows", async () => {
    const titles = async (token?: string) => {
      const res = await app.inject({ method: "GET", url: `/rooms/${boardId}/topics`, ...(token ? { headers: auth(token) } : {}) });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { topics: Array<{ id: string; title?: string; isNsfw?: boolean }>; unreadTopicIds: string[] };
      return body;
    };
    const forAdult = await titles(adultToken);
    const nsfwRow = forAdult.topics.find((t) => t.id === nsfwTopicId);
    assert.ok(nsfwRow, "adult sees the tagged topic");
    assert.equal(nsfwRow!.isNsfw, true, "row carries the NSFW chip flag");

    const forMinor = await titles(minorToken);
    assert.equal(forMinor.topics.some((t) => t.id === nsfwTopicId), false);
    assert.equal(forMinor.topics.some((t) => t.id === sfwTopicId), true);
    assert.equal(forMinor.unreadTopicIds.includes(nsfwTopicId), false, "unread computation excludes it");

    const forHidePref = await titles(hidePrefToken);
    assert.equal(forHidePref.topics.some((t) => t.id === nsfwTopicId), false, "hide-pref adults filtered too (SOFT)");

    // Anonymous public browsing: allowed on this forum, never sees NSFW.
    const anon = await titles();
    assert.equal(anon.topics.some((t) => t.id === nsfwTopicId), false);
    assert.equal(anon.topics.some((t) => t.id === sfwTopicId), true);
  });

  test("GET /forums/boards/:roomId/topics filters the in-modal reader the same way", async () => {
    const cards = async (token: string) => {
      const res = await app.inject({ method: "GET", url: `/forums/boards/${boardId}/topics`, headers: auth(token) });
      assert.equal(res.statusCode, 200);
      return (res.json() as { topics: Array<{ id: string; isNsfw?: boolean }> }).topics;
    };
    const forAdult = await cards(adultToken);
    assert.equal(forAdult.find((t) => t.id === nsfwTopicId)?.isNsfw, true);
    assert.equal((await cards(minorToken)).some((t) => t.id === nsfwTopicId), false);
    assert.equal((await cards(hidePrefToken)).some((t) => t.id === nsfwTopicId), false);
  });
});

describe("thread read (HARD tier)", () => {
  test("an NSFW topic's thread 404s for minor + anon; adults pass, hide pref or not", async () => {
    const hit = async (msgId: string, token?: string) =>
      app.inject({ method: "GET", url: `/rooms/${boardId}/messages/${msgId}/thread`, ...(token ? { headers: auth(token) } : {}) });
    assert.equal((await hit(nsfwTopicId, minorToken)).statusCode, 404);
    assert.equal((await hit(nsfwTopicId)).statusCode, 404);
    assert.equal((await hit(nsfwReplyId, minorToken)).statusCode, 404, "reply ids resolve to the topic and 404 too");
    assert.equal((await hit(nsfwTopicId, adultToken)).statusCode, 200);
    const hidePrefRes = await hit(nsfwTopicId, hidePrefToken);
    assert.equal(hidePrefRes.statusCode, 200, "HARD tier: a direct link still opens for a hide-pref adult");
    assert.equal((hidePrefRes.json() as { topic: { isNsfw?: boolean } }).topic.isNsfw, true);
    assert.equal((await hit(sfwTopicId, minorToken)).statusCode, 200);
  });

  test("minors can't watch an NSFW topic; the permalink locator refuses too", async () => {
    const watch = await app.inject({ method: "PUT", url: `/forums/topics/${nsfwTopicId}/watch`, headers: auth(minorToken) });
    assert.equal(watch.statusCode, 404);
    const locate = await app.inject({ method: "GET", url: `/forums/topics/${nsfwTopicId}/locate`, headers: auth(minorToken) });
    assert.equal(locate.statusCode, 404);
    const adultLocate = await app.inject({ method: "GET", url: `/forums/topics/${nsfwTopicId}/locate`, headers: auth(adultToken) });
    assert.equal(adultLocate.statusCode, 200);
  });

  test("stamped 18+-era replies under an UNSTAMPED topic drop for minor + anon (flipped-back board)", async () => {
    // Stage the flipped-back shape directly: an unstamped topic in the
    // all-ages board with one reply stamped is_nsfw=1 at write time (as if
    // written while the board/server was 18+) and one clean reply. The
    // thread renders for everyone — the per-ROW stamp filter is what must
    // hold (Phase 2 acceptance: that era's history is adults-only).
    const eraTopicId = await insertTopic(db, { roomId: boardId, userId: adult.id, title: "Was 18 plus for a week" });
    await insertReply(db, { roomId: boardId, userId: adult.id, topicId: eraTopicId, body: "stamped era reply", isNsfw: true });
    await insertReply(db, { roomId: boardId, userId: adult.id, topicId: eraTopicId, body: "clean reply" });

    const bodies = async (token?: string) => {
      const res = await app.inject({ method: "GET", url: `/rooms/${boardId}/messages/${eraTopicId}/thread`, ...(token ? { headers: auth(token) } : {}) });
      assert.equal(res.statusCode, 200);
      return (res.json() as { replies: Array<{ body: string }> }).replies.map((r) => r.body);
    };
    assert.deepEqual(await bodies(minorToken), ["clean reply"], "minor never receives the stamped body");
    assert.deepEqual(await bodies(), ["clean reply"], "anonymous never receives it either");
    assert.equal((await bodies(adultToken)).includes("stamped era reply"), true, "adults keep the whole thread");
    assert.equal((await bodies(hidePrefToken)).includes("stamped era reply"), true, "HARD tier: hide pref does not hide thread history");
  });
});

describe("whole 18+ forums", () => {
  test("catalog + discover + tags exclude the forum for minor/anon/hide-pref; adults get it chipped", async () => {
    const catalogNames = async (token?: string) => {
      const res = await app.inject({ method: "GET", url: "/forums", ...(token ? { headers: auth(token) } : {}) });
      assert.equal(res.statusCode, 200);
      return (res.json() as { forums: Array<{ name: string; isNsfw?: boolean }> }).forums;
    };
    const forAdult = await catalogNames(adultToken);
    const velvet = forAdult.find((f) => f.name === "Velvet Hall");
    assert.ok(velvet, "adult sees the 18+ forum");
    assert.equal(velvet!.isNsfw, true);
    assert.equal((await catalogNames(minorToken)).some((f) => f.name === "Velvet Hall"), false);
    assert.equal((await catalogNames()).some((f) => f.name === "Velvet Hall"), false);
    assert.equal((await catalogNames(hidePrefToken)).some((f) => f.name === "Velvet Hall"), false);

    const discover = await app.inject({ method: "GET", url: "/forums/discover", headers: auth(minorToken) });
    const rails = discover.json() as { popular: Array<{ name: string }>; new: Array<{ name: string }> };
    assert.equal([...rails.popular, ...rails.new].some((f) => f.name === "Velvet Hall"), false);

    const search = await app.inject({ method: "GET", url: "/forums/discover/search?q=velvet", headers: auth(minorToken) });
    assert.equal((search.json() as { items: Array<{ name: string }> }).items.length, 0);
    const adultSearch = await app.inject({ method: "GET", url: "/forums/discover/search?q=velvet", headers: auth(adultToken) });
    assert.equal((adultSearch.json() as { items: Array<{ name: string }> }).items.length, 1);
  });

  test("the detail route serves a teaser to minors/anon: no boards, safe banner, publicBrowsing off", async () => {
    const detail = async (token?: string) => {
      const res = await app.inject({ method: "GET", url: `/forums/${adultForumId}`, ...(token ? { headers: auth(token) } : {}) });
      assert.equal(res.statusCode, 200);
      return res.json() as { boards: unknown[]; bannerImageUrl: string | null; publicBrowsing: boolean; isNsfw?: boolean; descriptionHtml: string | null; name: string; tagline: string | null; logoUrl: string | null };
    };
    const forMinor = await detail(minorToken);
    assert.equal(forMinor.isNsfw, true, "the teaser says plainly the forum is 18+");
    assert.equal(forMinor.boards.length, 0);
    assert.equal(forMinor.publicBrowsing, false, "presents as a non-publicBrowsing forum");
    assert.equal(forMinor.bannerImageUrl, "/uploads/forums/safe-banner.png", "public-safe banner swap");
    assert.equal(forMinor.tagline, null, "owner-written tagline withheld from the teaser");
    assert.equal(forMinor.logoUrl, null, "owner-uploaded logo withheld from the teaser");
    const anon = await detail();
    assert.equal(anon.boards.length, 0);
    assert.equal(anon.tagline, null);
    const forAdult = await detail(adultToken);
    assert.equal(forAdult.boards.length, 1, "adults get the full detail");
    assert.equal(forAdult.bannerImageUrl, "/uploads/forums/real-banner.png");
    assert.equal(forAdult.tagline, "adults only tagline", "adults keep the real tagline");
    const forHidePref = await detail(hidePrefToken);
    assert.equal(forHidePref.boards.length, 1, "hide pref only un-lists; direct detail still works");
  });

  test("boards inherit the gate: topic + board-reader + categories routes 404 for minors, anon gets 401", async () => {
    assert.equal((await app.inject({ method: "GET", url: `/rooms/${adultBoardId}/topics`, headers: auth(minorToken) })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/forums/boards/${adultBoardId}/topics`, headers: auth(minorToken) })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/rooms/${adultBoardId}/thread-categories`, headers: auth(minorToken) })).statusCode, 404);
    // publicBrowsing is ON for this forum, but 18+ kills anonymous reads:
    // the anon gate refuses before the age gate would even run.
    assert.equal((await app.inject({ method: "GET", url: `/rooms/${adultBoardId}/topics` })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: `/rooms/${adultBoardId}/topics`, headers: auth(adultToken) })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/rooms/${adultBoardId}/topics`, headers: auth(hidePrefToken) })).statusCode, 200, "HARD tier on direct board access");
  });

  test("an 18+ BOARD (room flag) leaves the all-ages forum's board list for !canSeeNsfw viewers", async () => {
    // HotBoard was flagged 18+ in the re-tag floor test above.
    const boardNames = async (token?: string) => {
      const res = await app.inject({ method: "GET", url: `/forums/${forumId}`, ...(token ? { headers: auth(token) } : {}) });
      assert.equal(res.statusCode, 200);
      return (res.json() as { boards: Array<{ name: string; isNsfw?: boolean }> }).boards;
    };
    const forAdult = await boardNames(adultToken);
    const hot = forAdult.find((b) => b.name === "HotBoard");
    assert.ok(hot, "adult sees the 18+ board listed");
    assert.equal(hot!.isNsfw, true, "board row carries the 18+ chip flag");
    assert.equal((await boardNames(minorToken)).some((b) => b.name === "HotBoard"), false);
    assert.equal((await boardNames()).some((b) => b.name === "HotBoard"), false);
    assert.equal((await boardNames(hidePrefToken)).some((b) => b.name === "HotBoard"), false, "SOFT tier hides the listing");
    assert.equal((await boardNames(minorToken)).some((b) => b.name === "OpenBoard"), true, "all-ages boards stay");
  });

  test("the /rooms rail drops the 18+ forum's board for minors", async () => {
    const names = async (token: string) => {
      const res = await app.inject({ method: "GET", url: "/rooms", headers: auth(token) });
      return (res.json() as { rooms: Array<{ name: string }> }).rooms.map((r) => r.name);
    };
    assert.equal((await names(minorToken)).includes("VelvetBoard"), false);
    assert.equal((await names(adultToken)).includes("VelvetBoard"), true);
  });
});

describe("forum notifications", () => {
  test("NSFW topics write-skip minor recipients; adults still get rows", async () => {
    // Both watch the NSFW topic (direct table writes; the watch ROUTE
    // refuses minors, but a pre-existing watch from before a re-tag is
    // exactly the case the write-skip must cover).
    await db.insert(schema.forumTopicWatches).values([
      { userId: minor.id, topicId: nsfwTopicId },
      { userId: hidePrefAdult.id, topicId: nsfwTopicId },
    ]).onConflictDoNothing();
    await notifyForumReply(db, makeFakeIo(), {
      forumId,
      boardRoomId: boardId,
      topic: { id: nsfwTopicId, userId: adult.id, title: "Adults only topic" },
      messageId: nsfwReplyId,
      body: "fresh grown up reply",
      actor: { id: adult.id, displayName: adult.username },
    });
    const minorRows = await db.select().from(schema.forumNotifications)
      .where(and(eq(schema.forumNotifications.userId, minor.id), eq(schema.forumNotifications.topicId, nsfwTopicId)));
    assert.equal(minorRows.length, 0, "minor recipient write-skipped");
    const adultRows = await db.select().from(schema.forumNotifications)
      .where(and(eq(schema.forumNotifications.userId, hidePrefAdult.id), eq(schema.forumNotifications.topicId, nsfwTopicId)));
    assert.equal(adultRows.length >= 1, true, "hide-pref adult still notified (they watched it)");
  });

  test("read-time re-filter drops rows for topics tagged AFTER the row was written", async () => {
    const laterTopicId = await insertTopic(db, { roomId: boardId, userId: adult.id, title: "Was safe once" });
    await db.insert(schema.forumNotifications).values({
      id: nanoid(),
      userId: minor.id,
      kind: "watch",
      forumId,
      boardRoomId: boardId,
      topicId: laterTopicId,
      messageId: sfwTopicId,
      actorUserId: adult.id,
      actorName: adult.username,
      topicTitle: "Was safe once",
      snippet: "sfw era snippet",
      createdAt: new Date(),
    });
    const minorViewer = { isAdult: false, role: "user", birthdate: MINOR_DOB, isolateFromAdults: false };
    const adultViewer = { isAdult: true, role: "user", birthdate: ADULT_DOB, isolateFromAdults: false };
    assert.equal(await unreadForumNotifications(db, minor.id, minorViewer), 1);
    assert.equal((await listForumNotifications(db, minor.id, 50, minorViewer)).length, 1);

    // The topic gets tagged; the durable row must vanish for the minor.
    await db.update(schema.messages).set({ isNsfw: true }).where(eq(schema.messages.id, laterTopicId));
    assert.equal(await unreadForumNotifications(db, minor.id, minorViewer), 0, "unread count re-filters");
    assert.equal((await listForumNotifications(db, minor.id, 50, minorViewer)).length, 0, "inbox re-filters");
    // An adult with the same row shape would keep it (HARD tier only).
    assert.equal((await listForumNotifications(db, minor.id, 50, adultViewer)).length, 1);

    const viaRoute = await app.inject({ method: "GET", url: "/forums/notifications", headers: auth(minorToken) });
    const routeBody = viaRoute.json() as { unread: number; notifications: Array<{ topicId: string }> };
    assert.equal(routeBody.notifications.some((n) => n.topicId === laterTopicId), false);
  });

  test("isolation: adult non-staff actors never reach an isolated minor's inbox; staff still do", async () => {
    const isoMinor = await createUser(db, { birthdate: MINOR_DOB, isolateFromAdults: true });
    const staff = await createUser(db, { role: "mod", birthdate: ADULT_DOB });
    const isoTopicId = await insertTopic(db, { roomId: boardId, userId: adult.id, title: "Iso watch topic" });
    await db.insert(schema.forumTopicWatches).values({ userId: isoMinor.id, topicId: isoTopicId }).onConflictDoNothing();

    // WRITE side: the adult actor's reply write-skips the isolated minor
    // (the row would carry the actor's name + a body snippet across the
    // fence, and its deep-link dead-ends on the isolation-filtered thread).
    await notifyForumReply(db, makeFakeIo(), {
      forumId,
      boardRoomId: boardId,
      topic: { id: isoTopicId, userId: adult.id, title: "Iso watch topic" },
      messageId: sfwTopicId,
      body: "adult words the isolated minor must not see",
      actor: { id: adult.id, displayName: adult.username },
    });
    const written = await db.select().from(schema.forumNotifications)
      .where(and(eq(schema.forumNotifications.userId, isoMinor.id), eq(schema.forumNotifications.topicId, isoTopicId)));
    assert.equal(written.length, 0, "adult actor write-skipped");

    // READ side: a row written BEFORE isolation was toggled on re-filters
    // out of both the inbox page and the unread count; a SITE-STAFF actor's
    // row stays (staff are exempt in both directions).
    const mkRow = (actor: { id: string; username: string }) => ({
      id: nanoid(),
      userId: isoMinor.id,
      kind: "watch" as const,
      forumId,
      boardRoomId: boardId,
      topicId: isoTopicId,
      messageId: sfwTopicId,
      actorUserId: actor.id,
      actorName: actor.username,
      topicTitle: "Iso watch topic",
      snippet: "pre-isolation snippet",
      createdAt: new Date(),
    });
    await db.insert(schema.forumNotifications).values([mkRow(adult), mkRow(staff)]);
    const isoViewer = { isAdult: false, role: "user", birthdate: MINOR_DOB, isolateFromAdults: true };
    const visible = await listForumNotifications(db, isoMinor.id, 50, isoViewer);
    assert.deepEqual(visible.map((n) => n.actorUserId), [staff.id], "adult row re-filtered, staff row kept");
    assert.equal(await unreadForumNotifications(db, isoMinor.id, isoViewer), 1, "unread counts only the staff row");
  });
});

describe("per-room search board gates (adjacent bugfix §I1)", () => {
  test("a members-only board's bodies no longer leak to arbitrary logged-in users", async () => {
    const lockedBoardId = await insertBoard(db, { name: "LockedBoard", forumId, ownerId: owner.id, membersOnly: true });
    await insertTopic(db, { roomId: lockedBoardId, userId: owner.id, title: "Secret plans", body: "secret needle here" });
    const res = await app.inject({ method: "GET", url: `/rooms/${lockedBoardId}/messages/search?q=needle`, headers: auth(adultToken) });
    assert.equal(res.statusCode, 403, "non-member refused outright");
    // The forum owner is a member-equivalent and still searches fine.
    const asOwner = await app.inject({ method: "GET", url: `/rooms/${lockedBoardId}/messages/search?q=needle`, headers: auth(ownerToken) });
    assert.equal(asOwner.statusCode, 200);
    assert.equal((asOwner.json() as { hits: unknown[] }).hits.length, 1);
  });

  test("hits filed under a members-only CATEGORY drop for non-members (topics AND replies)", async () => {
    const catId = nanoid();
    await db.insert(schema.roomThreadCategories).values({
      id: catId, roomId: boardId, name: "Inner Circle", membersOnly: true,
    });
    const catTopicId = await insertTopic(db, { roomId: boardId, userId: owner.id, title: "Members topic", body: "inner needle topic", categoryId: catId });
    await insertReply(db, { roomId: boardId, userId: owner.id, topicId: catTopicId, body: "inner needle reply" });
    await insertTopic(db, { roomId: boardId, userId: owner.id, title: "Open topic", body: "open needle topic" });

    const snippets = async (token: string) => {
      const res = await app.inject({ method: "GET", url: `/rooms/${boardId}/messages/search?q=needle`, headers: auth(token) });
      assert.equal(res.statusCode, 200);
      return (res.json() as { hits: Array<{ snippet: string }> }).hits.map((h) => h.snippet).sort();
    };
    assert.deepEqual(await snippets(adultToken), ["open needle topic"], "locked-category topic + reply both dropped");
    assert.deepEqual(await snippets(ownerToken), ["inner needle reply", "inner needle topic", "open needle topic"]);
  });

  test("NSFW-tagged topics stay out of a minor's per-room search (message clause)", async () => {
    const res = await app.inject({ method: "GET", url: `/rooms/${boardId}/messages/search?q=grown%20up`, headers: auth(minorToken) });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { hits: unknown[] }).hits.length, 0);
    const adultRes = await app.inject({ method: "GET", url: `/rooms/${boardId}/messages/search?q=grown%20up`, headers: auth(adultToken) });
    assert.equal((adultRes.json() as { hits: unknown[] }).hits.length >= 1, true);
  });
});
