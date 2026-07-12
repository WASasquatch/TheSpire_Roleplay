import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import type { Role } from "@thekeep/shared";
import { buildRoleSelectBody, parseRoleSelectBody } from "@thekeep/shared";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { SessionUser } from "../src/commands/types.js";
import { dispatchChatInput } from "../src/realtime/dispatch.js";
import { CommandRegistry } from "../src/commands/registry.js";
import { registerBuiltins } from "../src/commands/builtins/index.js";
import { registerRoomsRoutes } from "../src/routes/rooms.js";
import { registerSelfRolesRoutes } from "../src/servers/selfRoles.js";
import { roleAccessDeniedFor } from "../src/lib/roleGates.js";
import { canPostInRestrictedRoom, isPostLockedFor } from "../src/lib/postMode.js";
import { enableAdultChannel } from "../src/lib/adultChannel.js";
import { loadRoleSelectState } from "../src/roleSelect.js";
import { serverRolesFor } from "../src/servers/usergroups.js";
import { lookupProfile } from "../src/commands/builtins/profile.js";
import { findServerLanding, joinRoom } from "../src/realtime/broadcast/presence.js";
import { updateSettings } from "../src/settings.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Per-role room permissions (room_role_gates, migration 0349) + the
 * /roleselect picker + profile role badges. Pinned here: the access gate
 * (rail absence, join refusal, by-slug 404, landing skip, staff/owner
 * bypass, group-delete un-gating), the post-gate matrix
 * (everyone/staff/roles × member/holder/staff/minor), /roleselect
 * validation + panel hydration + the self-role toggle it rides, the 18+
 * channel access-row copy, and the server-contextual profile role lookup.
 */

const ADULT_DOB = "1990-01-01";
const MINOR_DOB = "2012-01-01";

