import "./helpers/env.js";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { registerCharacterRoutes } from "../src/routes/characters.js";
import { registerRoomsRoutes } from "../src/routes/rooms.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Legacy birthdate self-set (POST /me/birthdate): accounts that predate the
 * age gate carry `users.birthdate = NULL` (adult by attestation) and may
 * record their real date ONCE. Invariants under test:
 *
 *   1. Set-when-null succeeds, persists, and is audited (`user_dob_update`
 *      with `selfService`); a second set — and any set on an account that
 *      registered with a date — is refused 409 without touching the row.
 *   2. Signup-grade sane-range validation: impossible calendar dates,
 *      future dates, century typos (>130y), non-ISO shapes, and under-13
 *      dates (COPPA floor — never stored) are 400s; 13-17 stays storable.
 *   3. An adult date changes NOTHING behaviorally: sessions survive and
 *      18+ rooms stay visible/readable.
 *   4. An under-18 date takes effect IMMEDIATELY: every session row is
 *      revoked (live adult stamps can't linger), and on the next sign-in
 *      the REAL age gates apply — 18+ rooms and annex pointers scrubbed
 *      from GET /rooms, 18+ history 404s, and the minor-only isolation
 *      toggle becomes writable.
 *   5. A NULL-DOB account that never sets a date keeps the byte-identical
 *      legacy-adult treatment.
 */

/** ISO date (UTC, date-only) exactly `years` years before now. */
function isoYearsAgo(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

const MINOR_DOB = isoYearsAgo(15);
const ADULT_DOB = isoYearsAgo(30);

/* ── Fake socket.io: fetchSockets for forceLogoutUser + the /rooms
 *    active-private-rooms lookup; in/to/emit for broadcast paths. ──────── */

class FakeSocket {
  id = nanoid();
  rooms = new Set<string>();
  data: { userId?: string } = {};
  emitted: Array<{ event: string; payload: unknown }> = [];
  emit(event: string, payload?: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }
  join(band: string): void { this.rooms.add(band); }
  leave(band: string): void { this.rooms.delete(band); }
  disconnect(_close?: boolean): void { /* transport stub */ }
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

async function insertRoom(
  db: Db,
  opts: { name: string; isNsfw?: boolean; isDefault?: boolean; isSystem?: boolean; linkedRoomId?: string },
): Promise<string> {
  const id = nanoid();
  await db.insert(schema.rooms).values({
    id,
    name: opts.name,
    slug: opts.name.toLowerCase(),
    type: "public",
    isNsfw: opts.isNsfw ?? false,
    isDefault: opts.isDefault ?? false,
    isSystem: opts.isSystem ?? false,
    ...(opts.linkedRoomId !== undefined ? { linkedRoomId: opts.linkedRoomId } : {}),
  });
  return id;
}

let db: Db;
let raw: ReturnType<typeof makeTestDb>["raw"];
let app: FastifyInstance;
let fakeSockets: FakeSocket[];
let nsfwRoomId: string;
let baseRoomId: string;
let annexRoomId: string;

before(async () => {
  ({ db, raw } = makeTestDb());
  fakeSockets = [];
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) { reply.code(400); return reply.send({ error: "validation" }); }
    throw err;
  });
  const io = makeFakeIo(fakeSockets);
  await registerCharacterRoutes(app, db, io);
  await registerRoomsRoutes(app, db, io);
  await app.ready();

  await insertRoom(db, { name: "The_Spire", isDefault: true, isSystem: true });
  await insertRoom(db, { name: "Tavern" });
  nsfwRoomId = await insertRoom(db, { name: "After_Dark", isNsfw: true });
  baseRoomId = await insertRoom(db, { name: "Parlor" });
  annexRoomId = await insertRoom(db, { name: "Parlor_Annex", isNsfw: true, linkedRoomId: baseRoomId });
  // A stamped 18+ line so the history route has something to serve/refuse.
  await db.insert(schema.messages).values({
    id: nanoid(),
    roomId: nsfwRoomId,
    userId: (await createUser(db, { birthdate: ADULT_DOB })).id,
    characterId: null,
    displayName: "author",
    kind: "say",
    body: "adults only line",
    isNsfw: true,
  });
});

