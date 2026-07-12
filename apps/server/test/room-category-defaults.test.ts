import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { Role } from "@thekeep/shared";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { SessionUser } from "../src/commands/types.js";
import { dispatchChatInput } from "../src/realtime/dispatch.js";
import { CommandRegistry } from "../src/commands/registry.js";
import { registerBuiltins } from "../src/commands/builtins/index.js";
import { registerRoomsRoutes } from "../src/routes/rooms.js";
import { registerServerConsoleRoutes } from "../src/routes/serversConsole.js";
import { serverAuthority, serverCan } from "../src/servers/authority.js";
import { getSessionUser } from "../src/routes/auth.js";
import { defaultRoomCategoryFor } from "../src/lib/roomCategoryDefaults.js";
import type { ServerRoutesCtx } from "../src/routes/serversShared.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Default categories for new rooms (migration 0351). Pinned here: the
 * creation precedence matrix (explicit choice > role mapping [highest
 * sortOrder wins] > server default > uncategorized) on BOTH creation paths
 * (console POST /servers/:id/rooms and the member-facing /go and /private
 * commands), single-winner enforcement on the per-server default, cascade
 * cleanup on category delete and usergroup delete, and the manage_rooms
 * gates on the new console routes.
 */

const ADULT_DOB = "1990-01-01";

/* ── stubs (mirror room-categories.test.ts / room-role-gates.test.ts) ── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeIo(): any {
  return {
    async fetchSockets() { return []; },
    in() { return { async fetchSockets() { return []; }, emit() {} }; },
    to() { return { emit() {} }; },
    emit() {},
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeSocket(roomId?: string): any {
  const roomSet = new Set<string>(roomId ? [`room:${roomId}`] : []);
  return {
    id: nanoid(),
    rooms: roomSet,
    data: {},
    emit() {},
    join(band: string) { roomSet.add(band); },
    leave(band: string) { roomSet.delete(band); },
    to() { return { emit() {} }; },
    disconnect() {},
  };
}

function sessionUser(u: { id: string; username: string }): SessionUser {
  return {
    id: u.id,
    username: u.username,
    role: "user" as Role,
    activeCharacterId: null,
    birthdate: ADULT_DOB,
    isAdult: true,
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
let registry: CommandRegistry;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let io: any;
type U = { id: string; username: string };
let owner: U;        // owns both servers, holds no mapped role
let roleHolder: U;   // member of groupLow + groupHigh, server mod w/ manage_rooms
let plainMember: U;  // member with no usergroups
let ownerToken: string;
let memberToken: string;
let holderToken: string;
let serverA: string;
let serverB: string;
let catGeneral: string;  // server default
let catEvents: string;   // mapped to groupLow
let catStaff: string;    // mapped to groupHigh (higher sortOrder → wins)
let catForeign: string;  // lives in serverB
let groupLow: string;
let groupHigh: string;
let groupForeign: string;   // lives in serverB
let defaultGroupA: string;  // serverA's implicit-everyone default group
let seedRoomA: string;      // dispatch anchor: the creator "stands" here
let seedRoomB: string;

async function mkServer(ownerId: string, name: string): Promise<string> {
  const id = nanoid();
  await db.insert(schema.servers).values({
    id, slug: `srv-${id.slice(0, 6)}`.toLowerCase(), name, ownerUserId: ownerId,
  });
  return id;
}

async function mkCategory(serverId: string, name: string, sortOrder: number): Promise<string> {
  const id = nanoid();
  await db.insert(schema.roomCategories).values({ id, serverId, name, sortOrder });
  return id;
}

async function mkGroup(serverId: string, name: string, sortOrder: number, isDefault = false): Promise<string> {
  const id = nanoid();
  await db.insert(schema.serverUsergroups).values({
    id, serverId, name, sortOrder, isDefault, permissionsJson: "[]", autoRulesJson: "[]",
  });
  return id;
}

let seedN = 0;
async function mkSeedRoom(serverId: string): Promise<string> {
  const id = nanoid();
  const name = `Seed_Anchor_${++seedN}`;
  await db.insert(schema.rooms).values({
    id, name, slug: name.toLowerCase().replace(/_/g, "-"), type: "public", serverId,
  });
  return id;
}

async function roomByName(name: string) {
  return (await db.select().from(schema.rooms)
    .where(eq(schema.rooms.name, name)).limit(1))[0];
}

/** Drive the member-facing creation path: the creator stands in `fromRoom`
 *  and types the command, exactly like the CreateRoomModal / composer. */
async function dispatchAs(u: U, fromRoom: string, text: string): Promise<void> {
  await dispatchChatInput({
    io, socket: makeFakeSocket(fromRoom), db, registry, user: sessionUser(u), roomId: fromRoom, text,
  });
}

