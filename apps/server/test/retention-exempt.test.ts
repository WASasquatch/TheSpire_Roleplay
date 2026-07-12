import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { sweepExpiredMessages } from "../src/seed.js";
import { registerRoomsRoutes } from "../src/routes/rooms.js";
import { registerServerConsoleRoutes } from "../src/routes/serversConsole.js";
import { serverAuthority, serverCan } from "../src/servers/authority.js";
import { getSessionUser } from "../src/routes/auth.js";
import type { ServerRoutesCtx } from "../src/routes/serversShared.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * "Never expire" (rooms.retention_exempt, migration 0347): the janitor skips
 * exempt rooms in BOTH the per-server retention pass and the per-room expiry
 * pass; the console PATCH gates on manage_rooms and keeps the two lifetime
 * knobs coherent; the dossier route surfaces the flag for the "Never" copy.
 */

const ADULT_DOB = "1990-01-01";
const silentLog = { info: () => {}, error: () => {} };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeIo(): any {
  return {
    async fetchSockets() { return []; },
    in() {
      return {
        async fetchSockets() { return []; },
        emit() { /* no live sockets in these tests */ },
      };
    },
    to() { return { emit() { /* no-op */ } }; },
    emit() { /* no-op */ },
  };
}

/** Mirror of the ctx routes/servers.ts builds (same as room-categories.test). */
function buildConsoleCtx(app: FastifyInstance, db: Db, io: unknown): ServerRoutesCtx {
  const requireServerPermission: ServerRoutesCtx["requireServerPermission"] = async (req, serverId, key) => {
    const me = await getSessionUser(req, db);
    if (!me) return { fail: { code: 401, error: "auth" } };
    const a = await serverAuthority(db, me, serverId);
    if (!a.server) return { fail: { code: 404, error: "no server" } };
    if (!serverCan(a, key)) return { fail: { code: 403, error: "you don't have that server permission" } };
    return { me, server: a.server, authority: a };
  };
  return {
    app,
    db,
    io: io as ServerRoutesCtx["io"],
    serversLive: async () => true,
    requireServerOwner: async (req, serverId) => {
      const me = await getSessionUser(req, db);
      if (!me) return { fail: { code: 401, error: "auth" } };
      const a = await serverAuthority(db, me, serverId);
      if (!a.server) return { fail: { code: 404, error: "no server" } };
      if (!a.isOwner) return { fail: { code: 403, error: "server owner only" } };
      return { me, server: a.server, authority: a };
    },
    requireServerPermission,
    resolveServerTarget: async () => ({ ok: false, error: "unused in these tests" }),
    writeServerImage: async () => ({ error: "unused in these tests", status: 400 }),
    unlinkServerImage: () => {},
  };
}

let db: Db;
let app: FastifyInstance;
let owner: { id: string; username: string };
let member: { id: string; username: string };
let ownerToken: string;
let memberToken: string;
let serverId: string;

const HOUR = 60 * 60 * 1000;

async function insertRoom(opts: {
  name: string; serverId?: string | null; messageExpiryMinutes?: number | null;
  retentionExempt?: boolean; replyMode?: "flat" | "nested";
}): Promise<string> {
  const id = nanoid();
  await db.insert(schema.rooms).values({
    id,
    name: opts.name,
    slug: opts.name.toLowerCase().replace(/_/g, "-"),
    type: "public",
    ownerId: owner.id,
    replyMode: opts.replyMode ?? "flat",
    retentionExempt: opts.retentionExempt ?? false,
    ...(opts.serverId !== undefined ? { serverId: opts.serverId } : {}),
    ...(opts.messageExpiryMinutes !== undefined ? { messageExpiryMinutes: opts.messageExpiryMinutes } : {}),
  });
  return id;
}

async function insertMessage(roomId: string, body: string, ageMs: number): Promise<string> {
  const id = nanoid();
  await db.insert(schema.messages).values({
    id,
    roomId,
    userId: owner.id,
    displayName: owner.username,
    kind: "say",
    body,
    createdAt: new Date(Date.now() - ageMs),
  });
  return id;
}

async function roomBodies(roomId: string): Promise<string[]> {
  return (await db.select({ body: schema.messages.body }).from(schema.messages)
    .where(eq(schema.messages.roomId, roomId))).map((r) => r.body).sort();
}

before(async () => {
  db = makeTestDb().db;
  app = Fastify();
  const io = makeFakeIo();
  await registerRoomsRoutes(app, db, io);
  registerServerConsoleRoutes(buildConsoleCtx(app, db, io));
  await app.ready();

  owner = await createUser(db, { birthdate: ADULT_DOB });
  member = await createUser(db, { birthdate: ADULT_DOB });
  ownerToken = await tokenFor(db, owner.id);
  memberToken = await tokenFor(db, member.id);

  serverId = nanoid();
  await db.insert(schema.servers).values({
    id: serverId, slug: `srv-${serverId.slice(0, 6)}`, name: "Retention Server", ownerUserId: owner.id,
  });
  await db.insert(schema.serverMembers).values({ serverId, userId: member.id, role: "member" });
  // A 1-hour retention window for THIS server (inserted before any
  // getServerSettings call so the per-serverId cache never sees a stale row).
  await db.insert(schema.serverSettings).values({ serverId, messageRetentionMs: HOUR });
});