/* ── stubs (mirror post-mode.test.ts) ── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeIo(): any {
  return {
    async fetchSockets() { return []; },
    in() { return { async fetchSockets() { return []; }, emit() {} }; },
    to() { return { emit() {} }; },
    emit() {},
  };
}

interface Notice { code: string; message: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeSocket(roomId?: string): { socket: any; notices: Notice[] } {
  const notices: Notice[] = [];
  const rooms = new Set<string>(roomId ? [`room:${roomId}`] : []);
  const socket = {
    id: nanoid(),
    rooms,
    data: {},
    emit(event: string, payload: unknown) {
      if (event === "error:notice") notices.push(payload as Notice);
    },
    join(band: string) { rooms.add(band); },
    leave(band: string) { rooms.delete(band); },
    disconnect() {},
  };
  return { socket, notices };
}

function sessionUser(u: { id: string; username: string; role: Role }, opts: { minor?: boolean } = {}): SessionUser {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    activeCharacterId: null,
    birthdate: opts.minor ? MINOR_DOB : ADULT_DOB,
    isAdult: !opts.minor,
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

let db: Db;
let app: FastifyInstance;
let registry: CommandRegistry;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let io: any;
type U = { id: string; username: string; role: Role };
let owner: U;          // owns the server AND the gated room
let holder: U;         // ordinary member holding groupA
let outsider: U;       // ordinary member with no roles
let serverAdmin: U;    // server_members role=admin (staff + manage_usergroups)
let siteMod: U;        // site staff
let minor: U;          // under-18 ordinary member
let serverId: string;
let groupA: string;    // member-selectable
let groupB: string;    // NOT member-selectable
let otherServerId: string;
let groupOther: string; // member-selectable, other server
let nightOwls: string;  // member-selectable, name with a real space
let gatedRoomId: string;
let publicRoomId: string;
let rolesPostRoomId: string;
let staffPostRoomId: string;

async function mkServer(ownerId: string, name: string): Promise<string> {
  const id = nanoid();
  await db.insert(schema.servers).values({
    id, slug: `srv-${id.slice(0, 6)}`.toLowerCase(), name,
    ownerUserId: ownerId, isSystem: false, isDefault: false,
    status: "active", visibility: "public", joinMode: "open",
  });
  return id;
}

async function mkGroup(sid: string, name: string, selectable: boolean, isDefault = false): Promise<string> {
  const id = nanoid();
  await db.insert(schema.serverUsergroups).values({
    id, serverId: sid, name, isDefault, memberSelectable: selectable,
    color: "#8b5cf6", permissionsJson: "[]", autoRulesJson: "[]",
  });
  return id;
}

let roomN = 0;
async function mkRoom(opts: {
  name?: string; ownerId?: string | null; serverId?: string | null;
  postMode?: "everyone" | "staff" | "roles"; isDefault?: boolean;
  accessGroups?: string[]; postGroups?: string[];
}): Promise<string> {
  const id = nanoid();
  const name = opts.name ?? `role-room-${++roomN}`;
  await db.insert(schema.rooms).values({
    id, name, slug: name.toLowerCase().replace(/_/g, "-"), type: "public",
    ownerId: opts.ownerId ?? null,
    postMode: opts.postMode ?? "everyone",
    ...(opts.isDefault ? { isDefault: true } : {}),
    ...(opts.serverId !== undefined ? { serverId: opts.serverId } : {}),
  });
  for (const g of opts.accessGroups ?? []) {
    await db.insert(schema.roomRoleGates).values({ roomId: id, usergroupId: g, kind: "access" });
  }
  for (const g of opts.postGroups ?? []) {
    await db.insert(schema.roomRoleGates).values({ roomId: id, usergroupId: g, kind: "post" });
  }
  return id;
}

async function roomRow(id: string) {
  return (await db.select().from(schema.rooms).where(eq(schema.rooms.id, id)).limit(1))[0]!;
}

async function dispatch(user: U, roomId: string, text: string, opts: { minor?: boolean } = {}): Promise<Notice[]> {
  const { socket, notices } = makeFakeSocket(roomId);
  await dispatchChatInput({ io, socket, db, registry, user: sessionUser(user, opts), roomId, text });
  return notices;
}

async function fetchRooms(token?: string): Promise<Array<{ id: string; name: string; postMode?: string; postLocked?: boolean; linkedNsfwRoomId?: string | null }>> {
  const res = await app.inject({ method: "GET", url: "/rooms", ...(token ? { headers: auth(token) } : {}) });
  assert.equal(res.statusCode, 200);
  return (res.json() as { rooms: Array<{ id: string; name: string; postMode?: string; postLocked?: boolean; linkedNsfwRoomId?: string | null }> }).rooms;
}

before(async () => {
  db = makeTestDb().db;
  io = makeFakeIo();
  registry = new CommandRegistry();
  registerBuiltins(registry);

  owner = { ...(await createUser(db, { birthdate: ADULT_DOB })), role: "user" };
  holder = { ...(await createUser(db, { birthdate: ADULT_DOB })), role: "user" };
  outsider = { ...(await createUser(db, { birthdate: ADULT_DOB })), role: "user" };
  serverAdmin = { ...(await createUser(db, { birthdate: ADULT_DOB })), role: "user" };
  siteMod = { ...(await createUser(db, { role: "mod", birthdate: ADULT_DOB })), role: "mod" };
  minor = { ...(await createUser(db, { birthdate: MINOR_DOB })), role: "user" };

  // The self-role toggle routes gate on the serversEnabled flag.
  await updateSettings(db, { serversEnabled: true }, owner.id);

  app = Fastify();
  await registerRoomsRoutes(app, db, io);
  await registerSelfRolesRoutes(app, db, io);
  await app.ready();

  serverId = await mkServer(owner.id, "Role Server");
  otherServerId = await mkServer(owner.id, "Elsewhere");
  await db.insert(schema.serverMembers).values([
    { serverId, userId: holder.id, role: "member" },
    { serverId, userId: outsider.id, role: "member" },
    { serverId, userId: minor.id, role: "member" },
    { serverId, userId: serverAdmin.id, role: "admin" },
  ]);

  groupA = await mkGroup(serverId, "Artists", true);
  groupB = await mkGroup(serverId, "Lurkers", false);
  nightOwls = await mkGroup(serverId, "Night Owls", true);
  groupOther = await mkGroup(otherServerId, "Foreigners", true);
  await db.insert(schema.serverUsergroupMembers).values([
    { groupId: groupA, userId: holder.id, isAuto: false },
  ]);

  gatedRoomId = await mkRoom({ name: "Artists_Only", ownerId: owner.id, serverId, accessGroups: [groupA] });
  publicRoomId = await mkRoom({ name: "Commons", ownerId: owner.id, serverId });
  rolesPostRoomId = await mkRoom({ name: "Artists_Post", ownerId: owner.id, serverId, postMode: "roles", postGroups: [groupA] });
  staffPostRoomId = await mkRoom({ name: "Staff_Post", ownerId: owner.id, serverId, postMode: "staff", postGroups: [groupA] });
});

/* ── 7a: access gate ── */