async function consoleCreate(token: string, serverId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST", url: `/servers/${serverId}/rooms`, headers: auth(token), payload,
  });
}

interface DefaultsPayload {
  categories: Array<{ id: string; name: string; icon: string | null; sortOrder: number; isDefault: boolean }>;
  roleDefaults: Array<{ usergroupId: string; categoryId: string }>;
  groups: Array<{ id: string; name: string; color: string | null }>;
}

async function fetchDefaults(serverId: string, token: string): Promise<DefaultsPayload> {
  const res = await app.inject({ method: "GET", url: `/servers/${serverId}/room-categories`, headers: auth(token) });
  assert.equal(res.statusCode, 200);
  return res.json() as DefaultsPayload;
}

before(async () => {
  db = makeTestDb().db;
  io = makeFakeIo();
  registry = new CommandRegistry();
  registerBuiltins(registry);

  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) { reply.code(400); return reply.send({ error: "validation" }); }
    throw err;
  });
  await registerRoomsRoutes(app, db, io);
  registerServerConsoleRoutes(buildConsoleCtx(app, db, io));
  await app.ready();

  owner = await createUser(db, { birthdate: ADULT_DOB });
  roleHolder = await createUser(db, { birthdate: ADULT_DOB });
  plainMember = await createUser(db, { birthdate: ADULT_DOB });
  ownerToken = await tokenFor(db, owner.id);
  memberToken = await tokenFor(db, plainMember.id);
  holderToken = await tokenFor(db, roleHolder.id);

  serverA = await mkServer(owner.id, "Defaults A");
  serverB = await mkServer(owner.id, "Defaults B");
  await db.insert(schema.serverMembers).values([
    // roleHolder gets manage_rooms so the console path can be driven as the
    // role-mapped creator too.
    { serverId: serverA, userId: roleHolder.id, role: "mod", permissionsJson: JSON.stringify(["manage_rooms"]) },
    { serverId: serverA, userId: plainMember.id, role: "member" },
    { serverId: serverB, userId: roleHolder.id, role: "member" },
  ]);

  catGeneral = await mkCategory(serverA, "General", 0);
  catEvents = await mkCategory(serverA, "Events", 1);
  catStaff = await mkCategory(serverA, "Staff Desk", 2);
  catForeign = await mkCategory(serverB, "Foreign", 0);

  groupLow = await mkGroup(serverA, "Regulars", 1);
  groupHigh = await mkGroup(serverA, "Event Hosts", 5);
  groupForeign = await mkGroup(serverB, "Foreigners", 0);
  defaultGroupA = await mkGroup(serverA, "Members", 0, true);
  await db.insert(schema.serverUsergroupMembers).values([
    { groupId: groupLow, userId: roleHolder.id, isAuto: false },
    { groupId: groupHigh, userId: roleHolder.id, isAuto: false },
  ]);

  seedRoomA = await mkSeedRoom(serverA);
  seedRoomB = await mkSeedRoom(serverB);

  // Owner wiring through the real console routes: catGeneral is the server
  // default; groupLow files under Events, groupHigh under Staff Desk.
  const def = await app.inject({
    method: "PATCH", url: `/servers/${serverA}/room-categories/${catGeneral}`,
    headers: auth(ownerToken), payload: { isDefault: true },
  });
  assert.equal(def.statusCode, 200);
  for (const [cat, gid] of [[catEvents, groupLow], [catStaff, groupHigh]] as const) {
    const res = await app.inject({
      method: "PUT", url: `/servers/${serverA}/room-categories/${cat}/role-defaults`,
      headers: auth(ownerToken), payload: { usergroupIds: [gid] },
    });
    assert.equal(res.statusCode, 200);
  }
});

describe("GET /servers/:id/room-categories (console feed)", () => {
  test("returns flags, mappings, and only NAMED groups; gated on manage_rooms", async () => {
    const j = await fetchDefaults(serverA, ownerToken);
    assert.deepEqual(
      j.categories.map((c) => ({ name: c.name, isDefault: c.isDefault })),
      [
        { name: "General", isDefault: true },
        { name: "Events", isDefault: false },
        { name: "Staff Desk", isDefault: false },
      ],
    );
    assert.deepEqual(
      [...j.roleDefaults].sort((a, b) => a.usergroupId.localeCompare(b.usergroupId)),
      [
        { usergroupId: groupLow, categoryId: catEvents },
        { usergroupId: groupHigh, categoryId: catStaff },
      ].sort((a, b) => a.usergroupId.localeCompare(b.usergroupId)),
    );
    // The implicit-everyone default group never appears in the picker.
    assert.deepEqual(j.groups.map((g) => g.id).sort(), [groupLow, groupHigh].sort());

    const anon = await app.inject({ method: "GET", url: `/servers/${serverA}/room-categories` });
    assert.equal(anon.statusCode, 401);
    const asMember = await app.inject({
      method: "GET", url: `/servers/${serverA}/room-categories`, headers: auth(memberToken),
    });
    assert.equal(asMember.statusCode, 403);
  });
});

