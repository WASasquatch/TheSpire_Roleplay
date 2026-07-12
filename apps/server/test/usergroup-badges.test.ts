import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { registerServerConsoleRoutes } from "../src/routes/serversConsole.js";
import { serverAuthority, serverCan } from "../src/servers/authority.js";
import { getSessionUser } from "../src/routes/auth.js";
import type { ServerRoutesCtx } from "../src/routes/serversShared.js";
import { ensureDefaultUsergroup, userlistBadgesFor } from "../src/servers/usergroups.js";
import { currentOccupants } from "../src/realtime/broadcast.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Usergroup userlist badges (migration 0348): the batched badge pick
 * (highest sort_order group with show_badge wins; default groups and other
 * servers' groups excluded), the badge riding the shared occupant payload
 * (per-account, so character rows wear it too; incognito rows drop badge
 * and all), the console's showBadge toggle gate + audit + default-group
 * force-off, and order persistence through the PUT order routes the
 * console's drag-reorder and arrows both use.
 */

/* ── Fake socket.io: per-room socket sets for currentOccupants, plus the
 *    no-op emit surface the console routes' broadcasts reach. ──────────── */

type FakeSocket = { data: { userId: string; tabCharId: string | null | undefined } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeIo(socketsByRoom: Map<string, FakeSocket[]> = new Map()): any {
  return {
    async fetchSockets() { return []; },
    in(band: string) {
      return {
        async fetchSockets() { return socketsByRoom.get(band.replace(/^room:/, "")) ?? []; },
        emit() { /* no live sockets in these tests */ },
      };
    },
    to() { return { emit() { /* no-op */ } }; },
    emit() { /* no-op */ },
  };
}

/** Mirror of the ctx routes/servers.ts builds: the REAL authority gates over
 *  the test DB, with the flag check and image writers stubbed out. */
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
let socketsByRoom: Map<string, FakeSocket[]>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let io: any;
let owner: { id: string; username: string };
let member: { id: string; username: string };
let roomsMod: { id: string; username: string };
let ownerToken: string;
let memberToken: string;
let roomsModToken: string;
let serverA: string;
let serverB: string;
let groupLow: string; // sortOrder 0, showBadge, colored
let groupMid: string; // sortOrder 5, NO showBadge
let groupHigh: string; // sortOrder 9, showBadge, no color

async function insertGroup(opts: {
  serverId: string; name: string; sortOrder: number; showBadge: boolean;
  color?: string | null; createdAt?: number;
}): Promise<string> {
  const id = nanoid();
  await db.insert(schema.serverUsergroups).values({
    id,
    serverId: opts.serverId,
    name: opts.name,
    color: opts.color ?? null,
    sortOrder: opts.sortOrder,
    showBadge: opts.showBadge,
    ...(opts.createdAt !== undefined ? { createdAt: new Date(opts.createdAt) } : {}),
  });
  return id;
}

async function joinGroup(groupId: string, userId: string): Promise<void> {
  await db.insert(schema.serverUsergroupMembers).values({ groupId, userId }).onConflictDoNothing();
}

before(async () => {
  db = makeTestDb().db;
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) { reply.code(400); return reply.send({ error: "validation" }); }
    throw err;
  });
  socketsByRoom = new Map();
  io = makeFakeIo(socketsByRoom);
  registerServerConsoleRoutes(buildConsoleCtx(app, db, io));
  await app.ready();

  owner = await createUser(db);
  member = await createUser(db);
  roomsMod = await createUser(db);
  ownerToken = await tokenFor(db, owner.id);
  memberToken = await tokenFor(db, member.id);
  roomsModToken = await tokenFor(db, roomsMod.id);

  serverA = nanoid();
  await db.insert(schema.servers).values({
    id: serverA, slug: `srv-${serverA.slice(0, 6)}`, name: "Server A", ownerUserId: owner.id,
  });
  serverB = nanoid();
  await db.insert(schema.servers).values({
    id: serverB, slug: `srv-${serverB.slice(0, 6)}`, name: "Server B", ownerUserId: owner.id,
  });
  await db.insert(schema.serverMembers).values([
    { serverId: serverA, userId: member.id, role: "member" },
    // manage_rooms but NOT manage_usergroups: must be refused by the toggle.
    { serverId: serverA, userId: roomsMod.id, role: "mod", permissionsJson: JSON.stringify(["manage_rooms"]) },
  ]);

  // Explicit createdAt values keep the (sortOrder, createdAt) ordering
  // deterministic — the default stamps land in the same millisecond here.
  groupLow = await insertGroup({ serverId: serverA, name: "Regulars", sortOrder: 0, showBadge: true, color: "#112233", createdAt: 1_000 });
  groupMid = await insertGroup({ serverId: serverA, name: "Silent", sortOrder: 5, showBadge: false, color: "#445566", createdAt: 2_000 });
  groupHigh = await insertGroup({ serverId: serverA, name: "Veterans", sortOrder: 9, showBadge: true, color: null, createdAt: 3_000 });
});