describe("access gate: helper matrix", () => {
  test("no rows → public; rows → holder/owner/server-staff/site-staff pass, others don't", async () => {
    const publicRow = await roomRow(publicRoomId);
    const gatedRow = await roomRow(gatedRoomId);
    assert.equal(await roleAccessDeniedFor(db, { id: outsider.id, role: "user" }, publicRow), false);
    assert.equal(await roleAccessDeniedFor(db, { id: outsider.id, role: "user" }, gatedRow), true);
    assert.equal(await roleAccessDeniedFor(db, null, gatedRow), true, "anonymous is denied");
    assert.equal(await roleAccessDeniedFor(db, { id: holder.id, role: "user" }, gatedRow), false);
    assert.equal(await roleAccessDeniedFor(db, { id: owner.id, role: "user" }, gatedRow), false, "room owner bypass");
    assert.equal(await roleAccessDeniedFor(db, { id: serverAdmin.id, role: "user" }, gatedRow), false, "server staff bypass");
    assert.equal(await roleAccessDeniedFor(db, { id: siteMod.id, role: "mod" }, gatedRow), false, "site staff bypass");
  });
});

describe("access gate: GET /rooms rail absence", () => {
  test("gated rooms are simply ABSENT for non-holders (and anonymous); present for holders + staff + owner", async () => {
    const asOutsider = await fetchRooms(await tokenFor(db, outsider.id));
    assert.equal(asOutsider.some((r) => r.id === gatedRoomId), false, "outsider never receives the room");
    assert.equal(asOutsider.some((r) => r.id === publicRoomId), true);

    const anon = await fetchRooms();
    assert.equal(anon.some((r) => r.id === gatedRoomId), false, "anonymous never receives the room");

    for (const viewer of [holder, owner, serverAdmin, siteMod]) {
      const rows = await fetchRooms(await tokenFor(db, viewer.id));
      assert.equal(rows.some((r) => r.id === gatedRoomId), true, viewer.username);
    }
  });
});

describe("access gate: by-slug 404 (existence never leaks)", () => {
  test("non-holders get the private-room 404 shape; holders + staff resolve", async () => {
    const url = "/rooms/by-slug/artists-only";
    const asOutsider = await app.inject({ method: "GET", url, headers: auth(await tokenFor(db, outsider.id)) });
    assert.equal(asOutsider.statusCode, 404);
    assert.deepEqual(asOutsider.json(), { error: "not found" });

    const anon = await app.inject({ method: "GET", url });
    assert.equal(anon.statusCode, 404);

    for (const viewer of [holder, owner, serverAdmin, siteMod]) {
      const res = await app.inject({ method: "GET", url, headers: auth(await tokenFor(db, viewer.id)) });
      assert.equal(res.statusCode, 200, viewer.username);
      assert.equal((res.json() as { room: { id: string } }).room.id, gatedRoomId);
    }
  });
});