describe("creation precedence: console path", () => {
  test("explicit categoryId beats every default (including explicit null)", async () => {
    const res = await consoleCreate(holderToken, serverA, { name: "Con_Explicit", categoryId: catEvents });
    assert.equal(res.statusCode, 200);
    assert.equal((await roomByName("Con_Explicit"))!.categoryId, catEvents);

    // Explicit null = "no category", even though a server default exists and
    // the creator holds mapped roles.
    const nul = await consoleCreate(holderToken, serverA, { name: "Con_ExplicitNone", categoryId: null });
    assert.equal(nul.statusCode, 200);
    assert.equal((await roomByName("Con_ExplicitNone"))!.categoryId, null);
  });

  test("role mapping beats the server default; highest-sortOrder role wins", async () => {
    const res = await consoleCreate(holderToken, serverA, { name: "Con_RoleMapped" });
    assert.equal(res.statusCode, 200);
    // groupHigh (sortOrder 5) outranks groupLow (1) — the badge pick rule.
    assert.equal((await roomByName("Con_RoleMapped"))!.categoryId, catStaff);
  });

  test("server default applies when the creator holds no mapped role", async () => {
    const res = await consoleCreate(ownerToken, serverA, { name: "Con_ServerDefault" });
    assert.equal(res.statusCode, 200);
    assert.equal((await roomByName("Con_ServerDefault"))!.categoryId, catGeneral);
  });

  test("no defaults configured → uncategorized", async () => {
    const res = await consoleCreate(ownerToken, serverB, { name: "Con_NoDefaults" });
    assert.equal(res.statusCode, 200);
    assert.equal((await roomByName("Con_NoDefaults"))!.categoryId, null);
  });
});

describe("creation precedence: member path (/go, /private)", () => {
  test("role-mapped creator: /go lands in the highest-sortOrder role's category", async () => {
    await dispatchAs(roleHolder, seedRoomA, "/go Go_RoleMapped");
    const row = await roomByName("Go_RoleMapped");
    assert.ok(row, "the /go create path made the room");
    assert.equal(row!.serverId, serverA);
    assert.equal(row!.categoryId, catStaff);
  });

  test("plain member: /go lands in the server default; /private too", async () => {
    await dispatchAs(plainMember, seedRoomA, "/go Go_ServerDefault");
    assert.equal((await roomByName("Go_ServerDefault"))!.categoryId, catGeneral);

    await dispatchAs(plainMember, seedRoomA, "/private Pvt_ServerDefault hunter2");
    const pvt = await roomByName("Pvt_ServerDefault");
    assert.ok(pvt, "the /private create path made the room");
    assert.equal(pvt!.type, "private");
    assert.equal(pvt!.categoryId, catGeneral);
  });

  test("server without defaults: /go stays uncategorized (pre-feature shape)", async () => {
    await dispatchAs(roleHolder, seedRoomB, "/go Go_NoDefaults");
    const row = await roomByName("Go_NoDefaults");
    assert.ok(row);
    assert.equal(row!.serverId, serverB);
    assert.equal(row!.categoryId, null);
  });
});

describe("single-winner server default", () => {
  test("promoting a category demotes the previous holder in the same request", async () => {
    const res = await app.inject({
      method: "PATCH", url: `/servers/${serverA}/room-categories/${catEvents}`,
      headers: auth(ownerToken), payload: { isDefault: true },
    });
    assert.equal(res.statusCode, 200);
    const j = await fetchDefaults(serverA, ownerToken);
    assert.deepEqual(
      j.categories.filter((c) => c.isDefault).map((c) => c.id),
      [catEvents],
      "exactly one default survives the flip",
    );

    // Turning the flag off leaves the server with NO default (not a revert).
    const off = await app.inject({
      method: "PATCH", url: `/servers/${serverA}/room-categories/${catEvents}`,
      headers: auth(ownerToken), payload: { isDefault: false },
    });
    assert.equal(off.statusCode, 200);
    assert.equal((await fetchDefaults(serverA, ownerToken)).categories.some((c) => c.isDefault), false);

    // Restore the fixture default for any later reader.
    await app.inject({
      method: "PATCH", url: `/servers/${serverA}/room-categories/${catGeneral}`,
      headers: auth(ownerToken), payload: { isDefault: true },
    });
  });
});