describe("badge pick math (userlistBadgesFor)", () => {
  test("highest sort_order group with show_badge wins; opted-out groups never show", async () => {
    const one = await createUser(db);
    const many = await createUser(db);
    const silent = await createUser(db);
    await joinGroup(groupLow, one.id);
    await joinGroup(groupLow, many.id);
    await joinGroup(groupMid, many.id);
    await joinGroup(groupHigh, many.id);
    await joinGroup(groupMid, silent.id);

    const picks = await userlistBadgesFor(db, serverA, [one.id, many.id, silent.id]);
    assert.deepEqual(picks.get(one.id), { name: "Regulars", color: "#112233" });
    // sortOrder 9 beats 0; the sortOrder-5 group is skipped (showBadge off).
    assert.deepEqual(picks.get(many.id), { name: "Veterans", color: null });
    assert.equal(picks.has(silent.id), false, "a user only in opted-out groups wears nothing");
  });

  test("no badge when no group opts in, and empty inputs stay empty", async () => {
    const nobody = await createUser(db);
    const picks = await userlistBadgesFor(db, serverA, [nobody.id]);
    assert.equal(picks.size, 0);
    assert.equal((await userlistBadgesFor(db, serverA, [])).size, 0);
  });

  test("default groups are excluded even with show_badge forced on the row", async () => {
    const def = await ensureDefaultUsergroup(db, serverA);
    // Bypass the console's force-off to prove the READ side excludes it too.
    await db.update(schema.serverUsergroups)
      .set({ showBadge: true })
      .where(eq(schema.serverUsergroups.id, def.id));
    const u = await createUser(db);
    await db.insert(schema.serverUsergroupMembers).values({ groupId: def.id, userId: u.id });
    const picks = await userlistBadgesFor(db, serverA, [u.id]);
    assert.equal(picks.has(u.id), false, "the default group can never badge");
    await db.update(schema.serverUsergroups)
      .set({ showBadge: false })
      .where(eq(schema.serverUsergroups.id, def.id));
  });

  test("another server's badge groups never leak into this server's pick", async () => {
    const u = await createUser(db);
    const foreign = await insertGroup({ serverId: serverB, name: "Elsewhere", sortOrder: 99, showBadge: true, createdAt: 4_000 });
    await joinGroup(foreign, u.id);
    const picks = await userlistBadgesFor(db, serverA, [u.id]);
    assert.equal(picks.has(u.id), false);
  });
});

describe("occupant payload carries the badge (shared, per-account, scrub-consistent)", () => {
  test("badge rides master AND character rows; incognito drops the whole row", async () => {
    const roomId = nanoid();
    await db.insert(schema.rooms).values({
      id: roomId, name: "Badge_Hall", slug: "badge-hall", type: "public", serverId: serverA,
    });
    const badged = await createUser(db);
    const plain = await createUser(db);
    const hidden = await createUser(db);
    await joinGroup(groupHigh, badged.id);
    await joinGroup(groupHigh, hidden.id);
    const charId = nanoid();
    await db.insert(schema.characters).values({ id: charId, userId: badged.id, name: "Zara" });
    // OOC-incognito: the hidden identity must not surface at all (the badge
    // attaches to rows that survive the existing scrubs — nothing more).
    await db.update(schema.users).set({ incognitoMode: true }).where(eq(schema.users.id, hidden.id));

    socketsByRoom.set(roomId, [
      { data: { userId: badged.id, tabCharId: null } },
      { data: { userId: badged.id, tabCharId: charId } },
      { data: { userId: plain.id, tabCharId: null } },
      { data: { userId: hidden.id, tabCharId: null } },
    ]);
    const occ = await currentOccupants(io, db, roomId);
    socketsByRoom.delete(roomId);

    assert.equal(occ.length, 3, "incognito row is gone entirely");
    const ooc = occ.find((o) => o.userId === badged.id && o.characterId === null);
    const inChar = occ.find((o) => o.userId === badged.id && o.characterId === charId);
    const bare = occ.find((o) => o.userId === plain.id);
    assert.deepEqual(ooc?.badge, { name: "Veterans", color: null });
    assert.deepEqual(inChar?.badge, { name: "Veterans", color: null }, "per-account badge shows on character rows too");
    assert.equal(bare?.badge, null, "no opted-in membership → explicit null on the wire");
    assert.equal(occ.some((o) => o.userId === hidden.id), false);
  });
});