describe("access gate: join refusal", () => {
  test("a non-holder's join gets the NO_ROOM refusal; a holder joins", async () => {
    const denied = makeFakeSocket();
    await joinRoom(io, db, denied.socket, sessionUser(outsider), gatedRoomId);
    assert.equal(denied.notices[0]?.code, "NO_ROOM", "same shape as a nonexistent room");
    assert.equal(denied.socket.rooms.has(`room:${gatedRoomId}`), false);

    const allowed = makeFakeSocket();
    await joinRoom(io, db, allowed.socket, sessionUser(holder), gatedRoomId);
    assert.equal(allowed.notices.some((n) => n.code === "NO_ROOM"), false);
    assert.equal(allowed.socket.rooms.has(`room:${gatedRoomId}`), true);
  });
});

describe("access gate: findServerLanding skips role-locked rooms", () => {
  test("a locked default falls through to the first unlocked room; all-locked → null", async () => {
    const s = await mkServer(owner.id, "Landing Server");
    const g = await mkGroup(s, "Keyholders", true);
    const lockedDefault = await mkRoom({ name: "Locked_Door", ownerId: owner.id, serverId: s, isDefault: true, accessGroups: [g] });
    const open = await mkRoom({ name: "Open_Door", ownerId: owner.id, serverId: s });
    const landing = await findServerLanding(db, s);
    assert.equal(landing?.id, open, "locked default is skipped");

    await db.insert(schema.roomRoleGates).values({ roomId: open, usergroupId: g, kind: "access" });
    assert.equal(await findServerLanding(db, s), null, "no unlocked room → no landing");

    // Sanity: an unlocked default still wins outright.
    await db.delete(schema.roomRoleGates).where(eq(schema.roomRoleGates.roomId, lockedDefault));
    assert.equal((await findServerLanding(db, s))?.id, lockedDefault);
  });
});

describe("access gate: group delete un-gates the room", () => {
  test("deleting the LAST access group makes the room public again (FK cascade)", async () => {
    const g = await mkGroup(serverId, "Ephemeral", true);
    const roomId = await mkRoom({ name: "Fleeting", ownerId: owner.id, serverId, accessGroups: [g] });
    const row = await roomRow(roomId);
    assert.equal(await roleAccessDeniedFor(db, { id: outsider.id, role: "user" }, row), true);

    await db.delete(schema.serverUsergroups).where(eq(schema.serverUsergroups.id, g));
    assert.equal(await roleAccessDeniedFor(db, { id: outsider.id, role: "user" }, row), false, "cascade removed the gate rows");
    const rail = await fetchRooms(await tokenFor(db, outsider.id));
    assert.equal(rail.some((r) => r.id === roomId), true, "room reappears in the rail");
  });
});

describe("access gate: 18+ channel copies the base's access rows at enable, then independent", () => {
  test("enable copies kind='access' rows; later edits to the base don't touch the channel", async () => {
    const base = await roomRow(gatedRoomId);
    const ch = await enableAdultChannel(db, base);
    assert.ok(ch.ok && ch.channelRoomId);
    const channelGates = await db.select().from(schema.roomRoleGates)
      .where(and(eq(schema.roomRoleGates.roomId, ch.channelRoomId!), eq(schema.roomRoleGates.kind, "access")));
    assert.deepEqual(channelGates.map((r) => r.usergroupId), [groupA], "copied at enable time");

    // Independence: clearing the BASE's rows leaves the channel locked.
    await db.delete(schema.roomRoleGates)
      .where(and(eq(schema.roomRoleGates.roomId, gatedRoomId), eq(schema.roomRoleGates.kind, "access")));
    const still = await db.select().from(schema.roomRoleGates)
      .where(eq(schema.roomRoleGates.roomId, ch.channelRoomId!));
    assert.equal(still.length, 1, "channel keeps its own copy");
    // Restore the base's row for the tests below.
    await db.insert(schema.roomRoleGates).values({ roomId: gatedRoomId, usergroupId: groupA, kind: "access" });
  });
});

