import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { PinnedMessage } from "@thekeep/shared";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { registerMessageRoutes } from "../src/routes/messages.js";
import { registerBookmarkRoutes } from "../src/routes/bookmarks.js";
import { archiveDoomedBookmarks } from "../src/retention/archiveBookmarks.js";
import { rebuildMinorFilter } from "../src/realtime/minorLanguageFilter.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Snapshot 18+ stamps for pins (migration 0340) and bookmarks (migration
 * 0341) — the two snapshot-outlives-the-source surfaces the age build left
 * as known gaps. Both freeze `messages.isNsfw` into the snapshot row so the
 * minor gate still holds AFTER the source message is hard-deleted /
 * retention-expired and the live join can no longer see the stamp.
 *
 * Fixture pattern mirrors nsfw-rooms.test.ts: an SFW ("flipped-back") room
 * whose OLD messages carry `isNsfw: true` write-time stamps, one
 * unambiguous minor DOB and one adult DOB.
 */

const MINOR_DOB = "2012-01-01";
const ADULT_DOB = "1990-01-01";

/* ── Fake socket.io: enough surface for emitRoomPins (in(band).fetchSockets
 *    + per-socket emit) and the room-wide to(band).emit fast path. ─────── */

class FakeSocket {
  id = nanoid();
  rooms = new Set<string>();
  // Only the slice emitRoomPins reads: the handshake session snapshot.
  data: { user?: { isAdult?: boolean } } = {};
  emitted: Array<{ event: string; payload: unknown }> = [];
  emit(event: string, payload?: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }
  lastPins(): PinnedMessage[] | undefined {
    const hit = [...this.emitted].reverse().find((e) => e.event === "room:pins");
    return (hit?.payload as { pins: PinnedMessage[] } | undefined)?.pins;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeIo(sockets: FakeSocket[]): any {
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

async function insertRoom(db: Db, opts: { name: string; ownerId: string }): Promise<string> {
  const id = nanoid();
  await db.insert(schema.rooms).values({
    id,
    name: opts.name,
    slug: `${opts.name.toLowerCase()}-${id.slice(0, 6)}`,
    type: "public",
    // SFW *now*: the 18+ era lives only in the per-message stamps below.
    isNsfw: false,
    ownerId: opts.ownerId,
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
/** Sockets the fake io fans out to; tests push/clear per scenario. */
const sockets: FakeSocket[] = [];
let adult: { id: string };
let minor: { id: string };
let adultToken: string;
let minorToken: string;

before(async () => {
  db = makeTestDb().db;
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) { reply.code(400); return reply.send({ error: "validation" }); }
    throw err;
  });
  await registerMessageRoutes(app, db, makeFakeIo(sockets));
  await registerBookmarkRoutes(app, db);
  await app.ready();

  adult = await createUser(db, { birthdate: ADULT_DOB });
  minor = await createUser(db, { birthdate: MINOR_DOB });
  adultToken = await tokenFor(db, adult.id);
  minorToken = await tokenFor(db, minor.id);
});

/* ────────────────────────────── pins ─────────────────────────────── */

describe("pinned-message snapshot stamps (migration 0340)", () => {
  test("pinning freezes the source row's is_nsfw into the pin", async () => {
    const roomId = await insertRoom(db, { name: "Stamp_Room", ownerId: adult.id });
    const nsfwMsg = await insertMessage(db, { roomId, userId: adult.id, body: "18+ era line", isNsfw: true });
    const sfwMsg = await insertMessage(db, { roomId, userId: adult.id, body: "all-ages line" });

    for (const id of [nsfwMsg, sfwMsg]) {
      const res = await app.inject({ method: "POST", url: `/messages/${id}/pin`, headers: auth(adultToken) });
      assert.equal(res.statusCode, 200);
    }
    const rows = await db.select().from(schema.pinnedMessages).where(eq(schema.pinnedMessages.roomId, roomId));
    assert.equal(rows.find((r) => r.messageId === nsfwMsg)?.isNsfw, true);
    assert.equal(rows.find((r) => r.messageId === sfwMsg)?.isNsfw, false);
  });

  test("GET pins: an 18+-era snapshot-only pin stays hidden from a minor after the source row is gone; an adult still reads it", async () => {
    const roomId = await insertRoom(db, { name: "Expiry_Room", ownerId: adult.id });
    const nsfwMsg = await insertMessage(db, { roomId, userId: adult.id, body: "18+ era line", isNsfw: true });
    const sfwMsg = await insertMessage(db, { roomId, userId: adult.id, body: "all-ages line" });
    for (const id of [nsfwMsg, sfwMsg]) {
      const res = await app.inject({ method: "POST", url: `/messages/${id}/pin`, headers: auth(adultToken) });
      assert.equal(res.statusCode, 200);
    }

    // Simulate the retention janitor: hard-delete the 18+ source. The pin's
    // messageId FK goes NULL and only the frozen snapshot (incl. its stamp)
    // remains.
    await db.delete(schema.messages).where(eq(schema.messages.id, nsfwMsg));

    const asAdult = await app.inject({ method: "GET", url: `/rooms/${roomId}/pins`, headers: auth(adultToken) });
    assert.equal(asAdult.statusCode, 200);
    const adultPins = (asAdult.json() as { pins: PinnedMessage[] }).pins;
    assert.equal(adultPins.length, 2);
    const snapshotOnly = adultPins.find((p) => p.messageId === null);
    assert.ok(snapshotOnly, "adult still sees the snapshot-only pin");
    assert.equal(snapshotOnly.isNsfw, true);
    assert.equal(snapshotOnly.body, "18+ era line");

    const asMinor = await app.inject({ method: "GET", url: `/rooms/${roomId}/pins`, headers: auth(minorToken) });
    assert.equal(asMinor.statusCode, 200);
    const minorPins = (asMinor.json() as { pins: PinnedMessage[] }).pins;
    assert.deepEqual(minorPins.map((p) => p.messageId), [sfwMsg]);
  });

  test("emitRoomPins splits per socket: minor and snapshot-less sockets never receive the 18+ snapshot-only pin", async () => {
    const roomId = await insertRoom(db, { name: "Emit_Room", ownerId: adult.id });
    const band = `room:${roomId}`;
    const adultSocket = new FakeSocket();
    adultSocket.rooms.add(band);
    adultSocket.data.user = { isAdult: true };
    const minorSocket = new FakeSocket();
    minorSocket.rooms.add(band);
    minorSocket.data.user = { isAdult: false };
    const bareSocket = new FakeSocket(); // no session snapshot → fails closed
    bareSocket.rooms.add(band);
    sockets.push(adultSocket, minorSocket, bareSocket);
    try {
      const nsfwMsg = await insertMessage(db, { roomId, userId: adult.id, body: "18+ era line", isNsfw: true });
      const sfw1 = await insertMessage(db, { roomId, userId: adult.id, body: "sfw one" });
      const sfw2 = await insertMessage(db, { roomId, userId: adult.id, body: "sfw two" });

      // All-SFW fast path: nothing filters, so every socket (minor included)
      // gets the identical room-wide set.
      let res = await app.inject({ method: "POST", url: `/messages/${sfw1}/pin`, headers: auth(adultToken) });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(minorSocket.lastPins()?.map((p) => p.messageId), [sfw1]);
      assert.deepEqual(bareSocket.lastPins()?.map((p) => p.messageId), [sfw1]);

      // Pin the 18+ row, then expire its source so only the snapshot remains.
      res = await app.inject({ method: "POST", url: `/messages/${nsfwMsg}/pin`, headers: auth(adultToken) });
      assert.equal(res.statusCode, 200);
      await db.delete(schema.messages).where(eq(schema.messages.id, nsfwMsg));

      // Any pin-set change re-broadcasts the whole strip; this one must go
      // per-socket because the snapshot-only 18+ pin filters for minors.
      res = await app.inject({ method: "POST", url: `/messages/${sfw2}/pin`, headers: auth(adultToken) });
      assert.equal(res.statusCode, 200);

      const adultSet = adultSocket.lastPins();
      assert.ok(adultSet);
      assert.equal(adultSet.length, 3);
      assert.ok(adultSet.some((p) => p.messageId === null && p.isNsfw && p.body === "18+ era line"));

      assert.deepEqual(minorSocket.lastPins()?.map((p) => p.messageId), [sfw1, sfw2]);
      // A socket with no session snapshot gets the filtered set too.
      assert.deepEqual(bareSocket.lastPins()?.map((p) => p.messageId), [sfw1, sfw2]);
    } finally {
      sockets.length = 0;
    }
  });

  test("retention refreshes a stale pin stamp: pinned SFW, re-tagged 18+, expired → hidden from minors on both paths", async () => {
    const roomId = await insertRoom(db, { name: "Retag_Room", ownerId: adult.id });
    const msgId = await insertMessage(db, { roomId, userId: adult.id, body: "18+ re-tag line" });
    let res = await app.inject({ method: "POST", url: `/messages/${msgId}/pin`, headers: auth(adultToken) });
    assert.equal(res.statusCode, 200);
    // Frozen SFW at pin time — correct while the live row exists (readers
    // prefer the live join, which sees the re-tag below).
    let pinRow = (await db.select().from(schema.pinnedMessages)
      .where(eq(schema.pinnedMessages.roomId, roomId)))[0];
    assert.equal(pinRow?.isNsfw, false);

    // A mod re-tags the line 18+ later.
    await db.update(schema.messages).set({ isNsfw: true }).where(eq(schema.messages.id, msgId));

    // Retention expires the source: the same pass that archives bookmarks
    // re-stamps the pin from the doomed row, BEFORE the delete nulls the FK.
    await archiveDoomedBookmarks(db, and(inArray(schema.messages.id, [msgId])));
    await db.delete(schema.messages).where(eq(schema.messages.id, msgId));

    pinRow = (await db.select().from(schema.pinnedMessages)
      .where(eq(schema.pinnedMessages.roomId, roomId)))[0];
    assert.equal(pinRow?.messageId, null, "FK detached — snapshot-only from here on");
    assert.equal(pinRow?.isNsfw, true, "the retention pass refreshed the frozen stamp");

    // GET path: gone for the minor, still readable for the adult.
    const asMinor = await app.inject({ method: "GET", url: `/rooms/${roomId}/pins`, headers: auth(minorToken) });
    assert.equal(asMinor.statusCode, 200);
    assert.deepEqual((asMinor.json() as { pins: PinnedMessage[] }).pins, []);
    const asAdult = await app.inject({ method: "GET", url: `/rooms/${roomId}/pins`, headers: auth(adultToken) });
    assert.equal((asAdult.json() as { pins: PinnedMessage[] }).pins.length, 1);

    // room:pins path: any pin-set change re-broadcasts the strip.
    const band = `room:${roomId}`;
    const adultSocket = new FakeSocket();
    adultSocket.rooms.add(band);
    adultSocket.data.user = { isAdult: true };
    const minorSocket = new FakeSocket();
    minorSocket.rooms.add(band);
    minorSocket.data.user = { isAdult: false };
    sockets.push(adultSocket, minorSocket);
    try {
      const sfw = await insertMessage(db, { roomId, userId: adult.id, body: "all-ages line" });
      res = await app.inject({ method: "POST", url: `/messages/${sfw}/pin`, headers: auth(adultToken) });
      assert.equal(res.statusCode, 200);
      assert.equal(adultSocket.lastPins()?.length, 2, "adult keeps the 18+-era snapshot pin");
      assert.deepEqual(minorSocket.lastPins()?.map((p) => p.messageId), [sfw]);
    } finally {
      sockets.length = 0;
    }
  });
});

/* ──────────────────────────── bookmarks ──────────────────────────── */

describe("bookmark snapshot stamps (migration 0341)", () => {
  /** Bookmark `messageId` for `userId`, archive it via the real janitor
   *  helper, then hard-delete the source — the retention sequence. */
  async function bookmarkThenExpire(
    userToken: string,
    messageIds: string[],
    categories: string[],
  ): Promise<void> {
    for (let i = 0; i < messageIds.length; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/me/bookmarks",
        headers: auth(userToken),
        payload: { messageId: messageIds[i], category: categories[i] },
      });
      assert.equal(res.statusCode, 200);
    }
    await archiveDoomedBookmarks(db, and(inArray(schema.messages.id, messageIds)));
    await db.delete(schema.messages).where(inArray(schema.messages.id, messageIds));
  }

  test("the retention archive freezes each doomed source's is_nsfw into snapshot_is_nsfw", async () => {
    const user = await createUser(db, { birthdate: ADULT_DOB });
    const token = await tokenFor(db, user.id);
    const roomId = await insertRoom(db, { name: "BM_Stamp", ownerId: adult.id });
    const nsfwMsg = await insertMessage(db, { roomId, userId: adult.id, body: "18+ era line", isNsfw: true });
    const sfwMsg = await insertMessage(db, { roomId, userId: adult.id, body: "all-ages line" });

    await bookmarkThenExpire(token, [nsfwMsg, sfwMsg], ["nsfw", "sfw"]);

    const rows = await db.select().from(schema.bookmarks).where(eq(schema.bookmarks.userId, user.id));
    const nsfwRow = rows.find((r) => r.category === "nsfw");
    const sfwRow = rows.find((r) => r.category === "sfw");
    assert.ok(nsfwRow);
    assert.ok(sfwRow);
    // FK SET NULL detached both from the deleted sources…
    assert.equal(nsfwRow.messageId, null);
    assert.equal(sfwRow.messageId, null);
    // …the janitor archived both and froze the per-row stamp.
    assert.ok(nsfwRow.archivedAt);
    assert.ok(sfwRow.archivedAt);
    assert.equal(nsfwRow.snapshotIsNsfw, true);
    assert.equal(sfwRow.snapshotIsNsfw, false);
  });

  test("after an admin DOB downgrade, the archived 18+ snapshot reads [message removed]; the SFW archive still reads", async () => {
    const user = await createUser(db, { birthdate: ADULT_DOB });
    const token = await tokenFor(db, user.id);
    const roomId = await insertRoom(db, { name: "BM_Downgrade", ownerId: adult.id });
    const nsfwMsg = await insertMessage(db, { roomId, userId: adult.id, body: "18+ era line", isNsfw: true });
    const sfwMsg = await insertMessage(db, { roomId, userId: adult.id, body: "all-ages line" });
    await bookmarkThenExpire(token, [nsfwMsg, sfwMsg], ["nsfw", "sfw"]);

    // Admin corrects the DOB: the account is a minor from the next request on.
    await db.update(schema.users).set({ birthdate: MINOR_DOB }).where(eq(schema.users.id, user.id));

    const res = await app.inject({ method: "GET", url: "/me/bookmarks", headers: auth(token) });
    assert.equal(res.statusCode, 200);
    const list = (res.json() as {
      bookmarks: Array<{ category: string; message: { body: string; archived?: boolean } }>;
    }).bookmarks;
    const nsfwBm = list.find((b) => b.category === "nsfw");
    const sfwBm = list.find((b) => b.category === "sfw");
    assert.ok(nsfwBm);
    assert.ok(sfwBm);
    assert.equal(nsfwBm.message.body, "[message removed]");
    assert.notEqual(nsfwBm.message.archived, true);
    assert.equal(sfwBm.message.body, "all-ages line");
    assert.equal(sfwBm.message.archived, true);
  });

  test("an adult keeps reading their archived 18+-era snapshot", async () => {
    const user = await createUser(db, { birthdate: ADULT_DOB });
    const token = await tokenFor(db, user.id);
    const roomId = await insertRoom(db, { name: "BM_Adult", ownerId: adult.id });
    const nsfwMsg = await insertMessage(db, { roomId, userId: adult.id, body: "18+ era line", isNsfw: true });
    await bookmarkThenExpire(token, [nsfwMsg], ["nsfw"]);

    const res = await app.inject({ method: "GET", url: "/me/bookmarks", headers: auth(token) });
    assert.equal(res.statusCode, 200);
    const list = (res.json() as {
      bookmarks: Array<{ category: string; message: { body: string; archived?: boolean } }>;
    }).bookmarks;
    assert.equal(list[0]?.message.body, "18+ era line");
    assert.equal(list[0]?.message.archived, true);
  });
});

/* ─────────── minor language filter over pins + bookmarks (§J) ─────────── */

describe("minor language filter over pins + bookmarks (age plan Phase 7, plan_ext.md §J)", () => {
  const DIRTY = "well shit, that hurt";
  const DIRTY_MASKED = "well s***, that hurt";

  // Explicitly seed the module singleton (this file never walks the
  // settings chain): default config — enabled, no overlay.
  before(() => rebuildMinorFilter({ minorFilterEnabled: true, minorFilterTerms: [], minorFilterAllow: [] }));

  test("GET /rooms/:id/pins: minor reads pin bodies masked, adult the originals, stored pin row untouched", async () => {
    const roomId = await insertRoom(db, { name: "Mask_Pin_Room", ownerId: adult.id });
    const msgId = await insertMessage(db, { roomId, userId: adult.id, body: DIRTY });
    const res = await app.inject({ method: "POST", url: `/messages/${msgId}/pin`, headers: auth(adultToken) });
    assert.equal(res.statusCode, 200);

    const asMinor = await app.inject({ method: "GET", url: `/rooms/${roomId}/pins`, headers: auth(minorToken) });
    assert.equal(asMinor.statusCode, 200);
    const minorPins = (asMinor.json() as { pins: PinnedMessage[] }).pins;
    assert.equal(minorPins.length, 1, "profanity hides the WORD, never the pin");
    assert.equal(minorPins[0]?.body, DIRTY_MASKED);

    const asAdult = await app.inject({ method: "GET", url: `/rooms/${roomId}/pins`, headers: auth(adultToken) });
    assert.equal((asAdult.json() as { pins: PinnedMessage[] }).pins[0]?.body, DIRTY);

    const stored = (await db.select().from(schema.pinnedMessages)
      .where(eq(schema.pinnedMessages.roomId, roomId)))[0];
    assert.equal(stored?.body, DIRTY, "masking never edits the stored snapshot");
  });

  test("room:pins emit: minor socket masked, adult socket original, snapshot-less socket fails closed", async () => {
    const roomId = await insertRoom(db, { name: "Mask_Emit_Room", ownerId: adult.id });
    const band = `room:${roomId}`;
    const adultSocket = new FakeSocket();
    adultSocket.rooms.add(band);
    adultSocket.data.user = { isAdult: true };
    const minorSocket = new FakeSocket();
    minorSocket.rooms.add(band);
    minorSocket.data.user = { isAdult: false };
    const bareSocket = new FakeSocket(); // no session snapshot → masked
    bareSocket.rooms.add(band);
    sockets.push(adultSocket, minorSocket, bareSocket);
    try {
      const msgId = await insertMessage(db, { roomId, userId: adult.id, body: DIRTY });
      const res = await app.inject({ method: "POST", url: `/messages/${msgId}/pin`, headers: auth(adultToken) });
      assert.equal(res.statusCode, 200);
      assert.equal(adultSocket.lastPins()?.[0]?.body, DIRTY, "adult receives the original snapshot");
      assert.equal(minorSocket.lastPins()?.[0]?.body, DIRTY_MASKED);
      assert.equal(bareSocket.lastPins()?.[0]?.body, DIRTY_MASKED);
    } finally {
      sockets.length = 0;
    }
  });

  test("bookmarks: minor reads the LIVE body masked; adult original; disabled filter passes through", async () => {
    const roomId = await insertRoom(db, { name: "Mask_BM_Live", ownerId: adult.id });
    const msgId = await insertMessage(db, { roomId, userId: adult.id, body: DIRTY });
    for (const tok of [minorToken, adultToken]) {
      const res = await app.inject({
        method: "POST",
        url: "/me/bookmarks",
        headers: auth(tok),
        payload: { messageId: msgId },
      });
      assert.equal(res.statusCode, 200);
    }

    const asMinor = await app.inject({ method: "GET", url: "/me/bookmarks", headers: auth(minorToken) });
    assert.equal(asMinor.statusCode, 200);
    const minorList = (asMinor.json() as { bookmarks: Array<{ message: { body: string } }> }).bookmarks;
    const minorHit = minorList.find((b) => b.message.body === DIRTY_MASKED);
    assert.ok(minorHit, "minor's live bookmark body is masked");
    assert.ok(!minorList.some((b) => b.message.body === DIRTY), "no original body for the minor");

    const asAdult = await app.inject({ method: "GET", url: "/me/bookmarks", headers: auth(adultToken) });
    const adultList = (asAdult.json() as { bookmarks: Array<{ message: { body: string } }> }).bookmarks;
    assert.ok(adultList.some((b) => b.message.body === DIRTY), "adult reads the original");

    // Passthrough: with the filter off the minor reads the original too.
    rebuildMinorFilter({ minorFilterEnabled: false, minorFilterTerms: [], minorFilterAllow: [] });
    try {
      const off = await app.inject({ method: "GET", url: "/me/bookmarks", headers: auth(minorToken) });
      const offList = (off.json() as { bookmarks: Array<{ message: { body: string } }> }).bookmarks;
      assert.ok(offList.some((b) => b.message.body === DIRTY));
    } finally {
      rebuildMinorFilter({ minorFilterEnabled: true, minorFilterTerms: [], minorFilterAllow: [] });
    }
  });

  test("bookmarks: the ARCHIVED snapshot reads masked for a minor and raw in the DB", async () => {
    const user = await createUser(db, { birthdate: MINOR_DOB });
    const token = await tokenFor(db, user.id);
    const roomId = await insertRoom(db, { name: "Mask_BM_Arch", ownerId: adult.id });
    const msgId = await insertMessage(db, { roomId, userId: adult.id, body: DIRTY });
    let res = await app.inject({
      method: "POST",
      url: "/me/bookmarks",
      headers: auth(token),
      payload: { messageId: msgId },
    });
    assert.equal(res.statusCode, 200);

    // Retention sequence: archive, then hard-delete the source.
    await archiveDoomedBookmarks(db, and(inArray(schema.messages.id, [msgId])));
    await db.delete(schema.messages).where(eq(schema.messages.id, msgId));

    res = await app.inject({ method: "GET", url: "/me/bookmarks", headers: auth(token) });
    assert.equal(res.statusCode, 200);
    const list = (res.json() as {
      bookmarks: Array<{ message: { body: string; archived?: boolean } }>;
    }).bookmarks;
    assert.equal(list.length, 1);
    assert.equal(list[0]?.message.archived, true);
    assert.equal(list[0]?.message.body, DIRTY_MASKED, "archived snapshot masked for the minor");

    // The stored snapshot keeps what the author wrote.
    const stored = (await db.select().from(schema.bookmarks)
      .where(eq(schema.bookmarks.userId, user.id)))[0];
    assert.equal(stored?.snapshotBody, DIRTY);
  });
});