describe("janitor: retention_exempt rooms are skipped in BOTH passes", () => {
  test("server retention pass purges normal rooms and skips exempt ones", async () => {
    const normal = await insertRoom({ name: "Ret_Normal", serverId });
    const exempt = await insertRoom({ name: "Ret_Exempt", serverId, retentionExempt: true });
    await insertMessage(normal, "old-normal", 2 * HOUR);
    await insertMessage(normal, "fresh-normal", 0);
    await insertMessage(exempt, "old-exempt", 2 * HOUR);
    await insertMessage(exempt, "fresh-exempt", 0);

    await sweepExpiredMessages(db, silentLog);

    assert.deepEqual(await roomBodies(normal), ["fresh-normal"], "normal room purged past the window");
    assert.deepEqual(await roomBodies(exempt), ["fresh-exempt", "old-exempt"], "exempt room keeps everything");
  });

  test("per-room expiry pass skips exempt rooms even with a stale minutes value", async () => {
    // serverId NULL homes to the default server (retention 0 = keep), so
    // only the per-room expiry pass is in play for these two.
    const expiring = await insertRoom({ name: "Exp_Room", serverId: null, messageExpiryMinutes: 30 });
    const exemptStale = await insertRoom({
      name: "Exp_Exempt", serverId: null, messageExpiryMinutes: 30, retentionExempt: true,
    });
    await insertMessage(expiring, "old-expiring", 2 * HOUR);
    await insertMessage(expiring, "fresh-expiring", 0);
    await insertMessage(exemptStale, "old-kept", 2 * HOUR);

    await sweepExpiredMessages(db, silentLog);

    assert.deepEqual(await roomBodies(expiring), ["fresh-expiring"], "expiry room purged past its window");
    assert.deepEqual(await roomBodies(exemptStale), ["old-kept"], "the exemption outranks the stale minutes value");
  });
});

describe("console lifetime + post-mode writes (manage_rooms gate)", () => {
  let roomId: string;
  before(async () => {
    roomId = await insertRoom({ name: "Console_Room", serverId, messageExpiryMinutes: 15 });
  });

  const patch = (token: string | undefined, payload: unknown) => app.inject({
    method: "PATCH", url: `/servers/${serverId}/rooms/${roomId}`,
    ...(token ? { headers: auth(token) } : {}), payload,
  });

  test("401 anonymous, 403 plain member, 200 owner", async () => {
    assert.equal((await patch(undefined, { retentionExempt: true })).statusCode, 401);
    assert.equal((await patch(memberToken, { retentionExempt: true })).statusCode, 403);
    assert.equal((await patch(memberToken, { postMode: "staff" })).statusCode, 403);
    const ok = await patch(ownerToken, { retentionExempt: true, messageExpiryMinutes: null });
    assert.equal(ok.statusCode, 200);
    const row = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId)))[0]!;
    assert.equal(row.retentionExempt, true);
    assert.equal(row.messageExpiryMinutes, null, "the lifetime select clears the minutes alongside");
  });

  test("post mode patches through the same gate", async () => {
    const ok = await patch(ownerToken, { postMode: "staff" });
    assert.equal(ok.statusCode, 200);
    const row = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId)))[0]!;
    assert.equal(row.postMode, "staff");
  });

  test("the exempt room now survives a sweep", async () => {
    await insertMessage(roomId, "old-console", 2 * HOUR);
    await sweepExpiredMessages(db, silentLog);
    assert.deepEqual(await roomBodies(roomId), ["old-console"]);
  });
});

describe("dossier copy source (GET /rooms/:id/info)", () => {
  test("retentionExempt rides the dossier so the auto-expire row reads Never", async () => {
    const exemptId = await insertRoom({ name: "Dossier_Never", serverId, retentionExempt: true });
    const res = await app.inject({
      method: "GET", url: `/rooms/${exemptId}/info`, headers: auth(memberToken),
    });
    assert.equal(res.statusCode, 200);
    const info = (res.json() as { info: { retentionExempt?: boolean; messageExpiryMinutes: number | null } }).info;
    assert.equal(info.retentionExempt, true);

    const normalId = await insertRoom({ name: "Dossier_Minutes", serverId, messageExpiryMinutes: 45 });
    const res2 = await app.inject({
      method: "GET", url: `/rooms/${normalId}/info`, headers: auth(memberToken),
    });
    const info2 = (res2.json() as { info: { retentionExempt?: boolean; messageExpiryMinutes: number | null } }).info;
    assert.equal(info2.retentionExempt, false);
    assert.equal(info2.messageExpiryMinutes, 45);
  });

  test("GET /rooms rows carry retentionExempt for the header strip guard", async () => {
    const res = await app.inject({ method: "GET", url: "/rooms", headers: auth(memberToken) });
    const rows = (res.json() as { rooms: Array<{ name: string; retentionExempt?: boolean }> }).rooms;
    assert.equal(rows.find((r) => r.name === "Dossier_Never")!.retentionExempt, true);
    assert.equal(rows.find((r) => r.name === "Ret_Normal")!.retentionExempt, false);
  });
});
