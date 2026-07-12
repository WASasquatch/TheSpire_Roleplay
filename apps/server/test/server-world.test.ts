import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { registerServerCatalogRoutes } from "../src/routes/serversCatalog.js";
import { registerServerConsoleRoutes } from "../src/routes/serversConsole.js";
import { registerServerMembershipRoutes } from "../src/routes/serversMembership.js";
import { registerWorldCoreRoutes } from "../src/routes/worlds/core.js";
import { serverAuthority, serverCan } from "../src/servers/authority.js";
import { getSessionUser } from "../src/routes/auth.js";
import { buildRoomSummary } from "../src/realtime/broadcast.js";
import { updateSettings } from "../src/settings.js";
import type { ServerRoutesCtx } from "../src/routes/serversShared.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Server ↔ world link (servers.world_id, migration 0346): the console PATCH
 * gate (manage_appearance + owns-or-collaborates), the viewer-gated `world`
 * ref on /servers, /servers/:id and /servers/public/:slug (a private world
 * must read as null to anyone but its owner — the no-name-leak contract),
 * and the buildRoomSummary chat-banner fallback (explicit room link wins;
 * no link inherits the server world; flag-off stays byte-identical).
 */

const ADULT_DOB = "1990-01-01";
const MINOR_DOB = "2012-01-01";

/* ── Fake socket.io: enough for the catalog's socket-registry reads and the
 *    console routes' broadcast calls. ─────────────────────────────────────── */

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
function buildCtx(app: FastifyInstance, db: Db, io: unknown): ServerRoutesCtx {
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

interface WorldRef { id: string; slug: string; name: string }
interface CatalogRow { id: string; world?: WorldRef | null }

let db: Db;
let app: FastifyInstance;
let owner: { id: string; username: string };
let member: { id: string; username: string };
let stranger: { id: string; username: string };
let minor: { id: string; username: string };
let ownerToken: string;
let memberToken: string;
let minorToken: string;
let serverA: string;
let serverASlug: string;
let serverB: string;
let privateWorld: string;   // owner's, visibility=private
let openWorld: string;      // owner's, visibility=open
let nsfwWorld: string;      // owner's, visibility=public, 18+
let strangersWorld: string;   // stranger's, private, owner NOT a collaborator
let collabWorld: string;      // stranger's, private, owner IS a collaborator
let collabPublicWorld: string; // stranger's, public, owner IS a collaborator

async function mkWorld(ownerId: string, opts: {
  name: string; visibility: "private" | "public" | "open"; isNsfw?: boolean;
}): Promise<string> {
  const id = nanoid();
  await db.insert(schema.worlds).values({
    id,
    ownerUserId: ownerId,
    slug: opts.name.toLowerCase(),
    name: opts.name,
    visibility: opts.visibility,
    isNsfw: opts.isNsfw ?? false,
  });
  return id;
}

async function insertRoom(opts: { name: string; serverId: string; isNsfw?: boolean }): Promise<string> {
  const id = nanoid();
  await db.insert(schema.rooms).values({
    id,
    name: opts.name,
    slug: opts.name.toLowerCase().replace(/_/g, "-"),
    type: "public",
    serverId: opts.serverId,
    isNsfw: opts.isNsfw ?? false,
  });
  return id;
}

async function patchServer(id: string, token: string, body: unknown): Promise<{ status: number; json: { error?: string } }> {
  const res = await app.inject({
    method: "PATCH",
    url: `/servers/${id}`,
    headers: { ...auth(token), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, json: res.json() as { error?: string } };
}

async function serverWorldId(id: string): Promise<string | null> {
  return (await db.select({ w: schema.servers.worldId }).from(schema.servers)
    .where(eq(schema.servers.id, id)))[0]?.w ?? null;
}

before(async () => {
  db = makeTestDb().db;
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) { reply.code(400); return reply.send({ error: "validation" }); }
    throw err;
  });
  const io = makeFakeIo();
  const ctx = buildCtx(app, db, io);
  registerServerCatalogRoutes(ctx);
  registerServerConsoleRoutes(ctx);
  registerServerMembershipRoutes(ctx);
  await registerWorldCoreRoutes(app, db, io);
  await app.ready();

  owner = await createUser(db, { birthdate: ADULT_DOB });
  member = await createUser(db, { birthdate: ADULT_DOB });
  stranger = await createUser(db, { birthdate: ADULT_DOB });
  minor = await createUser(db, { birthdate: MINOR_DOB });
  ownerToken = await tokenFor(db, owner.id);
  memberToken = await tokenFor(db, member.id);
  minorToken = await tokenFor(db, minor.id);

  // buildRoomSummary only pays the server-world fallback read when the
  // servers feature is live (areServersEnabledCached).
  await updateSettings(db, { serversEnabled: true }, owner.id);

  serverA = nanoid();
  serverASlug = `srv-${serverA.slice(0, 6).toLowerCase()}`;
  await db.insert(schema.servers).values({
    id: serverA, slug: serverASlug, name: "Server A", ownerUserId: owner.id,
  });
  serverB = nanoid();
  await db.insert(schema.servers).values({
    id: serverB, slug: `srv-${serverB.slice(0, 6).toLowerCase()}`, name: "Server B", ownerUserId: owner.id,
  });
  await db.insert(schema.serverMembers).values([
    { serverId: serverA, userId: member.id, role: "member" },
    { serverId: serverA, userId: minor.id, role: "member" },
    // manage_rooms is a real grant but NOT manage_appearance (owner-only).
    { serverId: serverA, userId: stranger.id, role: "mod", permissionsJson: JSON.stringify(["manage_rooms"]) },
  ]);

  privateWorld = await mkWorld(owner.id, { name: "Umbra", visibility: "private" });
  openWorld = await mkWorld(owner.id, { name: "Aster", visibility: "open" });
  nsfwWorld = await mkWorld(owner.id, { name: "Noir", visibility: "public", isNsfw: true });
  strangersWorld = await mkWorld(stranger.id, { name: "Yonder", visibility: "private" });
  collabWorld = await mkWorld(stranger.id, { name: "Twain", visibility: "private" });
  collabPublicWorld = await mkWorld(stranger.id, { name: "Solace", visibility: "public" });
  await db.insert(schema.worldCollaborators).values([
    { worldId: collabWorld, userId: owner.id, addedByUserId: stranger.id },
    { worldId: collabPublicWorld, userId: owner.id, addedByUserId: stranger.id },
  ]);
});

