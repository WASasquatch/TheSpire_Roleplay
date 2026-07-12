import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { registerRoomsRoutes } from "../src/routes/rooms.js";
import { registerServerConsoleRoutes } from "../src/routes/serversConsole.js";
import { serverAuthority, serverCan } from "../src/servers/authority.js";
import { getSessionUser } from "../src/routes/auth.js";
import type { ServerRoutesCtx } from "../src/routes/serversShared.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Room categories + manual ordering (migration 0344): the /rooms ORDER BY
 * (category position → room position → name), the `categories` response
 * block, category-delete SET NULL fallback, the minor pair-room scrub
 * staying byte-identical with categories in play, and the console routes'
 * manage_rooms gates.
 */

const MINOR_DOB = "2012-01-01";
const ADULT_DOB = "1990-01-01";

/* ── Fake socket.io: fetchSockets / in / to / emit, enough for the /rooms
 *    occupant fan-out and the console routes' broadcast calls. ──────────── */

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

interface RoomRow {
  id: string;
  name: string;
  categoryId?: string | null;
  linkedSfwRoomId?: string | null;
  linkedNsfwRoomId?: string | null;
}
interface RoomsPayload {
  rooms: RoomRow[];
  categories: Array<{ id: string; name: string; icon: string | null; sortOrder: number }>;
}

let db: Db;
let app: FastifyInstance;
let owner: { id: string; username: string };
let member: { id: string; username: string };
let mod: { id: string; username: string };
let minor: { id: string; username: string };
let ownerToken: string;
let memberToken: string;
let modToken: string;
let minorToken: string;
let serverA: string;
let serverB: string;
let catBId: string;

async function insertRoom(db2: Db, opts: {
  name: string; serverId?: string | null; categoryId?: string | null; sortOrder?: number;
  isNsfw?: boolean; linkedRoomId?: string | null;
}): Promise<string> {
  const id = nanoid();
  await db2.insert(schema.rooms).values({
    id,
    name: opts.name,
    slug: opts.name.toLowerCase().replace(/_/g, "-"),
    type: "public",
    isNsfw: opts.isNsfw ?? false,
    ...(opts.serverId !== undefined ? { serverId: opts.serverId } : {}),
    ...(opts.categoryId !== undefined ? { categoryId: opts.categoryId } : {}),
    ...(opts.sortOrder !== undefined ? { sortOrder: opts.sortOrder } : {}),
    ...(opts.linkedRoomId !== undefined ? { linkedRoomId: opts.linkedRoomId } : {}),
  });
  return id;
}

async function fetchRooms(token?: string): Promise<RoomsPayload> {
  const res = await app.inject({ method: "GET", url: "/rooms", ...(token ? { headers: auth(token) } : {}) });
  assert.equal(res.statusCode, 200);
  return res.json() as RoomsPayload;
}

before(async () => {
  db = makeTestDb().db;
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) { reply.code(400); return reply.send({ error: "validation" }); }
    throw err;
  });
  const io = makeFakeIo();
  await registerRoomsRoutes(app, db, io);
  registerServerConsoleRoutes(buildConsoleCtx(app, db, io));
  await app.ready();

  owner = await createUser(db, { birthdate: ADULT_DOB });
  member = await createUser(db, { birthdate: ADULT_DOB });
  mod = await createUser(db, { birthdate: ADULT_DOB });
  minor = await createUser(db, { birthdate: MINOR_DOB });
  ownerToken = await tokenFor(db, owner.id);
  memberToken = await tokenFor(db, member.id);
  modToken = await tokenFor(db, mod.id);
  minorToken = await tokenFor(db, minor.id);

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
    { serverId: serverA, userId: mod.id, role: "mod", permissionsJson: JSON.stringify(["manage_rooms"]) },
  ]);
});