/* ── 7a: post gate matrix ── */

describe("post gate: 'roles' mode", () => {
  test("helper matrix: everyone/staff/roles × member/holder/staff/minor", async () => {
    const everyoneRow = await roomRow(publicRoomId);
    const rolesRow = await roomRow(rolesPostRoomId);
    const staffRow = await roomRow(staffPostRoomId);

    // everyone: nobody is locked.
    assert.equal(await isPostLockedFor(db, { id: outsider.id, role: "user" }, everyoneRow), false);
    // roles: holder + staff unlocked; plain member and minor locked.
    assert.equal(await isPostLockedFor(db, { id: holder.id, role: "user" }, rolesRow), false);
    assert.equal(await isPostLockedFor(db, { id: serverAdmin.id, role: "user" }, rolesRow), false);
    assert.equal(await isPostLockedFor(db, { id: siteMod.id, role: "mod" }, rolesRow), false);
    assert.equal(await isPostLockedFor(db, { id: outsider.id, role: "user" }, rolesRow), true);
    assert.equal(await isPostLockedFor(db, { id: minor.id, role: "user" }, rolesRow), true);
    // staff mode IGNORES role rows: the holder is still locked (staff wins).
    assert.equal(await isPostLockedFor(db, { id: holder.id, role: "user" }, staffRow), true);
    assert.equal(await canPostInRestrictedRoom(db, { id: holder.id, role: "user" }, staffRow), false);
    assert.equal(await isPostLockedFor(db, { id: serverAdmin.id, role: "user" }, staffRow), false);
  });

  test("dispatch: non-holders get the roles read-only refusal; holders + staff post", async () => {
    const denied = await dispatch(outsider, rolesPostRoomId, "hello");
    assert.equal(denied[0]?.code, "ROOM_READ_ONLY");
    const deniedMinor = await dispatch(minor, rolesPostRoomId, "hello", { minor: true });
    assert.equal(deniedMinor[0]?.code, "ROOM_READ_ONLY");
    for (const poster of [holder, serverAdmin, siteMod, owner]) {
      const notices = await dispatch(poster, rolesPostRoomId, `post from ${poster.username}`);
      assert.deepEqual(notices.map((n) => n.code), [], poster.username);
    }
    const count = (await db.select({ id: schema.messages.id }).from(schema.messages)
      .where(eq(schema.messages.roomId, rolesPostRoomId))).length;
    assert.equal(count, 4);
  });

  test("GET /rooms: postLocked rides the roles mode per-viewer", async () => {
    const asOutsider = await fetchRooms(await tokenFor(db, outsider.id));
    const locked = asOutsider.find((r) => r.id === rolesPostRoomId)!;
    assert.equal(locked.postMode, "roles");
    assert.equal(locked.postLocked, true);
    const asHolder = await fetchRooms(await tokenFor(db, holder.id));
    assert.equal(asHolder.find((r) => r.id === rolesPostRoomId)!.postLocked, undefined);
    const asMinor = await fetchRooms(await tokenFor(db, minor.id));
    assert.equal(asMinor.find((r) => r.id === rolesPostRoomId)!.postLocked, true);
  });
});

/* ── 7b: /roleselect ── */