describe("console gate (PATCH /servers/:id worldId)", () => {
  test("manage_rooms mod is refused: the picker is manage_appearance (owner) tier", async () => {
    const modToken = await tokenFor(db, stranger.id);
    const r = await patchServer(serverA, modToken, { worldId: strangersWorld });
    assert.equal(r.status, 403);
    assert.equal(await serverWorldId(serverA), null);
  });

  test("owner can't feature a world they neither own nor collaborate on", async () => {
    const r = await patchServer(serverA, ownerToken, { worldId: strangersWorld });
    assert.equal(r.status, 403);
    assert.equal(await serverWorldId(serverA), null);
  });

  test("a missing world id is refused with the same error", async () => {
    const r = await patchServer(serverA, ownerToken, { worldId: nanoid() });
    assert.equal(r.status, 403);
  });

  test("owner links their own world; null clears it", async () => {
    const set = await patchServer(serverA, ownerToken, { worldId: privateWorld });
    assert.equal(set.status, 200);
    assert.equal(await serverWorldId(serverA), privateWorld);

    const clear = await patchServer(serverA, ownerToken, { worldId: null });
    assert.equal(clear.status, 200);
    assert.equal(await serverWorldId(serverA), null);
  });

  test("a collaborated world counts as the owner's to feature", async () => {
    const r = await patchServer(serverA, ownerToken, { worldId: collabPublicWorld });
    assert.equal(r.status, 200);
    assert.equal(await serverWorldId(serverA), collabPublicWorld);
    // Reset for the visibility block below.
    await patchServer(serverA, ownerToken, { worldId: null });
  });

  test("a PRIVATE collaborated world is refused: it could never read back for its setter", async () => {
    // resolveWorld admits a private world only to its owner/admin, so a
    // collaborator pick would save but show "None" on every read.
    const r = await patchServer(serverA, ownerToken, { worldId: collabWorld });
    assert.equal(r.status, 403);
    assert.equal(await serverWorldId(serverA), null);
  });
});