describe("console showBadge toggle: gate + audit + default force-off", () => {
  test("PATCH showBadge: 401 anonymous, 403 member, 403 mod without manage_usergroups, 200 owner (+audit)", async () => {
    const hit = async (token?: string) => app.inject({
      method: "PATCH", url: `/servers/${serverA}/usergroups/${groupMid}`,
      ...(token ? { headers: auth(token) } : {}), payload: { showBadge: true },
    });
    assert.equal((await hit()).statusCode, 401);
    assert.equal((await hit(memberToken)).statusCode, 403);
    assert.equal((await hit(roomsModToken)).statusCode, 403);

    const auditsBefore = (await db.select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.serverId, serverA), eq(schema.auditLog.action, "server_usergroup_change")))).length;
    assert.equal((await hit(ownerToken)).statusCode, 200);

    const list = await app.inject({ method: "GET", url: `/servers/${serverA}/usergroups`, headers: auth(ownerToken) });
    assert.equal(list.statusCode, 200);
    const groups = (list.json() as { groups: Array<{ id: string; showBadge: boolean; isDefault: boolean }> }).groups;
    assert.equal(groups.find((g) => g.id === groupMid)?.showBadge, true);

    const auditsAfter = (await db.select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.serverId, serverA), eq(schema.auditLog.action, "server_usergroup_change")))).length;
    assert.equal(auditsAfter, auditsBefore + 1, "the toggle lands in the per-server mod log");

    // Restore for the pick-math invariants above (suite order independence).
    await db.update(schema.serverUsergroups).set({ showBadge: false })
      .where(eq(schema.serverUsergroups.id, groupMid));
  });

  test("the default group refuses the badge (forced off) and create honors showBadge", async () => {
    const def = await ensureDefaultUsergroup(db, serverA);
    const res = await app.inject({
      method: "PATCH", url: `/servers/${serverA}/usergroups/${def.id}`,
      headers: auth(ownerToken), payload: { showBadge: true },
    });
    assert.equal(res.statusCode, 200);
    const defRow = (await db.select().from(schema.serverUsergroups)
      .where(eq(schema.serverUsergroups.id, def.id)))[0]!;
    assert.equal(!!defRow.showBadge, false, "showBadge is forced off on the default group");

    const created = await app.inject({
      method: "POST", url: `/servers/${serverA}/usergroups`,
      headers: auth(ownerToken), payload: { name: "Heralds", showBadge: true },
    });
    assert.equal(created.statusCode, 200);
    const createdId = (created.json() as { id: string }).id;
    const row = (await db.select().from(schema.serverUsergroups)
      .where(eq(schema.serverUsergroups.id, createdId)))[0]!;
    assert.equal(!!row.showBadge, true);
    await db.delete(schema.serverUsergroups).where(eq(schema.serverUsergroups.id, createdId));
  });
});

describe("order persistence through the existing PUT routes (the drag path)", () => {
  test("a full-strip category order stamps sortOrder = index", async () => {
    const ids: string[] = [];
    for (const name of ["Strip One", "Strip Two", "Strip Three"]) {
      const res = await app.inject({
        method: "POST", url: `/servers/${serverA}/room-categories`,
        headers: auth(ownerToken), payload: { name },
      });
      assert.equal(res.statusCode, 200);
      ids.push((res.json() as { id: string }).id);
    }
    // The drag drop sends the whole strip in its new visual order.
    const dropped = [ids[2]!, ids[0]!, ids[1]!];
    const put = await app.inject({
      method: "PUT", url: `/servers/${serverA}/room-categories/order`,
      headers: auth(ownerToken), payload: { categoryIds: dropped },
    });
    assert.equal(put.statusCode, 200);
    const rows = await db.select({ id: schema.roomCategories.id, sortOrder: schema.roomCategories.sortOrder })
      .from(schema.roomCategories).where(eq(schema.roomCategories.serverId, serverA));
    const orderOf = new Map(rows.map((r) => [r.id, r.sortOrder]));
    assert.deepEqual(dropped.map((id) => orderOf.get(id)), [0, 1, 2]);
  });

  test("a bucket's room order stamps sortOrder = index", async () => {
    const ids: string[] = [];
    for (const name of ["Drag_A", "Drag_B", "Drag_C"]) {
      const id = nanoid();
      await db.insert(schema.rooms).values({
        id, name, slug: name.toLowerCase().replace(/_/g, "-"), type: "public", serverId: serverA,
      });
      ids.push(id);
    }
    const dropped = [ids[1]!, ids[2]!, ids[0]!];
    const put = await app.inject({
      method: "PUT", url: `/servers/${serverA}/rooms/order`,
      headers: auth(ownerToken), payload: { roomIds: dropped },
    });
    assert.equal(put.statusCode, 200);
    const rows = await db.select({ id: schema.rooms.id, sortOrder: schema.rooms.sortOrder })
      .from(schema.rooms).where(eq(schema.rooms.serverId, serverA));
    const orderOf = new Map(rows.map((r) => [r.id, r.sortOrder]));
    assert.deepEqual(dropped.map((id) => orderOf.get(id)), [0, 1, 2]);
  });
});
