import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import type { Role } from "@thekeep/shared";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { SessionUser } from "../src/commands/types.js";
import { dispatchChatInput } from "../src/realtime/dispatch.js";
import { CommandRegistry } from "../src/commands/registry.js";
import { registerBuiltins } from "../src/commands/builtins/index.js";
import { registerCommandsRoutes } from "../src/routes/commands.js";
import { registerServerCommandTitleRoutes } from "../src/servers/commandsTitles.js";
import { commandRestrictionFor, isRuleExemptCommand, loadCommandRules } from "../src/lib/commandRules.js";
import { DEFAULT_SERVER_ID } from "../src/earning/pool.js";
import { updateSettings } from "../src/settings.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Per-server command availability (server_command_rules +
 * server_command_role_gates, migration 0355). Pinned here: the dispatch
 * enforcement matrix (disabled / role-gated × non-holder / holder / server
 * staff / site staff), custom-command restriction by name, the
 * always-available safety set (console rejects rules; dispatch ignores
 * stray rows), NULL-serverId coalescing onto the default server, cascade
 * cleanup on usergroup + server delete, the console routes' gate + audit,
 * GET /commands per-server filtering, and the zero-rows byte-identity.
 */

const ADULT_DOB = "1990-01-01";

/* ── stubs (mirror room-role-gates.test.ts) ── */

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