after(async () => {
  await app.close();
  raw.close();
});

function post(tok: string, payload: object) {
  return app.inject({
    method: "POST",
    url: "/me/birthdate",
    headers: { ...auth(tok), "content-type": "application/json" },
    payload,
  });
}

async function birthdateOf(userId: string): Promise<string | null> {
  const row = (await db
    .select({ birthdate: schema.users.birthdate })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1))[0]!;
  return row.birthdate;
}

async function sessionCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(eq(schema.sessions.userId, userId));
  return rows.length;
}

async function roomNames(tok: string): Promise<Map<string, { linkedNsfwRoomId?: string | null }>> {
  const res = await app.inject({ method: "GET", url: "/rooms", headers: auth(tok) });
  assert.equal(res.statusCode, 200);
  const rooms = (res.json() as { rooms: Array<{ name: string; linkedNsfwRoomId?: string | null }> }).rooms;
  return new Map(rooms.map((r) => [r.name, r]));
}

describe("set-when-null (adult date)", () => {
  test("succeeds, persists, audits, and changes nothing behaviorally", async () => {
    const legacy = await createUser(db); // birthdate NULL
    const tok = await tokenFor(db, legacy.id);

    // Legacy adult sees the 18+ room and the annex pointer before the set.
    const beforeRooms = await roomNames(tok);
    assert.ok(beforeRooms.has("After_Dark"));
    assert.equal(beforeRooms.get("Parlor")!.linkedNsfwRoomId, annexRoomId);

    const res = await post(tok, { birthdate: ADULT_DOB });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, isAdult: true });
    assert.equal(await birthdateOf(legacy.id), ADULT_DOB);

    // Audited on the same stream as staff corrections, marked self-service.
    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetUserId, legacy.id));
    const dobAudit = audits.find((a) => a.action === "user_dob_update");
    assert.ok(dobAudit, "user_dob_update audit row written");
    const meta = JSON.parse(dobAudit!.metadataJson ?? "{}") as Record<string, unknown>;
    assert.equal(meta.selfService, true);
    assert.equal(meta.nextBirthdate, ADULT_DOB);
    assert.equal(meta.forcedLogout, false);

    // Adult date = no logout, no access change: same token still works and
    // the 18+ surface is untouched.
    assert.equal(await sessionCount(legacy.id), 1);
    const afterRooms = await roomNames(tok);
    assert.ok(afterRooms.has("After_Dark"));
    assert.ok(afterRooms.has("Parlor_Annex"));
    const history = await app.inject({
      method: "GET",
      url: `/rooms/${nsfwRoomId}/messages?before=${Date.now() + 1000}`,
      headers: auth(tok),
    });
    assert.equal(history.statusCode, 200);
  });

  test("second set is refused 409 and the stored date is untouched", async () => {
    const legacy = await createUser(db);
    const tok = await tokenFor(db, legacy.id);
    assert.equal((await post(tok, { birthdate: ADULT_DOB })).statusCode, 200);
    const again = await post(tok, { birthdate: MINOR_DOB });
    assert.equal(again.statusCode, 409);
    assert.equal(await birthdateOf(legacy.id), ADULT_DOB);
  });

  test("an account that registered with a date can never overwrite it", async () => {
    const signup = await createUser(db, { birthdate: ADULT_DOB });
    const tok = await tokenFor(db, signup.id);
    const res = await post(tok, { birthdate: MINOR_DOB });
    assert.equal(res.statusCode, 409);
    assert.equal(await birthdateOf(signup.id), ADULT_DOB);
  });
});