describe("role-defaults route validation", () => {
  test("replace-set semantics + a role moves between categories", async () => {
    // groupLow currently maps to Events; claiming it for Staff Desk MOVES it.
    const res = await app.inject({
      method: "PUT", url: `/servers/${serverA}/room-categories/${catStaff}/role-defaults`,
      headers: auth(ownerToken), payload: { usergroupIds: [groupHigh, groupLow] },
    });
    assert.equal(res.statusCode, 200);
    const j = await fetchDefaults(serverA, ownerToken);
    assert.deepEqual(
      j.roleDefaults.map((m) => m.categoryId),
      [catStaff, catStaff],
      "both roles now point at Staff Desk (one row per role — no duplicates)",
    );
    // Restore the fixture mapping.
    await app.inject({
      method: "PUT", url: `/servers/${serverA}/room-categories/${catStaff}/role-defaults`,
      headers: auth(ownerToken), payload: { usergroupIds: [groupHigh] },
    });
    await app.inject({
      method: "PUT", url: `/servers/${serverA}/room-categories/${catEvents}/role-defaults`,
      headers: auth(ownerToken), payload: { usergroupIds: [groupLow] },
    });
  });

  test("foreign category, foreign group, and the default group all read as not-found", async () => {
    const foreignCat = await app.inject({
      method: "PUT", url: `/servers/${serverA}/room-categories/${catForeign}/role-defaults`,
      headers: auth(ownerToken), payload: { usergroupIds: [groupLow] },
    });
    assert.equal(foreignCat.statusCode, 404);
    const foreignGroup = await app.inject({
      method: "PUT", url: `/servers/${serverA}/room-categories/${catEvents}/role-defaults`,
      headers: auth(ownerToken), payload: { usergroupIds: [groupForeign] },
    });
    assert.equal(foreignGroup.statusCode, 404);
    const defaultGroup = await app.inject({
      method: "PUT", url: `/servers/${serverA}/room-categories/${catEvents}/role-defaults`,
      headers: auth(ownerToken), payload: { usergroupIds: [defaultGroupA] },
    });
    assert.equal(defaultGroup.statusCode, 404);
    // None of the rejects touched the stored mapping.
    assert.equal((await fetchDefaults(serverA, ownerToken)).roleDefaults.length, 2);
  });

  test("gates: 401 anonymous, 403 plain member; strict body 400s extras", async () => {
    const anon = await app.inject({
      method: "PUT", url: `/servers/${serverA}/room-categories/${catEvents}/role-defaults`,
      payload: { usergroupIds: [] },
    });
    assert.equal(anon.statusCode, 401);
    const asMember = await app.inject({
      method: "PUT", url: `/servers/${serverA}/room-categories/${catEvents}/role-defaults`,
      headers: auth(memberToken), payload: { usergroupIds: [] },
    });
    assert.equal(asMember.statusCode, 403);
    const extras = await app.inject({
      method: "PUT", url: `/servers/${serverA}/room-categories/${catEvents}/role-defaults`,
      headers: auth(ownerToken), payload: { usergroupIds: [], nonsense: true },
    });
    assert.equal(extras.statusCode, 400);
  });
});

describe("cascades", () => {
  test("deleting a usergroup deletes its mapping; the resolver falls through", async () => {
    // With groupHigh gone, roleHolder's only mapped role is groupLow → Events.
    await db.delete(schema.serverUsergroups).where(eq(schema.serverUsergroups.id, groupHigh));
    const mappings = await db.select().from(schema.roomCategoryRoleDefaults);
    assert.equal(mappings.some((m) => m.usergroupId === groupHigh), false, "cascade removed the mapping");
    assert.equal(await defaultRoomCategoryFor(db, serverA, roleHolder.id), catEvents);
  });

  test("deleting a category deletes its mappings and its default flag with it", async () => {
    // Delete Events through the console route; groupLow's mapping cascades.
    const res = await app.inject({
      method: "DELETE", url: `/servers/${serverA}/room-categories/${catEvents}`,
      headers: auth(ownerToken),
    });
    assert.equal(res.statusCode, 200);
    assert.equal((await db.select().from(schema.roomCategoryRoleDefaults)).length, 0);
    // roleHolder now has NO mapped role → the server default (General) wins.
    assert.equal(await defaultRoomCategoryFor(db, serverA, roleHolder.id), catGeneral);

    // And deleting the default category leaves the server with no default:
    // brand-new rooms land uncategorized again.
    const delDefault = await app.inject({
      method: "DELETE", url: `/servers/${serverA}/room-categories/${catGeneral}`,
      headers: auth(ownerToken),
    });
    assert.equal(delDefault.statusCode, 200);
    assert.equal(await defaultRoomCategoryFor(db, serverA, roleHolder.id), null);
    await dispatchAs(plainMember, seedRoomA, "/go Go_AfterTeardown");
    assert.equal((await roomByName("Go_AfterTeardown"))!.categoryId, null);
  });
});