function sessionUser(u: { id: string; username: string; role: Role }): SessionUser {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
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

let db: Db;
let app: FastifyInstance;
let registry: CommandRegistry;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let io: any;
type U = { id: string; username: string; role: Role };
let owner: U;      // servers.owner_user_id (no member row on purpose)
let serverMod: U;  // server_members role=mod
let holder: U;     // member holding groupA
let outsider: U;   // member with no roles
let siteMod: U;    // site staff
let serverId: string;
let otherServerId: string;
let groupA: string;
let roomId: string;       // room of serverId
let legacyRoomId: string; // serverId NULL → adopted by the default server

async function mkServer(ownerId: string, name: string, id = nanoid()): Promise<string> {
  await db.insert(schema.servers).values({
    id, slug: `srv-${id.slice(0, 8)}`.toLowerCase(), name,
    ownerUserId: ownerId, isSystem: false, isDefault: false,
    status: "active", visibility: "public", joinMode: "open",
  });
  return id;
}

let roomN = 0;
async function mkRoom(opts: { serverId?: string | null } = {}): Promise<string> {
  const id = nanoid();
  const name = `cmd-rule-room-${++roomN}`;
  await db.insert(schema.rooms).values({
    id, name, slug: name.toLowerCase(), type: "public",
    ...(opts.serverId !== undefined ? { serverId: opts.serverId } : {}),
  });
  return id;
}

async function dispatch(user: U, room: string, text: string): Promise<Notice[]> {
  const { socket, notices } = makeFakeSocket(room);
  // Presence stamps socket.data.serverId on every join (broadcast/presence.ts);
  // custom-command resolution reads it, so the stub mirrors that.
  const row = (await db.select({ serverId: schema.rooms.serverId }).from(schema.rooms)
    .where(eq(schema.rooms.id, room)).limit(1))[0];
  (socket.data as { serverId?: string }).serverId = row?.serverId ?? DEFAULT_SERVER_ID;
  await dispatchChatInput({ io, socket, db, registry, user: sessionUser(user), roomId: room, text });
  return notices;
}

async function messagesIn(room: string): Promise<number> {
  return (await db.select({ id: schema.messages.id }).from(schema.messages)
    .where(eq(schema.messages.roomId, room))).length;
}

async function setRule(sid: string, command: string, mode: "disabled" | "roles", roleIds: string[] = []): Promise<void> {
  await db.insert(schema.serverCommandRules).values({ serverId: sid, command, mode })
    .onConflictDoUpdate({ target: [schema.serverCommandRules.serverId, schema.serverCommandRules.command], set: { mode } });
  await db.delete(schema.serverCommandRoleGates)
    .where(and(eq(schema.serverCommandRoleGates.serverId, sid), eq(schema.serverCommandRoleGates.command, command)));
  if (roleIds.length) {
    await db.insert(schema.serverCommandRoleGates)
      .values(roleIds.map((g) => ({ serverId: sid, command, usergroupId: g })));
  }
}

async function clearRule(sid: string, command: string): Promise<void> {
  await db.delete(schema.serverCommandRoleGates)
    .where(and(eq(schema.serverCommandRoleGates.serverId, sid), eq(schema.serverCommandRoleGates.command, command)));
  await db.delete(schema.serverCommandRules)
    .where(and(eq(schema.serverCommandRules.serverId, sid), eq(schema.serverCommandRules.command, command)));
}

async function fetchCommandNames(token: string, sid?: string): Promise<string[]> {
  const url = sid ? `/commands?serverId=${encodeURIComponent(sid)}` : "/commands";
  const res = await app.inject({ method: "GET", url, headers: auth(token) });
  assert.equal(res.statusCode, 200);
  return (res.json() as { commands: Array<{ name: string }> }).commands.map((c) => c.name);
}

before(async () => {
  db = makeTestDb().db;
  io = makeFakeIo();
  registry = new CommandRegistry();
  registerBuiltins(registry);

  owner = { ...(await createUser(db, { birthdate: ADULT_DOB })), role: "user" };
  serverMod = { ...(await createUser(db, { birthdate: ADULT_DOB })), role: "user" };
  // `trusted` doubles the in-memory chat-rate budget so this file's many
  // dispatches never trip the limiter; it grants no staff/role bypass.
  holder = { ...(await createUser(db, { role: "trusted", birthdate: ADULT_DOB })), role: "trusted" };
  outsider = { ...(await createUser(db, { role: "trusted", birthdate: ADULT_DOB })), role: "trusted" };
  siteMod = { ...(await createUser(db, { role: "mod", birthdate: ADULT_DOB })), role: "mod" };

  // The console routes gate on the serversEnabled flag.
  await updateSettings(db, { serversEnabled: true }, owner.id);

  serverId = await mkServer(owner.id, "Rule Server");
  otherServerId = await mkServer(owner.id, "Elsewhere");
  // The default server row must exist for the NULL-serverId coalescing rule.
  await db.insert(schema.servers).values({
    id: DEFAULT_SERVER_ID, slug: "the-spire-system", name: "The Spire",
    ownerUserId: owner.id, isSystem: true, isDefault: true,
    status: "active", visibility: "public", joinMode: "open",
  }).onConflictDoNothing();
  await db.insert(schema.serverMembers).values([
    // The mod's console access rides the granular grant; the DISPATCH bypass
    // rides the role tier alone (any owner/admin/mod row).
    { serverId, userId: serverMod.id, role: "mod", permissionsJson: JSON.stringify(["manage_commands"]) },
    { serverId, userId: holder.id, role: "member" },
    { serverId, userId: outsider.id, role: "member" },
  ]);

  groupA = nanoid();
  await db.insert(schema.serverUsergroups).values({
    id: groupA, serverId, name: "Artists", isDefault: false,
    memberSelectable: true, color: "#8b5cf6", permissionsJson: "[]", autoRulesJson: "[]",
  });
  await db.insert(schema.serverUsergroupMembers).values({ groupId: groupA, userId: holder.id, isAuto: false });

  roomId = await mkRoom({ serverId });
  legacyRoomId = await mkRoom({ serverId: null });

  // This server's custom command, loaded into the live registry.
  await db.insert(schema.customCommands).values({
    id: nanoid(), name: "hug", kind: "action", template: "{sender} hugs {target}.",
    createdById: owner.id, serverId,
  });
  // A foreign server's custom command must never leak into this server's list.
  await db.insert(schema.customCommands).values({
    id: nanoid(), name: "foreignwave", kind: "action", template: "{sender} waves.",
    createdById: owner.id, serverId: otherServerId,
  });
  await registry.reloadCustom(db);

  app = Fastify();
  await registerCommandsRoutes(app, db, registry);
  await registerServerCommandTitleRoutes(app, db, io, registry);
  await app.ready();
});

/* ── zero rows = byte-identical ── */

describe("defaults: zero rules change nothing", () => {
  test("commands run for everyone and the doc list is identical scoped vs unscoped", async () => {
    const notices = await dispatch(outsider, roomId, "/me stretches");
    assert.deepEqual(notices.map((n) => n.code), []);
    assert.equal(await messagesIn(roomId), 1);

    const token = await tokenFor(db, outsider.id);
    const unscoped = await fetchCommandNames(token);
    const scoped = await fetchCommandNames(token, serverId);
    // Scoping only prunes foreign custom commands; with zero rules every
    // builtin + this server's customs are identical to the unscoped list.
    assert.deepEqual(scoped, unscoped.filter((n) => n !== "foreignwave"));
    assert.ok(scoped.includes("me"));
    assert.ok(scoped.includes("hug"));
  });
});

/* ── enforcement matrix ── */

describe("dispatch: disabled command", () => {
  before(async () => { await setRule(serverId, "roll", "disabled"); });

  test("non-staff members are refused (nothing persists); staff tiers bypass", async () => {
    for (const denied of [outsider, holder]) {
      const notices = await dispatch(denied, roomId, "/roll 1d20");
      assert.equal(notices[0]?.code, "CMD_OFF", denied.username);
    }
    const beforeCount = await messagesIn(roomId);
    for (const poster of [serverMod, owner, siteMod]) {
      const notices = await dispatch(poster, roomId, "/roll 1d20");
      assert.deepEqual(notices.map((n) => n.code), [], poster.username);
    }
    assert.equal(await messagesIn(roomId), beforeCount + 3);
  });

  test("aliases resolve to the canonical rule (/dice is /roll)", async () => {
    const notices = await dispatch(outsider, roomId, "/dice 1d6");
    assert.equal(notices[0]?.code, "CMD_OFF");
  });

  test("the rule is scoped to ITS server: the same command runs in a legacy room", async () => {
    const notices = await dispatch(outsider, legacyRoomId, "/roll 1d20");
    assert.deepEqual(notices.map((n) => n.code), []);
  });

  test("whisper-family commands are restrictable like the rest", async () => {
    await setRule(serverId, "whisper", "disabled");
    const notices = await dispatch(outsider, roomId, `/whisper ${holder.username} psst`);
    assert.equal(notices[0]?.code, "CMD_OFF");
    await clearRule(serverId, "whisper");
  });
});

describe("dispatch: role-gated command", () => {
  before(async () => { await setRule(serverId, "me", "roles", [groupA]); });

  test("holder + staff pass; non-holder gets the role refusal", async () => {
    const denied = await dispatch(outsider, roomId, "/me shuffles");
    assert.equal(denied[0]?.code, "CMD_NEEDS_ROLE");
    for (const poster of [holder, serverMod, owner, siteMod]) {
      const notices = await dispatch(poster, roomId, "/me nods");
      assert.deepEqual(notices.map((n) => n.code), [], poster.username);
    }
  });

  test("composes with existing gates: a muted holder is still muted", async () => {
    await db.insert(schema.mutes).values({
      roomId, userId: holder.id, until: new Date(Date.now() + 60_000), reason: "test", issuedById: null,
    });
    const notices = await dispatch(holder, roomId, "/me tries to speak");
    assert.equal(notices[0]?.code, "MUTED");
    await db.delete(schema.mutes).where(and(eq(schema.mutes.roomId, roomId), eq(schema.mutes.userId, holder.id)));
  });

  test("group delete cascades the role rows; the orphan rule falls back to everyone", async () => {
    const g = nanoid();
    await db.insert(schema.serverUsergroups).values({
      id: g, serverId, name: "Ephemeral", isDefault: false,
      memberSelectable: true, permissionsJson: "[]", autoRulesJson: "[]",
    });
    await setRule(serverId, "topic", "roles", [g]);
    const deniedBefore = await dispatch(outsider, roomId, "/topic testing");
    assert.equal(deniedBefore[0]?.code, "CMD_NEEDS_ROLE");

    await db.delete(schema.serverUsergroups).where(eq(schema.serverUsergroups.id, g));
    const rows = await db.select().from(schema.serverCommandRoleGates)
      .where(and(eq(schema.serverCommandRoleGates.serverId, serverId), eq(schema.serverCommandRoleGates.command, "topic")));
    assert.equal(rows.length, 0, "cascade removed the gate rows");
    const after = await dispatch(outsider, roomId, "/topic testing again");
    assert.equal(after.some((n) => n.code === "CMD_NEEDS_ROLE"), false, "zero-role rule is available to everyone");
    await clearRule(serverId, "topic");
  });
});

describe("dispatch: custom commands ride the same lane", () => {
  test("a disabled custom command refuses non-staff and runs for staff", async () => {
    await setRule(serverId, "hug", "disabled");
    const denied = await dispatch(outsider, roomId, `/hug ${holder.username}`);
    assert.equal(denied[0]?.code, "CMD_OFF");
    const allowed = await dispatch(serverMod, roomId, `/hug ${holder.username}`);
    assert.deepEqual(allowed.map((n) => n.code), []);
    await clearRule(serverId, "hug");
  });
});

describe("inline `!cmd` lane honors the rules", () => {
  async function bodyWith(room: string, tag: string): Promise<string> {
    const rows = await db.select({ body: schema.messages.body }).from(schema.messages)
      .where(eq(schema.messages.roomId, room));
    const hit = rows.find((r) => r.body.includes(tag));
    assert.ok(hit, `message tagged ${tag} persisted`);
    return hit.body;
  }

  test("a disabled command's inline form stays literal for members; staff still expand", async () => {
    await setRule(serverId, "roll", "disabled");
    const memberTag = `inl-${nanoid().slice(0, 8)}`;
    const notices = await dispatch(outsider, roomId, `${memberTag} attacks !roll:1d20`);
    assert.deepEqual(notices.map((n) => n.code), [], "the say itself is not refused");
    assert.ok((await bodyWith(roomId, memberTag)).includes("!roll:1d20"), "token degrades to literal text");

    for (const staff of [serverMod, siteMod]) {
      const staffTag = `inl-${nanoid().slice(0, 8)}`;
      await dispatch(staff, roomId, `${staffTag} attacks !roll:1d20`);
      assert.equal((await bodyWith(roomId, staffTag)).includes("!roll:1d20"), false, staff.username);
    }

    // The rule is scoped to ITS server: the same token expands in a legacy room.
    const legacyTag = `inl-${nanoid().slice(0, 8)}`;
    await dispatch(outsider, legacyRoomId, `${legacyTag} attacks !roll:1d20`);
    assert.equal((await bodyWith(legacyRoomId, legacyTag)).includes("!roll:1d20"), false);
    await clearRule(serverId, "roll");
  });

  test("a role-gated command's inline form stays literal for non-holders only", async () => {
    await setRule(serverId, "roll", "roles", [groupA]);
    const outsiderTag = `inl-${nanoid().slice(0, 8)}`;
    await dispatch(outsider, roomId, `${outsiderTag} tries !roll:1d6`);
    assert.ok((await bodyWith(roomId, outsiderTag)).includes("!roll:1d6"));
    const holderTag = `inl-${nanoid().slice(0, 8)}`;
    await dispatch(holder, roomId, `${holderTag} tries !roll:1d6`);
    assert.equal((await bodyWith(roomId, holderTag)).includes("!roll:1d6"), false);
    await clearRule(serverId, "roll");
  });
});

describe("dispatch: NULL rooms.server_id coalesces onto the default server", () => {
  test("a default-server rule bites in legacy rooms", async () => {
    await setRule(DEFAULT_SERVER_ID, "roll", "disabled");
    const denied = await dispatch(outsider, legacyRoomId, "/roll 1d20");
    assert.equal(denied[0]?.code, "CMD_OFF");
    const staffOk = await dispatch(siteMod, legacyRoomId, "/roll 1d20");
    assert.deepEqual(staffOk.map((n) => n.code), []);
    await clearRule(DEFAULT_SERVER_ID, "roll");
  });
});

/* ── always-available safety set ── */

describe("always-available commands are immune", () => {
  test("the exemption covers /help, /report and permission-gated builtins", () => {
    assert.equal(isRuleExemptCommand({ name: "help" }), true);
    assert.equal(isRuleExemptCommand({ name: "report" }), true);
    assert.equal(isRuleExemptCommand({ name: "trash", permission: "delete_others_message" }), true);
    assert.equal(isRuleExemptCommand({ name: "roll" }), false);
  });

  test("dispatch ignores stray rows for exempt commands", async () => {
    await setRule(serverId, "help", "disabled");
    await setRule(serverId, "trash", "disabled");
    const helpNotices = await dispatch(outsider, roomId, "/help");
    assert.equal(helpNotices.some((n) => n.code === "CMD_OFF"), false, "/help never refuses");
    // /trash still fails on its OWN permission gate, not the rule.
    const trashNotices = await dispatch(outsider, roomId, "/trash 5m");
    assert.equal(trashNotices[0]?.code, "PERM");
    await clearRule(serverId, "help");
    await clearRule(serverId, "trash");
  });

  test("the console PUT refuses to write rules for them", async () => {
    const token = await tokenFor(db, owner.id);
    for (const name of ["help", "trash"]) {
      const res = await app.inject({
        method: "PUT", url: `/servers/${serverId}/command-rules/${name}`,
        headers: auth(token), payload: { mode: "disabled" },
      });
      assert.equal(res.statusCode, 400, name);
    }
  });
});

/* ── console routes ── */

describe("console: GET /servers/:id/command-rules", () => {
  test("gate: members without manage_commands are refused; owner + server mod pass", async () => {
    const denied = await app.inject({
      method: "GET", url: `/servers/${serverId}/command-rules`,
      headers: auth(await tokenFor(db, outsider.id)),
    });
    assert.equal(denied.statusCode, 403);
    for (const viewer of [owner, serverMod]) {
      const res = await app.inject({
        method: "GET", url: `/servers/${serverId}/command-rules`,
        headers: auth(await tokenFor(db, viewer.id)),
      });
      assert.equal(res.statusCode, 200, viewer.username);
    }
  });

  test("lists controllable commands only: no /help, no staff-gated builtins, no foreign customs", async () => {
    const res = await app.inject({
      method: "GET", url: `/servers/${serverId}/command-rules`,
      headers: auth(await tokenFor(db, owner.id)),
    });
    const body = res.json() as { commands: Array<{ name: string; isCustom: boolean }>; groups: Array<{ id: string }>; rules: unknown[] };
    const names = body.commands.map((c) => c.name);
    assert.ok(names.includes("roll"));
    assert.ok(names.includes("me"));
    assert.equal(names.includes("help"), false, "always-available never listed");
    assert.equal(names.includes("trash"), false, "permission-gated never listed");
    assert.equal(names.includes("incognito"), false, "permission-gated never listed");
    assert.equal(names.includes("foreignwave"), false, "foreign custom never listed");
    const hug = body.commands.find((c) => c.name === "hug");
    assert.equal(hug?.isCustom, true);
    assert.ok(body.groups.some((g) => g.id === groupA));
  });
});

describe("console: PUT /servers/:id/command-rules/:cmdName", () => {
  test("writes + audits; aliases canonicalize; 'everyone' clears; unknown role 404s", async () => {
    const token = await tokenFor(db, owner.id);
    // Alias PUT lands on the canonical name.
    const put = await app.inject({
      method: "PUT", url: `/servers/${serverId}/command-rules/dice`,
      headers: auth(token), payload: { mode: "disabled" },
    });
    assert.equal(put.statusCode, 200);
    let rules = await loadCommandRules(db, serverId);
    assert.equal(rules.get("roll")?.mode, "disabled");
    assert.equal(rules.has("dice"), false);

    // Audit entry names the command + mode, scoped to this server.
    const audits = await db.select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "server_command_rule_set"), eq(schema.auditLog.serverId, serverId)));
    assert.ok(audits.length >= 1);
    const meta = JSON.parse(audits.at(-1)!.metadataJson ?? "{}") as { command?: string; mode?: string };
    assert.equal(meta.command, "roll");
    assert.equal(meta.mode, "disabled");

    // Role mode with this server's group.
    const roles = await app.inject({
      method: "PUT", url: `/servers/${serverId}/command-rules/roll`,
      headers: auth(token), payload: { mode: "roles", roleIds: [groupA] },
    });
    assert.equal(roles.statusCode, 200);
    rules = await loadCommandRules(db, serverId);
    assert.deepEqual([...(rules.get("roll")?.roleIds ?? [])], [groupA]);
    assert.equal((await dispatch(outsider, roomId, "/roll 1d4"))[0]?.code, "CMD_NEEDS_ROLE");
    assert.deepEqual((await dispatch(holder, roomId, "/roll 1d4")).map((n) => n.code), []);

    // Foreign / unknown role ids never half-apply.
    const foreign = await app.inject({
      method: "PUT", url: `/servers/${serverId}/command-rules/roll`,
      headers: auth(token), payload: { mode: "roles", roleIds: [nanoid()] },
    });
    assert.equal(foreign.statusCode, 404);

    // Everyone clears both tables.
    const clear = await app.inject({
      method: "PUT", url: `/servers/${serverId}/command-rules/roll`,
      headers: auth(token), payload: { mode: "everyone" },
    });
    assert.equal(clear.statusCode, 200);
    rules = await loadCommandRules(db, serverId);
    assert.equal(rules.has("roll"), false);
    assert.deepEqual((await dispatch(outsider, roomId, "/roll 1d4")).map((n) => n.code), []);
  });

  test("unknown commands 404; the gate refuses plain members", async () => {
    const token = await tokenFor(db, owner.id);
    const unknown = await app.inject({
      method: "PUT", url: `/servers/${serverId}/command-rules/nonesuch`,
      headers: auth(token), payload: { mode: "disabled" },
    });
    assert.equal(unknown.statusCode, 404);
    const denied = await app.inject({
      method: "PUT", url: `/servers/${serverId}/command-rules/roll`,
      headers: auth(await tokenFor(db, outsider.id)), payload: { mode: "disabled" },
    });
    assert.equal(denied.statusCode, 403);
  });
});