describe("/roleselect", () => {
  test("permission: plain members are refused; server admin passes", async () => {
    const denied = await dispatch(outsider, publicRoomId, "/roleselect Artists");
    assert.equal(denied[0]?.code, "PERM");
  });

  test("validation: unknown group and non-selectable group refuse NAMING the offender", async () => {
    const unknown = await dispatch(serverAdmin, publicRoomId, "/roleselect Nonesuch");
    assert.equal(unknown[0]?.code, "ROLESELECT_UNKNOWN");
    assert.ok(unknown[0]!.message.includes("Nonesuch"));
    const notSelectable = await dispatch(serverAdmin, publicRoomId, "/roleselect Artists Lurkers");
    assert.equal(notSelectable[0]?.code, "ROLESELECT_NOT_SELECTABLE");
    assert.ok(notSelectable[0]!.message.includes("Lurkers"));
    // Nothing persisted on any refusal.
    const rows = await db.select({ id: schema.messages.id }).from(schema.messages)
      .where(eq(schema.messages.roomId, publicRoomId));
    assert.equal(rows.length, 0);
  });

  test("success: emoji pairing, underscore/NBSP name folding, persisted token body", async () => {
    const notices = await dispatch(serverAdmin, publicRoomId, "/roleselect 🎨 Artists Night_Owls");
    assert.deepEqual(notices.map((n) => n.code), []);
    const msg = (await db.select().from(schema.messages)
      .where(eq(schema.messages.roomId, publicRoomId)))[0]!;
    assert.equal(msg.kind, "say");
    assert.equal(msg.body, `🎨 {role:${groupA}}\n{role:${nightOwls}}`);
    const tokens = parseRoleSelectBody(msg.body);
    assert.deepEqual(tokens.map((t) => t.usergroupId), [groupA, nightOwls]);
    assert.equal(tokens[0]!.emoji, "🎨");
    assert.equal(tokens[1]!.emoji, null);
  });

  test("hydration: per-viewer member flags; non-selectable + cross-server tokens get NO entry", async () => {
    const body = buildRoleSelectBody([
      { emoji: null, usergroupId: groupA },
      { emoji: null, usergroupId: groupB },      // not selectable → excluded
      { emoji: null, usergroupId: groupOther },  // other server → excluded
    ]);
    const forHolder = await loadRoleSelectState(db, serverId, holder.id, body);
    assert.ok(forHolder);
    assert.deepEqual(forHolder!.roles.map((r) => r.usergroupId), [groupA]);
    assert.equal(forHolder!.roles[0]!.member, true);
    assert.equal(forHolder!.serverId, serverId);
    const forOutsider = await loadRoleSelectState(db, serverId, outsider.id, body);
    assert.equal(forOutsider!.roles[0]!.member, false);
    // A body whose every token is invalid hydrates to null → plain text.
    assert.equal(await loadRoleSelectState(db, serverId, holder.id, `{role:${groupOther}}`), null);
    // Ordinary prose never becomes a widget.
    assert.equal(await loadRoleSelectState(db, serverId, holder.id, `hey check {role:${groupA}} out`), null);
  });

  test("toggle rides the existing self-role endpoints (gates intact)", async () => {
    const token = await tokenFor(db, outsider.id);
    const put = await app.inject({ method: "PUT", url: `/servers/${serverId}/self-roles/${groupA}`, headers: auth(token) });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json(), { ok: true, member: true });
    const state = await loadRoleSelectState(db, serverId, outsider.id, `{role:${groupA}}`);
    assert.equal(state!.roles[0]!.member, true);

    const del = await app.inject({ method: "DELETE", url: `/servers/${serverId}/self-roles/${groupA}`, headers: auth(token) });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), { ok: true, member: false });

    // Non-selectable groups stay untoggleable — the endpoint's own clamp.
    const refused = await app.inject({ method: "PUT", url: `/servers/${serverId}/self-roles/${groupB}`, headers: auth(token) });
    assert.equal(refused.statusCode, 404);
  });
});

/* ── 7c: profile roles are server-contextual ── */

describe("access gate: id-based room reads 404 for non-holders", () => {
  test("messages, info, search, around, export all give the no-room 404; holders read", async () => {
    // A line in the gated room so the holder-side reads have content.
    await dispatch(holder, gatedRoomId, "gated hello");
    const posted = (await db.select().from(schema.messages)
      .where(eq(schema.messages.roomId, gatedRoomId)))[0]!;
    const before = Date.now() + 1_000;
    const urls = [
      `/rooms/${gatedRoomId}/messages?before=${before}`,
      `/rooms/${gatedRoomId}/info`,
      `/rooms/${gatedRoomId}/messages/search?q=gated`,
      `/rooms/${gatedRoomId}/messages/around?messageId=${posted.id}`,
      `/rooms/${gatedRoomId}/export`,
    ];
    const outsiderToken = await tokenFor(db, outsider.id);
    for (const url of urls) {
      const res = await app.inject({ method: "GET", url, headers: auth(outsiderToken) });
      assert.equal(res.statusCode, 404, url);
      assert.deepEqual(res.json(), { error: "no room" }, url);
    }
    const holderToken = await tokenFor(db, holder.id);
    for (const url of urls) {
      const res = await app.inject({ method: "GET", url, headers: auth(holderToken) });
      assert.equal(res.statusCode, 200, url);
    }
  });
});