describe("world visibility on the wire (never leak a private name)", () => {
  before(async () => {
    await db.update(schema.servers).set({ worldId: privateWorld }).where(eq(schema.servers.id, serverA));
  });

  test("GET /servers: private world reads null for members/anon, resolves for its owner", async () => {
    const asMember = (await app.inject({ method: "GET", url: "/servers", headers: auth(memberToken) })).json() as { servers: CatalogRow[] };
    assert.equal(asMember.servers.find((s) => s.id === serverA)!.world, null);

    const asAnon = (await app.inject({ method: "GET", url: "/servers" })).json() as { servers: CatalogRow[] };
    assert.equal(asAnon.servers.find((s) => s.id === serverA)!.world, null);

    const asOwner = (await app.inject({ method: "GET", url: "/servers", headers: auth(ownerToken) })).json() as { servers: CatalogRow[] };
    const w = asOwner.servers.find((s) => s.id === serverA)!.world;
    assert.equal(w?.id, privateWorld);
    assert.equal(w?.name, "Umbra");
  });

  test("GET /servers/:id mirrors the same gate", async () => {
    const asMember = (await app.inject({ method: "GET", url: `/servers/${serverA}`, headers: auth(memberToken) })).json() as { server: { world: WorldRef | null } };
    assert.equal(asMember.server.world, null);

    const asOwner = (await app.inject({ method: "GET", url: `/servers/${serverA}`, headers: auth(ownerToken) })).json() as { server: { world: WorldRef | null } };
    assert.equal(asOwner.server.world?.id, privateWorld);
  });

  test("GET /servers/public/:slug: anonymous never sees a private world; a public one appears", async () => {
    const priv = (await app.inject({ method: "GET", url: `/servers/public/${serverASlug}` })).json() as { world: WorldRef | null };
    assert.equal(priv.world, null);

    await db.update(schema.servers).set({ worldId: openWorld }).where(eq(schema.servers.id, serverA));
    const open = (await app.inject({ method: "GET", url: `/servers/public/${serverASlug}` })).json() as { world: WorldRef | null };
    assert.equal(open.world?.id, openWorld);
    assert.equal(open.world?.slug, "aster");
  });

  test("an 18+ world reads null for minors, resolves for adults", async () => {
    await db.update(schema.servers).set({ worldId: nsfwWorld }).where(eq(schema.servers.id, serverA));

    const asMinor = (await app.inject({ method: "GET", url: `/servers/${serverA}`, headers: auth(minorToken) })).json() as { server: { world: WorldRef | null } };
    assert.equal(asMinor.server.world, null);

    const asAdult = (await app.inject({ method: "GET", url: `/servers/${serverA}`, headers: auth(memberToken) })).json() as { server: { world: WorldRef | null } };
    assert.equal(asAdult.server.world?.id, nsfwWorld);
  });
});