/* ── GET /commands filtering ── */

describe("GET /commands hides unavailable commands per server", () => {
  before(async () => {
    await setRule(serverId, "roll", "disabled");
    await setRule(serverId, "me", "roles", [groupA]);
    await setRule(serverId, "hug", "disabled");
  });

  test("non-holder loses disabled + role-gated + restricted customs; unscoped list unchanged", async () => {
    const token = await tokenFor(db, outsider.id);
    const scoped = await fetchCommandNames(token, serverId);
    assert.equal(scoped.includes("roll"), false);
    assert.equal(scoped.includes("me"), false);
    assert.equal(scoped.includes("hug"), false);
    assert.ok(scoped.includes("help"), "always-available survives");
    const unscoped = await fetchCommandNames(token);
    assert.ok(unscoped.includes("roll"), "no serverId param = the historic list");
    assert.ok(unscoped.includes("me"));
  });

  test("holders keep role-gated commands; staff keep everything", async () => {
    const holderList = await fetchCommandNames(await tokenFor(db, holder.id), serverId);
    assert.ok(holderList.includes("me"), "role holder keeps /me");
    assert.equal(holderList.includes("roll"), false, "disabled stays hidden for holders");
    for (const staff of [serverMod, owner, siteMod]) {
      const list = await fetchCommandNames(await tokenFor(db, staff.id), serverId);
      assert.ok(list.includes("roll"), staff.username);
      assert.ok(list.includes("me"), staff.username);
      assert.ok(list.includes("hug"), staff.username);
    }
  });

  test("foreign servers never see this server's customs regardless of rules", async () => {
    const list = await fetchCommandNames(await tokenFor(db, outsider.id), otherServerId);
    assert.equal(list.includes("hug"), false);
    assert.ok(list.includes("foreignwave"));
  });
});