describe("GET /rooms ordering + categories block", () => {
  test("(category position, room position, name) with uncategorized last", async () => {
    // Categories deliberately inserted out of display order.
    catBId = nanoid();
    const catAId = nanoid();
    await db.insert(schema.roomCategories).values([
      { id: catBId, serverId: serverA, name: "Second", icon: null, sortOrder: 1 },
      { id: catAId, serverId: serverA, name: "First", icon: "🎭", sortOrder: 0 },
    ]);
    await insertRoom(db, { name: "Ord_Zeta", serverId: serverA });
    await insertRoom(db, { name: "Ord_Alpha", serverId: serverA });
    await insertRoom(db, { name: "Ord_B1", serverId: serverA, categoryId: catBId });
    await insertRoom(db, { name: "Ord_A2", serverId: serverA, categoryId: catAId, sortOrder: 1 });
    await insertRoom(db, { name: "Ord_A3", serverId: serverA, categoryId: catAId, sortOrder: 1 });
    await insertRoom(db, { name: "Ord_A1", serverId: serverA, categoryId: catAId, sortOrder: 0 });

    const j = await fetchRooms(ownerToken);
    const names = j.rooms.map((r) => r.name).filter((n) => n.startsWith("Ord_"));
    // "First" (manual order, name-tiebreak on the 1/1 pair), then "Second",
    // then the uncategorized bucket LAST (alphabetical, sortOrder ties).
    assert.deepEqual(names, ["Ord_A1", "Ord_A2", "Ord_A3", "Ord_B1", "Ord_Alpha", "Ord_Zeta"]);

    // The categories block ships in strip order with the icon duality intact.
    assert.deepEqual(
      j.categories.map((c) => ({ name: c.name, icon: c.icon, sortOrder: c.sortOrder })),
      [
        { name: "First", icon: "🎭", sortOrder: 0 },
        { name: "Second", icon: null, sortOrder: 1 },
      ],
    );
    // Rows carry their categoryId pointer for the client's grouping.
    assert.equal(j.rooms.find((r) => r.name === "Ord_A1")!.categoryId, catAId);
    assert.equal(j.rooms.find((r) => r.name === "Ord_Alpha")!.categoryId, null);
  });

  test("deleting a category detaches its rooms back to uncategorized (rooms survive)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/servers/${serverA}/room-categories/${catBId}`,
      headers: auth(ownerToken),
    });
    assert.equal(res.statusCode, 200);
    const j = await fetchRooms(ownerToken);
    const b1 = j.rooms.find((r) => r.name === "Ord_B1");
    assert.ok(b1, "the category's room still exists");
    assert.equal(b1!.categoryId, null, "room fell back to the uncategorized bucket");
    assert.equal(j.categories.some((c) => c.name === "Second"), false);
    // Back in the trailing uncategorized bucket, ordered by name with the
    // others (categorized sections stay in front).
    const names = j.rooms.map((r) => r.name).filter((n) => n.startsWith("Ord_"));
    assert.deepEqual(names, ["Ord_A1", "Ord_A2", "Ord_A3", "Ord_Alpha", "Ord_B1", "Ord_Zeta"]);
  });
});

describe("minor pair-room scrub is category-proof", () => {
  test("annex stays dropped and the base row is byte-identical pre/post categories", async () => {
    const baseId = await insertRoom(db, { name: "Pair_Base", serverId: serverA });
    await insertRoom(db, {
      name: "Pair_Base_Adult", serverId: serverA, isNsfw: true, linkedRoomId: baseId,
    });

    const pairRows = (j: RoomsPayload) => j.rooms.filter((r) => r.name.startsWith("Pair_"));
    const pre = pairRows(await fetchRooms(minorToken));
    assert.equal(pre.length, 1, "minor receives only the SFW base");
    assert.equal(pre[0]!.name, "Pair_Base");
    assert.equal(pre[0]!.linkedNsfwRoomId, null, "annex pointer scrubbed for minors");
    assert.equal(pre[0]!.categoryId, null);

    // Categorize the ANNEX: nothing about the minor's payload may change.
    const catRes = await app.inject({
      method: "POST", url: `/servers/${serverA}/room-categories`,
      headers: auth(ownerToken), payload: { name: "Adults Corner" },
    });
    assert.equal(catRes.statusCode, 200);
    const catId = (catRes.json() as { id: string }).id;
    const annexRow = (await db.select().from(schema.rooms)
      .where(eq(schema.rooms.name, "Pair_Base_Adult")))[0]!;
    const annexPatch = await app.inject({
      method: "PATCH", url: `/servers/${serverA}/rooms/${annexRow.id}`,
      headers: auth(ownerToken), payload: { categoryId: catId },
    });
    assert.equal(annexPatch.statusCode, 200);
    const mid = pairRows(await fetchRooms(minorToken));
    assert.deepEqual(mid, pre, "categorizing the hidden annex changes nothing for a minor");

    // Categorize the BASE: the minor's row changes ONLY in categoryId.
    const basePatch = await app.inject({
      method: "PATCH", url: `/servers/${serverA}/rooms/${baseId}`,
      headers: auth(ownerToken), payload: { categoryId: catId },
    });
    assert.equal(basePatch.statusCode, 200);
    const post = pairRows(await fetchRooms(minorToken));
    assert.equal(post.length, 1, "annex still never reaches a minor");
    assert.deepEqual(post, [{ ...pre[0]!, categoryId: catId }]);

    // Adults still get the annex row and the base's live pointer.
    const adult = pairRows(await fetchRooms(ownerToken));
    assert.equal(adult.length, 2);
    assert.equal(adult.find((r) => r.name === "Pair_Base")!.linkedNsfwRoomId, annexRow.id);
  });
});

describe("category rows follow the room scrub", () => {
  test("an 18+ server's categories never reach a minor's unscoped payload", async () => {
    const nsfwServer = nanoid();
    await db.insert(schema.servers).values({
      id: nsfwServer, slug: `srv-${nsfwServer.slice(0, 6)}`, name: "Adults Only",
      ownerUserId: owner.id, isNsfw: true,
    });
    await db.insert(schema.roomCategories).values({
      id: nanoid(), serverId: nsfwServer, name: "Adults Strip", sortOrder: 0,
    });
    await insertRoom(db, { name: "Adult_Lounge", serverId: nsfwServer });

    // Minor: every room of the 18+ server is age-dropped, so its category
    // rows (names + icons are content too) must not ride along either.
    const asMinor = await fetchRooms(minorToken);
    assert.equal(asMinor.rooms.some((r) => r.name === "Adult_Lounge"), false);
    assert.equal(asMinor.categories.some((c) => c.name === "Adults Strip"), false);

    // Adult: both the room and its server's category strip arrive.
    const asAdult = await fetchRooms(ownerToken);
    assert.equal(asAdult.rooms.some((r) => r.name === "Adult_Lounge"), true);
    assert.equal(asAdult.categories.some((c) => c.name === "Adults Strip"), true);
  });
});