describe("/roleselect: panels are unforgeable via plain says", () => {
  test("typed {role:} token lines persist un-marked and never hydrate; the command's panel does", async () => {
    const forgeRoomId = await mkRoom({ name: "Forge_Room", ownerId: owner.id, serverId });
    await dispatch(serverAdmin, forgeRoomId, "/roleselect Artists");
    await dispatch(outsider, forgeRoomId, `{role:${groupA}}`);

    const rows = await db.select().from(schema.messages)
      .where(eq(schema.messages.roomId, forgeRoomId));
    const real = rows.find((m) => m.userId === serverAdmin.id)!;
    const forged = rows.find((m) => m.userId === outsider.id)!;
    assert.equal(real.isRoleSelect, true, "command-written row carries the marker");
    assert.equal(forged.isRoleSelect, false, "typed tokens never get the marker");
    assert.equal(forged.body, `{role:${groupA}}`);

    const res = await app.inject({
      method: "GET",
      url: `/rooms/${forgeRoomId}/messages?before=${Date.now() + 1_000}`,
      headers: auth(await tokenFor(db, holder.id)),
    });
    assert.equal(res.statusCode, 200);
    const wire = (res.json() as { messages: Array<{ id: string; roleSelect?: unknown }> }).messages;
    assert.ok(wire.find((m) => m.id === real.id)?.roleSelect, "real panel hydrates");
    assert.equal(wire.find((m) => m.id === forged.id)?.roleSelect, undefined, "forged body stays plain text");
  });

  test("NBSP form of a spaced group name resolves like the underscore/quoted forms", async () => {
    const nbspRoomId = await mkRoom({ name: "Nbsp_Room", ownerId: owner.id, serverId });
    const notices = await dispatch(serverAdmin, nbspRoomId, "/roleselect Night Owls");
    assert.deepEqual(notices.map((n) => n.code), []);
    const msg = (await db.select().from(schema.messages)
      .where(eq(schema.messages.roomId, nbspRoomId)))[0]!;
    assert.equal(msg.body, `{role:${nightOwls}}`);
    assert.equal(msg.isRoleSelect, true);
  });
});

describe("profile roles (serverRolesFor)", () => {
  test("in-server lists the held groups; another server lists nothing; default groups never badge", async () => {
    const inServer = await serverRolesFor(db, serverId, holder.id);
    assert.deepEqual(inServer, [{ name: "Artists", color: "#8b5cf6" }]);
    assert.deepEqual(await serverRolesFor(db, otherServerId, holder.id), [], "other-server context is empty");

    // A default-group membership row (implicit-everyone bookkeeping) must
    // never surface as a badge.
    const def = await mkGroup(serverId, "Members", false, true);
    await db.insert(schema.serverUsergroupMembers).values({ groupId: def, userId: holder.id, isAuto: true });
    assert.deepEqual(await serverRolesFor(db, serverId, holder.id), [{ name: "Artists", color: "#8b5cf6" }]);
  });

  test("the offsite HTTP profile payload never carries serverRoles (socket-only decoration)", async () => {
    // The /p/<name> deep link serves lookupProfile's payload verbatim; the
    // serverRoles field is attached only in the profile:fetch socket handler.
    const p = await lookupProfile(db, holder.username, outsider.id);
    assert.ok(p);
    assert.equal("serverRoles" in p!, false);
  });
});