describe("chat banner fallback (buildRoomSummary.linkedWorld)", () => {
  let unlinkedRoom: string;
  let linkedRoom: string;
  let otherServerRoom: string;

  before(async () => {
    await db.update(schema.servers).set({ worldId: openWorld }).where(eq(schema.servers.id, serverA));
    unlinkedRoom = await insertRoom({ name: "Fallback_Hall", serverId: serverA });
    linkedRoom = await insertRoom({ name: "Linked_Hall", serverId: serverA });
    otherServerRoom = await insertRoom({ name: "Plain_Hall", serverId: serverB });
    await db.insert(schema.roomWorldLinks).values({
      roomId: linkedRoom, worldId: privateWorld, linkedByUserId: owner.id,
    });
  });

  async function summaryFor(roomId: string) {
    const room = (await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId)))[0]!;
    return buildRoomSummary(db, room);
  }

  test("a room with no link inherits the server world", async () => {
    const s = await summaryFor(unlinkedRoom);
    assert.equal(s.linkedWorld?.id, openWorld);
    assert.equal(s.linkedWorld?.name, "Aster");
    assert.equal(s.linkedWorld?.ownerUsername, owner.username);
  });

  test("an explicit room link always wins over the server world", async () => {
    const s = await summaryFor(linkedRoom);
    assert.equal(s.linkedWorld?.id, privateWorld);
  });

  test("a room in a server without a world stays bare", async () => {
    const s = await summaryFor(otherServerRoom);
    assert.equal(s.linkedWorld, null);
  });

  test("a private server world never inherits (room-wide broadcast, no per-viewer gate)", async () => {
    await db.update(schema.servers).set({ worldId: privateWorld }).where(eq(schema.servers.id, serverA));
    try {
      const s = await summaryFor(unlinkedRoom);
      assert.equal(s.linkedWorld, null);
    } finally {
      await db.update(schema.servers).set({ worldId: openWorld }).where(eq(schema.servers.id, serverA));
    }
  });

  test("an 18+ server world inherits only into rooms whose effective rating is 18+", async () => {
    await db.update(schema.servers).set({ worldId: nsfwWorld }).where(eq(schema.servers.id, serverA));
    try {
      const sfw = await summaryFor(unlinkedRoom);
      assert.equal(sfw.linkedWorld, null);
      const adultRoom = await insertRoom({ name: "Adult_Hall", serverId: serverA, isNsfw: true });
      const nsfw = await summaryFor(adultRoom);
      assert.equal(nsfw.linkedWorld?.id, nsfwWorld);
    } finally {
      await db.update(schema.servers).set({ worldId: openWorld }).where(eq(schema.servers.id, serverA));
    }
  });

  test("flag off: the fallback is skipped entirely (byte-identical summaries)", async () => {
    await updateSettings(db, { serversEnabled: false }, owner.id);
    try {
      const s = await summaryFor(unlinkedRoom);
      assert.equal(s.linkedWorld, null);
      // The explicit link is NOT flag-gated (it predates servers).
      const linked = await summaryFor(linkedRoom);
      assert.equal(linked.linkedWorld?.id, privateWorld);
    } finally {
      await updateSettings(db, { serversEnabled: true }, owner.id);
    }
  });
});

describe("GET /me/worlds ?collab=1 (the picker's option set)", () => {
  test("bare route stays owned-only; collab=1 unions in collaborations", async () => {
    const bare = (await app.inject({ method: "GET", url: "/me/worlds", headers: auth(ownerToken) })).json() as { worlds: Array<{ id: string }> };
    const bareIds = new Set(bare.worlds.map((w) => w.id));
    assert.ok(bareIds.has(privateWorld));
    assert.ok(!bareIds.has(collabWorld));

    const wide = (await app.inject({ method: "GET", url: "/me/worlds?collab=1", headers: auth(ownerToken) })).json() as { worlds: Array<{ id: string }> };
    const wideIds = new Set(wide.worlds.map((w) => w.id));
    assert.ok(wideIds.has(privateWorld));
    assert.ok(wideIds.has(collabPublicWorld));
    // A PRIVATE collaboration is excluded: the console PATCH refuses it (it
    // could never read back through resolveWorld for its setter), so the
    // picker must not offer it.
    assert.ok(!wideIds.has(collabWorld));
    assert.ok(!wideIds.has(strangersWorld));
  });
});