describe("validation", () => {
  test("impossible, future, implausibly-old, and malformed dates are 400s; the row stays NULL", async () => {
    const legacy = await createUser(db);
    const tok = await tokenFor(db, legacy.id);
    for (const bad of [
      "2007-02-31", // impossible calendar date
      isoYearsAgo(-1), // in the future
      "1850-01-01", // >130 years back (century typo)
      "01/01/1990", // non-ISO shape (zod regex)
      "1990-1-1", // non-padded shape (zod regex)
      isoYearsAgo(10), // under the 13-year floor (COPPA — never stored)
      isoYearsAgo(0), // age 0 (a picker left on today)
    ]) {
      const res = await post(tok, { birthdate: bad });
      assert.equal(res.statusCode, 400, `rejected: ${bad}`);
    }
    assert.equal(await birthdateOf(legacy.id), null);
    // No session damage from failed attempts.
    assert.equal(await sessionCount(legacy.id), 1);
  });

  test("anonymous callers get 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/me/birthdate",
      headers: { "content-type": "application/json" },
      payload: { birthdate: ADULT_DOB },
    });
    assert.equal(res.statusCode, 401);
  });
});

describe("set-when-null (minor date): the transition binds immediately", () => {
  test("sessions revoked, live sockets kicked, and the real age gates apply on the next sign-in", async () => {
    const legacy = await createUser(db);
    const tok = await tokenFor(db, legacy.id);
    await tokenFor(db, legacy.id); // a second device session
    const liveSocket = new FakeSocket();
    liveSocket.data.userId = legacy.id;
    fakeSockets.push(liveSocket);

    // While still legacy-adult, the minor-only isolation toggle is refused.
    const preIso = await app.inject({
      method: "PUT",
      url: "/me/profile",
      headers: { ...auth(tok), "content-type": "application/json" },
      payload: { isolateFromAdults: true },
    });
    assert.equal(preIso.statusCode, 400);

    const res = await post(tok, { birthdate: MINOR_DOB });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, isAdult: false });
    assert.equal(await birthdateOf(legacy.id), MINOR_DOB);

    // Authoritative logout: EVERY session row is gone (the stale adult
    // socket/session stamps can't outlive the change) and the live socket
    // got the kick events.
    assert.equal(await sessionCount(legacy.id), 0);
    assert.ok(liveSocket.emitted.some((e) => e.event === "session:kicked"));
    assert.ok(liveSocket.emitted.some((e) => e.event === "auth:expired"));

    // Next sign-in derives minor and the REAL gates compose:
    const freshTok = await tokenFor(db, legacy.id);
    const rooms = await roomNames(freshTok);
    assert.equal(rooms.has("After_Dark"), false, "18+ room scrubbed from GET /rooms");
    assert.equal(rooms.has("Parlor_Annex"), false, "annex row scrubbed from GET /rooms");
    assert.ok(rooms.has("Parlor"), "SFW base room survives");
    assert.equal(rooms.get("Parlor")!.linkedNsfwRoomId ?? null, null, "annex pointer scrubbed off the base");
    assert.ok(rooms.has("Tavern"));

    const history = await app.inject({
      method: "GET",
      url: `/rooms/${nsfwRoomId}/messages?before=${Date.now() + 1000}`,
      headers: auth(freshTok),
    });
    assert.equal(history.statusCode, 404, "18+ room reads refuse the new minor");

    // The minor-only isolation option is now available.
    const iso = await app.inject({
      method: "PUT",
      url: "/me/profile",
      headers: { ...auth(freshTok), "content-type": "application/json" },
      payload: { isolateFromAdults: true },
    });
    assert.equal(iso.statusCode, 200);
    const row = (await db
      .select({ isolateFromAdults: schema.users.isolateFromAdults })
      .from(schema.users)
      .where(eq(schema.users.id, legacy.id))
      .limit(1))[0]!;
    assert.equal(row.isolateFromAdults, true);
  });
});

describe("leaving it unset", () => {
  test("a NULL-DOB account that never sets a date keeps the legacy-adult treatment", async () => {
    const legacy = await createUser(db);
    const tok = await tokenFor(db, legacy.id);
    assert.equal(await birthdateOf(legacy.id), null);
    const rooms = await roomNames(tok);
    assert.ok(rooms.has("After_Dark"), "18+ room listed for the legacy adult");
    assert.ok(rooms.has("Parlor_Annex"));
    const history = await app.inject({
      method: "GET",
      url: `/rooms/${nsfwRoomId}/messages?before=${Date.now() + 1000}`,
      headers: auth(tok),
    });
    assert.equal(history.statusCode, 200);
  });
});