describe("console gates (manage_rooms)", () => {
  test("category create: 401 anonymous, 403 plain member, 200 owner and granted mod", async () => {
    const hit = async (token?: string) => app.inject({
      method: "POST", url: `/servers/${serverA}/room-categories`,
      ...(token ? { headers: auth(token) } : {}), payload: { name: "Gate Check" },
    });
    assert.equal((await hit()).statusCode, 401);
    assert.equal((await hit(memberToken)).statusCode, 403);
    assert.equal((await hit(minorToken)).statusCode, 403);
    const asMod = await hit(modToken);
    assert.equal(asMod.statusCode, 200);
    const asOwner = await hit(ownerToken);
    assert.equal(asOwner.statusCode, 200);
    // Appended to the end of the strip: each create takes the next slot.
    const j = await fetchRooms(ownerToken);
    const slots = j.categories.filter((c) => c.name === "Gate Check").map((c) => c.sortOrder);
    assert.equal(slots.length, 2);
    assert.ok(slots[1]! > slots[0]!, "create appends after the previous category");
  });

  test("room/category reorder + category edit/delete refuse non-holders", async () => {
    const roomId = (await db.select({ id: schema.rooms.id }).from(schema.rooms)
      .where(eq(schema.rooms.name, "Ord_Alpha")))[0]!.id;
    const catId = (await db.select({ id: schema.roomCategories.id }).from(schema.roomCategories)
      .where(eq(schema.roomCategories.name, "Adults Corner")))[0]!.id;
    const cases: Array<{ method: "PUT" | "PATCH" | "DELETE"; url: string; payload?: unknown }> = [
      { method: "PUT", url: `/servers/${serverA}/rooms/order`, payload: { roomIds: [roomId] } },
      { method: "PUT", url: `/servers/${serverA}/room-categories/order`, payload: { categoryIds: [catId] } },
      { method: "PATCH", url: `/servers/${serverA}/room-categories/${catId}`, payload: { name: "Nope" } },
      { method: "DELETE", url: `/servers/${serverA}/room-categories/${catId}` },
    ];
    for (const c of cases) {
      const res = await app.inject({
        method: c.method, url: c.url, headers: auth(memberToken),
        ...(c.payload !== undefined ? { payload: c.payload } : {}),
      });
      assert.equal(res.statusCode, 403, `${c.method} ${c.url} must refuse a plain member`);
    }
  });

  test("a category from another server reads as not-found on room patch", async () => {
    const foreignCat = nanoid();
    await db.insert(schema.roomCategories).values({
      id: foreignCat, serverId: serverB, name: "Foreign", sortOrder: 0,
    });
    const roomId = (await db.select({ id: schema.rooms.id }).from(schema.rooms)
      .where(eq(schema.rooms.name, "Ord_Alpha")))[0]!.id;
    const res = await app.inject({
      method: "PATCH", url: `/servers/${serverA}/rooms/${roomId}`,
      headers: auth(ownerToken), payload: { categoryId: foreignCat },
    });
    assert.equal(res.statusCode, 404);
  });

  test("rooms/order stamps manual order and refuses foreign rooms", async () => {
    const rows = await db.select({ id: schema.rooms.id, name: schema.rooms.name })
      .from(schema.rooms);
    const alpha = rows.find((r) => r.name === "Ord_Alpha")!.id;
    const zeta = rows.find((r) => r.name === "Ord_Zeta")!.id;
    const b1 = rows.find((r) => r.name === "Ord_B1")!.id;
    const ok = await app.inject({
      method: "PUT", url: `/servers/${serverA}/rooms/order`,
      headers: auth(modToken), payload: { roomIds: [zeta, b1, alpha] },
    });
    assert.equal(ok.statusCode, 200);
    const names = (await fetchRooms(ownerToken)).rooms
      .map((r) => r.name)
      .filter((n) => ["Ord_Alpha", "Ord_Zeta", "Ord_B1"].includes(n));
    assert.deepEqual(names, ["Ord_Zeta", "Ord_B1", "Ord_Alpha"]);

    // A room from another server 404s the whole reorder.
    const foreignRoom = await insertRoom(db, { name: "Foreign_Room", serverId: serverB });
    const bad = await app.inject({
      method: "PUT", url: `/servers/${serverA}/rooms/order`,
      headers: auth(ownerToken), payload: { roomIds: [alpha, foreignRoom] },
    });
    assert.equal(bad.statusCode, 404);
  });
});