/* ── cascade: server delete ── */

describe("cascade: deleting the server removes its rules", () => {
  test("rule + role rows die with the server", async () => {
    const s = await mkServer(owner.id, "Doomed");
    const g = nanoid();
    await db.insert(schema.serverUsergroups).values({
      id: g, serverId: s, name: "Doomed Roles", isDefault: false,
      memberSelectable: true, permissionsJson: "[]", autoRulesJson: "[]",
    });
    await setRule(s, "roll", "roles", [g]);
    assert.equal((await loadCommandRules(db, s)).size, 1);

    await db.delete(schema.servers).where(eq(schema.servers.id, s));
    assert.equal((await loadCommandRules(db, s)).size, 0, "rules cascaded");
    const gates = await db.select().from(schema.serverCommandRoleGates)
      .where(eq(schema.serverCommandRoleGates.serverId, s));
    assert.equal(gates.length, 0, "role rows cascaded");
  });
});

/* ── helper matrix sanity ── */

describe("commandRestrictionFor helper", () => {
  test("no rule → null; disabled → 'disabled'; roles → 'role' for non-holders only", async () => {
    await clearRule(serverId, "scene");
    assert.equal(await commandRestrictionFor(db, sessionUser(outsider), serverId, { name: "scene" }), null);
    await setRule(serverId, "scene", "disabled");
    assert.equal(await commandRestrictionFor(db, sessionUser(outsider), serverId, { name: "scene" }), "disabled");
    assert.equal(await commandRestrictionFor(db, sessionUser(owner), serverId, { name: "scene" }), null, "server owner bypass");
    assert.equal(await commandRestrictionFor(db, sessionUser(serverMod), serverId, { name: "scene" }), null, "server mod bypass");
    assert.equal(await commandRestrictionFor(db, sessionUser(siteMod), serverId, { name: "scene" }), null, "site staff bypass");
    await setRule(serverId, "scene", "roles", [groupA]);
    assert.equal(await commandRestrictionFor(db, sessionUser(outsider), serverId, { name: "scene" }), "role");
    assert.equal(await commandRestrictionFor(db, sessionUser(holder), serverId, { name: "scene" }), null);
    await clearRule(serverId, "scene");
  });
});
