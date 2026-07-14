import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { registerServerCatalogRoutes } from "../src/routes/serversCatalog.js";
import { registerServerConsoleRoutes } from "../src/routes/serversConsole.js";
import { registerServerMembershipRoutes } from "../src/routes/serversMembership.js";
import { registerServerModerationRoutes } from "../src/routes/serversModeration.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { serverAuthority, serverCan } from "../src/servers/authority.js";
import { consumeInvitedLanding, redeemInviteForSignup } from "../src/servers/inviteLinks.js";
import { greetNewcomerOnce } from "../src/realtime/targetedMessages.js";
import { getSessionUser } from "../src/routes/auth.js";
import { ensureSiteSettings, updateSettings } from "../src/settings.js";
import type { ServerRoutesCtx } from "../src/routes/serversShared.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Server invite links (migration 0356): the public /i/<code> info endpoint's
 * safety matrix (dead / moderated / archived / NSFW-public-safe), the
 * logged-in one-click join (approval semantics preserved, age gate, bans,
 * atomic consumption), the who-can-create policy matrix (staff / roles / all
 * + the non-staff cap + own-revoke vs staff-revoke + audit), invites dying
 * with the membership (leave / removal / ban), and the registration
 * carry-through (auto-join + first-landing stamp + greeter placement).
 */

const ADULT_DOB = "1990-01-01";
const MINOR_DOB = "2012-01-01";
const SYSTEM_SERVER_ID = "server_spire_system";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeIo(): any {
  return {
    async fetchSockets() { return []; },
    in() {
      return {
        async fetchSockets() { return []; },
        emit() { /* no live sockets */ },
      };
    },
    to() { return { emit() { /* no-op */ } }; },
    emit() { /* no-op */ },
  };
}

/** Mirror of the ctx routes/servers.ts builds — real authority gates over the
 *  test DB, with the flag check + image writers stubbed. resolveServerTarget
 *  supports the @id:<userId> token the ban test uses. */
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
    resolveServerTarget: async (raw) => {
      const id = raw.startsWith("@id:") ? raw.slice(4) : null;
      if (!id) return { ok: false, error: "unsupported target form in tests" };
      const row = (await db.select({ id: schema.users.id, username: schema.users.username })
        .from(schema.users).where(eq(schema.users.id, id)).limit(1))[0];
      return row ? { ok: true, userId: row.id, username: row.username } : { ok: false, error: "no such user" };
    },
    writeServerImage: async () => ({ error: "unused in these tests", status: 400 }),
    unlinkServerImage: () => {},
  };
}

let db: Db;
let app: FastifyInstance;
let owner: { id: string; username: string };
let inviteMod: { id: string; username: string };   // mod holding manage_invites
let plainMember: { id: string; username: string };
let roleMember: { id: string; username: string };  // member of the picked usergroup
let outsider: { id: string; username: string };
let minor: { id: string; username: string };
let ownerToken: string;
let inviteModToken: string;
let plainMemberToken: string;
let roleMemberToken: string;
let outsiderToken: string;
let minorToken: string;

let srvOpen: string;          // joinMode=open, public
let srvOpenLandingRoom: string;
let srvInvite: string;        // joinMode=invite
let srvApp: string;           // joinMode=application
let srvNsfw: string;          // 18+ community
let srvModded: string;        // suspended
let srvArchived: string;      // archived
let inviteGroup: string;      // usergroup for the 'roles' mode

async function mkServer(opts: {
  name: string;
  joinMode?: "open" | "application" | "invite";
  isNsfw?: boolean;
  moderationState?: "none" | "suspended" | "banned";
  status?: "active" | "archived";
  visibility?: "public" | "unlisted" | "invite_only";
  inviteCreateMode?: "staff" | "roles" | "all";
  inviteCreateGroupIds?: string[];
  bannerImageUrl?: string;
  sfwBannerUrl?: string;
}): Promise<string> {
  const id = nanoid();
  await db.insert(schema.servers).values({
    id,
    slug: `srv-${id.slice(0, 8).toLowerCase()}`,
    name: opts.name,
    ownerUserId: owner.id,
    joinMode: opts.joinMode ?? "open",
    isNsfw: opts.isNsfw ?? false,
    moderationState: opts.moderationState ?? "none",
    status: opts.status ?? "active",
    visibility: opts.visibility ?? "public",
    inviteCreateMode: opts.inviteCreateMode ?? "staff",
    inviteCreateGroupIds: opts.inviteCreateGroupIds ? JSON.stringify(opts.inviteCreateGroupIds) : null,
    bannerImageUrl: opts.bannerImageUrl ?? null,
    sfwBannerUrl: opts.sfwBannerUrl ?? null,
  });
  return id;
}

async function mint(serverId: string, opts: {
  createdBy?: string | null;
  maxUses?: number | null;
  usedCount?: number;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
} = {}): Promise<string> {
  const code = `code_${nanoid(12)}`;
  await db.insert(schema.serverInvites).values({
    id: nanoid(),
    serverId,
    code,
    createdByUserId: opts.createdBy ?? owner.id,
    maxUses: opts.maxUses ?? null,
    usedCount: opts.usedCount ?? 0,
    expiresAt: opts.expiresAt ?? null,
    revokedAt: opts.revokedAt ?? null,
  });
  return code;
}

async function inviteRow(code: string) {
  return (await db.select().from(schema.serverInvites)
    .where(eq(schema.serverInvites.code, code)).limit(1))[0];
}

async function isMember(serverId: string, userId: string): Promise<boolean> {
  return !!(await db.select().from(schema.serverMembers)
    .where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, userId)))
    .limit(1))[0];
}

/** Fetch a captcha and solve its "What is A + B?" question. */
async function solvedCaptcha(): Promise<{ captchaId: string; captchaAnswer: string }> {
  const res = await app.inject({ method: "GET", url: "/auth/captcha" });
  const j = res.json() as { id: string; question: string };
  const m = /What is (\d+) \+ (\d+)\?/.exec(j.question);
  assert.ok(m, "captcha question is the expected math shape");
  return { captchaId: j.id, captchaAnswer: String(Number(m![1]) + Number(m![2])) };
}

async function register(username: string, opts: { birthdate?: string; inviteCode?: string } = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      email: `${username.toLowerCase()}@test.local`,
      username,
      password: "hunter2hunter2",
      acceptDisclaimer: true,
      birthdate: opts.birthdate ?? ADULT_DOB,
      ...(opts.inviteCode ? { inviteCode: opts.inviteCode } : {}),
      ...(await solvedCaptcha()),
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { id: string; sessionToken: string };
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
  registerServerModerationRoutes(ctx);
  await registerAuthRoutes(app, db);
  await app.ready();

  await ensureSiteSettings(db);

  // The `system` sentinel authors persisted targeted lines (the greeter);
  // boot ensures it in prod, tests seed it by hand.
  await createUser(db, { username: "system", birthdate: ADULT_DOB });

  owner = await createUser(db, { birthdate: ADULT_DOB });
  inviteMod = await createUser(db, { birthdate: ADULT_DOB });
  plainMember = await createUser(db, { birthdate: ADULT_DOB });
  roleMember = await createUser(db, { birthdate: ADULT_DOB });
  outsider = await createUser(db, { birthdate: ADULT_DOB });
  minor = await createUser(db, { birthdate: MINOR_DOB });
  ownerToken = await tokenFor(db, owner.id);
  inviteModToken = await tokenFor(db, inviteMod.id);
  plainMemberToken = await tokenFor(db, plainMember.id);
  roleMemberToken = await tokenFor(db, roleMember.id);
  outsiderToken = await tokenFor(db, outsider.id);
  minorToken = await tokenFor(db, minor.id);

  // The registration carry-through only runs while the servers feature is on.
  // Minor signups are allowed so the minor+18+-invite refusal path can be
  // driven through the real register route.
  await updateSettings(db, { serversEnabled: true, allowMinorSignups: true }, owner.id);

  // The default/system server the register route enrolls every account into.
  await db.insert(schema.servers).values({
    id: SYSTEM_SERVER_ID, slug: "spire", name: "The Spire", ownerUserId: owner.id,
    isSystem: true, isDefault: true,
  });

  srvOpen = await mkServer({ name: "Open Keep" });
  srvInvite = await mkServer({ name: "Invite Keep", joinMode: "invite" });
  srvApp = await mkServer({ name: "Application Keep", joinMode: "application" });
  srvNsfw = await mkServer({
    name: "Adult Keep", isNsfw: true,
    bannerImageUrl: "https://example.test/real-banner.png",
    sfwBannerUrl: "https://example.test/safe-banner.png",
  });
  srvModded = await mkServer({ name: "Suspended Keep", moderationState: "suspended" });
  srvArchived = await mkServer({ name: "Archived Keep", status: "archived" });

  // Landing room for the carry-through placement assertion (findServerLanding
  // tier 3: live public non-forum non-linked room).
  srvOpenLandingRoom = nanoid();
  await db.insert(schema.rooms).values({
    id: srvOpenLandingRoom, name: "Open_Hall", type: "public", serverId: srvOpen,
  });

  // Memberships + the manage_invites mod.
  await db.insert(schema.serverMembers).values([
    { serverId: srvOpen, userId: inviteMod.id, role: "mod", permissionsJson: JSON.stringify(["manage_invites"]) },
    { serverId: srvOpen, userId: plainMember.id, role: "member" },
    { serverId: srvOpen, userId: roleMember.id, role: "member" },
  ]);

  // A named usergroup for the 'roles' creation mode; roleMember belongs.
  inviteGroup = nanoid();
  await db.insert(schema.serverUsergroups).values({
    id: inviteGroup, serverId: srvOpen, name: "Heralds",
  });
  await db.insert(schema.serverUsergroupMembers).values({
    groupId: inviteGroup, userId: roleMember.id,
  });
});

/* =========================================================================
 * Public info endpoint — GET /servers/invite/:code
 * ======================================================================= */

describe("public invite info", () => {
  test("a valid code resolves the community's public-safe card", async () => {
    const code = await mint(srvOpen);
    const res = await app.inject({ method: "GET", url: `/servers/invite/${code}` });
    assert.equal(res.statusCode, 200, res.body);
    const j = res.json() as Record<string, unknown>;
    assert.equal(j.name, "Open Keep");
    assert.equal(j.code, code);
    assert.equal(j.joinMode, "open");
    assert.equal(j.isNsfw, false);
    assert.equal(typeof j.memberCount, "number");
  });

  test("dead codes are a uniform 404: unknown / revoked / expired / used up", async () => {
    const revoked = await mint(srvOpen, { revokedAt: new Date() });
    const expired = await mint(srvOpen, { expiresAt: new Date(Date.now() - 1000) });
    const spent = await mint(srvOpen, { maxUses: 1, usedCount: 1 });
    for (const code of ["nope_never_existed", revoked, expired, spent]) {
      const res = await app.inject({ method: "GET", url: `/servers/invite/${code}` });
      assert.equal(res.statusCode, 404, `code ${code} should be invalid`);
    }
  });

  test("moderated and archived servers read as plain invalid (no status leak)", async () => {
    for (const sid of [srvModded, srvArchived]) {
      const code = await mint(sid);
      const res = await app.inject({ method: "GET", url: `/servers/invite/${code}` });
      assert.equal(res.statusCode, 404);
      assert.equal((res.json() as { error?: string }).error, "not found");
    }
  });

  test("an 18+ community's invite page swaps in the public-safe banner", async () => {
    const code = await mint(srvNsfw);
    const res = await app.inject({ method: "GET", url: `/servers/invite/${code}` });
    assert.equal(res.statusCode, 200, res.body);
    const j = res.json() as { isNsfw: boolean; bannerImageUrl: string | null };
    assert.equal(j.isNsfw, true);
    assert.equal(j.bannerImageUrl, "https://example.test/safe-banner.png");
  });

  test("the code is the capability: an unlisted community still resolves", async () => {
    const hidden = await mkServer({ name: "Hidden Keep", visibility: "unlisted" });
    const code = await mint(hidden);
    const res = await app.inject({ method: "GET", url: `/servers/invite/${code}` });
    assert.equal(res.statusCode, 200, res.body);
  });
});

/* =========================================================================
 * Logged-in join — POST /servers/invite/:code/join
 * ======================================================================= */

describe("logged-in invite join", () => {
  test("a non-member joins and consumes exactly one use", async () => {
    const code = await mint(srvOpen, { maxUses: 5 });
    const res = await app.inject({ method: "POST", url: `/servers/invite/${code}/join`, headers: auth(outsiderToken) });
    assert.equal(res.statusCode, 200, res.body);
    const j = res.json() as { ok: boolean; alreadyMember: boolean; serverId: string };
    assert.equal(j.alreadyMember, false);
    assert.equal(j.serverId, srvOpen);
    assert.equal(await isMember(srvOpen, outsider.id), true);
    assert.equal((await inviteRow(code))!.usedCount, 1);

    // Members short-circuit to alreadyMember WITHOUT consuming another use.
    const again = await app.inject({ method: "POST", url: `/servers/invite/${code}/join`, headers: auth(outsiderToken) });
    assert.equal(again.statusCode, 200);
    assert.equal((again.json() as { alreadyMember: boolean }).alreadyMember, true);
    assert.equal((await inviteRow(code))!.usedCount, 1);
  });

  test("an invite-mode server joins through the code (the code-gated path holds)", async () => {
    const code = await mint(srvInvite);
    const res = await app.inject({ method: "POST", url: `/servers/invite/${code}/join`, headers: auth(plainMemberToken) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await isMember(srvInvite, plainMember.id), true);
  });

  test("codes do NOT bypass application review (pre-existing semantics preserved)", async () => {
    const code = await mint(srvApp);
    const res = await app.inject({ method: "POST", url: `/servers/invite/${code}/join`, headers: auth(outsiderToken) });
    assert.equal(res.statusCode, 409);
    assert.equal((res.json() as { code?: string }).code, "APPLICATION_REQUIRED");
    assert.equal(await isMember(srvApp, outsider.id), false);
    assert.equal((await inviteRow(code))!.usedCount, 0);
  });

  test("a minor bounces off an 18+ community with an honest refusal, nothing consumed", async () => {
    const code = await mint(srvNsfw);
    const res = await app.inject({ method: "POST", url: `/servers/invite/${code}/join`, headers: auth(minorToken) });
    assert.equal(res.statusCode, 403);
    assert.equal((res.json() as { code?: string }).code, "AGE_RESTRICTED");
    assert.equal(await isMember(srvNsfw, minor.id), false);
    assert.equal((await inviteRow(code))!.usedCount, 0);
  });

  test("a server-banned user can't slip back in through an invite", async () => {
    const bannedUser = await createUser(db, { birthdate: ADULT_DOB });
    const bannedToken = await tokenFor(db, bannedUser.id);
    await db.insert(schema.serverBans).values({ serverId: srvOpen, userId: bannedUser.id, until: null });
    const code = await mint(srvOpen);
    const res = await app.inject({ method: "POST", url: `/servers/invite/${code}/join`, headers: auth(bannedToken) });
    assert.equal(res.statusCode, 403);
    assert.equal(await isMember(srvOpen, bannedUser.id), false);
  });

  test("a spent single-use code reads as invalid for the next visitor", async () => {
    const code = await mint(srvOpen, { maxUses: 1 });
    const u1 = await createUser(db, { birthdate: ADULT_DOB });
    const u2 = await createUser(db, { birthdate: ADULT_DOB });
    const first = await app.inject({ method: "POST", url: `/servers/invite/${code}/join`, headers: auth(await tokenFor(db, u1.id)) });
    assert.equal(first.statusCode, 200, first.body);
    const second = await app.inject({ method: "POST", url: `/servers/invite/${code}/join`, headers: auth(await tokenFor(db, u2.id)) });
    assert.equal(second.statusCode, 404);
    assert.equal(await isMember(srvOpen, u2.id), false);
  });

  test("a moderated server's invite is a uniform 404, never a moderation notice", async () => {
    const code = await mint(srvModded);
    const res = await app.inject({ method: "POST", url: `/servers/invite/${code}/join`, headers: auth(outsiderToken) });
    assert.equal(res.statusCode, 404);
  });

  test("anonymous join is refused", async () => {
    const code = await mint(srvOpen);
    const res = await app.inject({ method: "POST", url: `/servers/invite/${code}/join` });
    assert.equal(res.statusCode, 401);
  });
});

/* =========================================================================
 * Creation policy — POST /servers/:id/invites (+ mine / revoke / audit)
 * ======================================================================= */

async function createInvite(serverId: string, token: string, body: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: `/servers/${serverId}/invites`,
    headers: { ...auth(token), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

async function setCreateMode(serverId: string, mode: "staff" | "roles" | "all", groupIds: string[] = []) {
  await db.update(schema.servers)
    .set({ inviteCreateMode: mode, inviteCreateGroupIds: groupIds.length ? JSON.stringify(groupIds) : null })
    .where(eq(schema.servers.id, serverId));
}

describe("who can create invite links", () => {
  test("staff-only (the default): members are refused; owner + manage_invites mod pass", async () => {
    await setCreateMode(srvOpen, "staff");
    assert.equal((await createInvite(srvOpen, plainMemberToken)).statusCode, 403);
    assert.equal((await createInvite(srvOpen, roleMemberToken)).statusCode, 403);
    assert.equal((await createInvite(srvOpen, ownerToken)).statusCode, 200);
    assert.equal((await createInvite(srvOpen, inviteModToken)).statusCode, 200);
  });

  test("all members: any member passes, non-members are still refused", async () => {
    await setCreateMode(srvOpen, "all");
    const res = await createInvite(srvOpen, plainMemberToken);
    assert.equal(res.statusCode, 200, res.body);
    const j = res.json() as { invite: { code: string; link: string | null; createdByUsername: string | null } };
    assert.ok(j.invite.code.length > 0);
    assert.equal(j.invite.createdByUsername, plainMember.username);
    // Fresh outsider with no membership anywhere on this server.
    const nobody = await createUser(db, { birthdate: ADULT_DOB });
    assert.equal((await createInvite(srvOpen, await tokenFor(db, nobody.id))).statusCode, 403);
  });

  test("specific roles: only members of the picked usergroups pass", async () => {
    await setCreateMode(srvOpen, "roles", [inviteGroup]);
    assert.equal((await createInvite(srvOpen, roleMemberToken)).statusCode, 200);
    assert.equal((await createInvite(srvOpen, plainMemberToken)).statusCode, 403);
    // Staff always pass regardless of mode.
    assert.equal((await createInvite(srvOpen, inviteModToken)).statusCode, 200);
    // 'roles' with NO groups picked admits nobody but staff.
    await setCreateMode(srvOpen, "roles", []);
    assert.equal((await createInvite(srvOpen, roleMemberToken)).statusCode, 403);
  });

  test("a minor member of an 18+ community can't mint invites even under 'all'", async () => {
    // An isNsfw flip KEEPS minor members' rows (keep-but-hide), so the
    // create gate must compose canParticipate, not just isMember.
    const s = await mkServer({ name: "Adult All Keep", isNsfw: true, inviteCreateMode: "all" });
    await db.insert(schema.serverMembers).values({ serverId: s, userId: minor.id, role: "member" });
    assert.equal((await createInvite(s, minorToken)).statusCode, 403);
    const mine = await app.inject({ method: "GET", url: `/servers/${s}/invites/mine`, headers: auth(minorToken) });
    assert.equal((mine.json() as { canCreate: boolean }).canCreate, false);
  });

  test("tightening the policy keeps a member's own live invites visible and revocable", async () => {
    const s = await mkServer({ name: "Tighten Keep", inviteCreateMode: "all" });
    const u = await createUser(db, { birthdate: ADULT_DOB });
    const tok = await tokenFor(db, u.id);
    await db.insert(schema.serverMembers).values({ serverId: s, userId: u.id, role: "member" });
    const code = ((await createInvite(s, tok)).json() as { invite: { code: string } }).invite.code;
    await setCreateMode(s, "staff");
    const mine = await app.inject({ method: "GET", url: `/servers/${s}/invites/mine`, headers: auth(tok) });
    const j = mine.json() as { canCreate: boolean; invites: Array<{ code: string }> };
    assert.equal(j.canCreate, false);
    assert.ok(j.invites.some((i) => i.code === code), "own live invites stay listed under a tightened policy");
    const del = await app.inject({ method: "DELETE", url: `/servers/${s}/invites/${code}`, headers: auth(tok) });
    assert.equal(del.statusCode, 200, del.body);
  });

  test("spent invites drop out of /mine and the console list (liveness matches the cap)", async () => {
    const s = await mkServer({ name: "Spent Keep", inviteCreateMode: "all" });
    const u = await createUser(db, { birthdate: ADULT_DOB });
    const tok = await tokenFor(db, u.id);
    await db.insert(schema.serverMembers).values({ serverId: s, userId: u.id, role: "member" });
    const spent = await mint(s, { createdBy: u.id, maxUses: 2, usedCount: 2 });
    const live = await mint(s, { createdBy: u.id });
    const mine = (await app.inject({ method: "GET", url: `/servers/${s}/invites/mine`, headers: auth(tok) }))
      .json() as { invites: Array<{ code: string }> };
    assert.ok(mine.invites.some((i) => i.code === live));
    assert.ok(!mine.invites.some((i) => i.code === spent), "spent invite is not listed in /mine");
    const list = (await app.inject({ method: "GET", url: `/servers/${s}/invites`, headers: auth(ownerToken) }))
      .json() as { invites: Array<{ code: string }> };
    assert.ok(!list.invites.some((i) => i.code === spent), "spent invite is not in the console list");
  });

  test("non-staff creators hit the active-invite cap; revoking frees a slot", async () => {
    const capServer = await mkServer({ name: "Cap Keep", inviteCreateMode: "all" });
    const capUser = await createUser(db, { birthdate: ADULT_DOB });
    const capToken = await tokenFor(db, capUser.id);
    await db.insert(schema.serverMembers).values({ serverId: capServer, userId: capUser.id, role: "member" });
    const codes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await createInvite(capServer, capToken);
      assert.equal(res.statusCode, 200, res.body);
      codes.push((res.json() as { invite: { code: string } }).invite.code);
    }
    const over = await createInvite(capServer, capToken);
    assert.equal(over.statusCode, 409);
    // Revoke one of their own → room again.
    const del = await app.inject({ method: "DELETE", url: `/servers/${capServer}/invites/${codes[0]}`, headers: auth(capToken) });
    assert.equal(del.statusCode, 200, del.body);
    assert.equal((await createInvite(capServer, capToken)).statusCode, 200);
  });

  test("members revoke only their own; staff revoke anyone's; both are audited", async () => {
    await setCreateMode(srvOpen, "all");
    const mine = (await createInvite(srvOpen, plainMemberToken)).json() as { invite: { code: string } };
    const theirs = (await createInvite(srvOpen, roleMemberToken)).json() as { invite: { code: string } };
    // Not yours → 403.
    const denied = await app.inject({ method: "DELETE", url: `/servers/${srvOpen}/invites/${theirs.invite.code}`, headers: auth(plainMemberToken) });
    assert.equal(denied.statusCode, 403);
    // Your own → ok.
    const own = await app.inject({ method: "DELETE", url: `/servers/${srvOpen}/invites/${mine.invite.code}`, headers: auth(plainMemberToken) });
    assert.equal(own.statusCode, 200, own.body);
    // Staff revoke anyone's.
    const staffDel = await app.inject({ method: "DELETE", url: `/servers/${srvOpen}/invites/${theirs.invite.code}`, headers: auth(inviteModToken) });
    assert.equal(staffDel.statusCode, 200, staffDel.body);
    // Audit rows for create + revoke landed in the per-server log.
    const entries = await db.select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.serverId, srvOpen), eq(schema.auditLog.action, "server_invite_create")));
    assert.ok(entries.length >= 2, "member-created invites are audited");
    const revokes = await db.select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.serverId, srvOpen), eq(schema.auditLog.action, "server_invite_revoke")));
    assert.ok(revokes.length >= 2, "revocations are audited");
  });

  test("the console list stays staff-gated and carries creator attribution; /mine reflects the policy", async () => {
    await setCreateMode(srvOpen, "all");
    await createInvite(srvOpen, roleMemberToken);
    // Full list: members are refused, staff see creator names.
    assert.equal((await app.inject({ method: "GET", url: `/servers/${srvOpen}/invites`, headers: auth(plainMemberToken) })).statusCode, 403);
    const staffList = await app.inject({ method: "GET", url: `/servers/${srvOpen}/invites`, headers: auth(inviteModToken) });
    assert.equal(staffList.statusCode, 200, staffList.body);
    const rows = (staffList.json() as { invites: Array<{ createdByUsername: string | null; link: string | null }> }).invites;
    assert.ok(rows.some((r) => r.createdByUsername === roleMember.username));
    // Shareable link is the FULL public /i/<code> URL.
    assert.ok(rows.every((r) => r.link === null || /\/i\/[A-Za-z0-9_-]+$/.test(r.link)));
    // /mine: canCreate mirrors the policy per caller.
    const mineOk = await app.inject({ method: "GET", url: `/servers/${srvOpen}/invites/mine`, headers: auth(plainMemberToken) });
    assert.equal((mineOk.json() as { canCreate: boolean }).canCreate, true);
    await setCreateMode(srvOpen, "staff");
    const mineNo = await app.inject({ method: "GET", url: `/servers/${srvOpen}/invites/mine`, headers: auth(plainMemberToken) });
    assert.equal((mineNo.json() as { canCreate: boolean }).canCreate, false);
  });
});

/* =========================================================================
 * Invites die with the membership
 * ======================================================================= */

describe("invites die with the membership", () => {
  test("leaving a server revokes the leaver's live invites", async () => {
    const s = await mkServer({ name: "Leave Keep", inviteCreateMode: "all" });
    const u = await createUser(db, { birthdate: ADULT_DOB });
    const tok = await tokenFor(db, u.id);
    await db.insert(schema.serverMembers).values({ serverId: s, userId: u.id, role: "member" });
    const code = (await createInvite(s, tok)).json() as { invite: { code: string } };
    const res = await app.inject({ method: "POST", url: `/servers/${s}/leave`, headers: auth(tok) });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok((await inviteRow(code.invite.code))!.revokedAt, "leaver's invite is revoked");
  });

  test("console member removal revokes their live invites", async () => {
    const s = await mkServer({ name: "Remove Keep", inviteCreateMode: "all" });
    const u = await createUser(db, { birthdate: ADULT_DOB });
    const tok = await tokenFor(db, u.id);
    await db.insert(schema.serverMembers).values({ serverId: s, userId: u.id, role: "member" });
    const code = (await createInvite(s, tok)).json() as { invite: { code: string } };
    const res = await app.inject({ method: "DELETE", url: `/servers/${s}/members/${u.id}`, headers: auth(ownerToken) });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok((await inviteRow(code.invite.code))!.revokedAt, "removed member's invite is revoked");
  });

  test("a server ban revokes the banned member's live invites", async () => {
    const s = await mkServer({ name: "Ban Keep", inviteCreateMode: "all" });
    const u = await createUser(db, { birthdate: ADULT_DOB });
    const tok = await tokenFor(db, u.id);
    await db.insert(schema.serverMembers).values({ serverId: s, userId: u.id, role: "member" });
    const code = (await createInvite(s, tok)).json() as { invite: { code: string } };
    const res = await app.inject({
      method: "PUT",
      url: `/servers/${s}/bans`,
      headers: { ...auth(ownerToken), "content-type": "application/json" },
      payload: JSON.stringify({ target: `@id:${u.id}` }),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok((await inviteRow(code.invite.code))!.revokedAt, "banned member's invite is revoked");
  });
});

/* =========================================================================
 * Registration carry-through (/auth/register inviteCode)
 * ======================================================================= */

describe("registration carry-through", () => {
  test("a valid invite auto-joins the community, keeps default membership, and stamps the first landing", async () => {
    const code = await mint(srvOpen, { maxUses: 3 });
    const j = await register("Invited_One", { inviteCode: code });
    // Member of the invited server AND still enrolled in the default server.
    assert.equal(await isMember(srvOpen, j.id), true);
    assert.equal(await isMember(SYSTEM_SERVER_ID, j.id), true);
    // One use consumed; first-landing stamp set.
    assert.equal((await inviteRow(code))!.usedCount, 1);
    const row = (await db.select({ invited: schema.users.invitedServerId }).from(schema.users)
      .where(eq(schema.users.id, j.id)))[0];
    assert.equal(row?.invited, srvOpen);

    // First socket landing consumes the stamp: the invited server's landing
    // room wins, and the stamp clears (strictly one-shot).
    const landing = await consumeInvitedLanding(db, { id: j.id, role: "user", isAdult: true });
    assert.ok(landing, "invited landing resolves");
    assert.equal(landing!.roomId, srvOpenLandingRoom);
    assert.equal(landing!.serverId, srvOpen);
    const cleared = (await db.select({ invited: schema.users.invitedServerId }).from(schema.users)
      .where(eq(schema.users.id, j.id)))[0];
    assert.equal(cleared?.invited, null);
    assert.equal(await consumeInvitedLanding(db, { id: j.id, role: "user", isAdult: true }), null);

    // The one-time greeter fires in THAT room (persisted targeted line).
    let emitted = 0;
    await greetNewcomerOnce(db, { emit: () => { emitted++; } }, { id: j.id, username: "Invited_One" }, { id: srvOpenLandingRoom, name: "Open_Hall" });
    assert.equal(emitted, 1);
    const greet = (await db.select().from(schema.messages)
      .where(and(eq(schema.messages.roomId, srvOpenLandingRoom), eq(schema.messages.targetUserId, j.id))))[0];
    assert.ok(greet, "greeter persisted in the invited landing room");
    // And never again.
    await greetNewcomerOnce(db, { emit: () => { emitted++; } }, { id: j.id, username: "Invited_One" }, { id: srvOpenLandingRoom, name: "Open_Hall" });
    assert.equal(emitted, 1);
  });

  test("an invalid code is a normal signup: default landing, no membership, no stamp", async () => {
    const j = await register("Invited_Two", { inviteCode: "definitely_not_a_code" });
    assert.equal(await isMember(srvOpen, j.id), false);
    assert.equal(await isMember(SYSTEM_SERVER_ID, j.id), true);
    const row = (await db.select({ invited: schema.users.invitedServerId }).from(schema.users)
      .where(eq(schema.users.id, j.id)))[0];
    assert.equal(row?.invited, null);
  });

  test("a minor registering through an 18+ invite is NOT joined (signup still succeeds)", async () => {
    const code = await mint(srvNsfw);
    const j = await register("Minor_Invited", { birthdate: MINOR_DOB, inviteCode: code });
    assert.equal(await isMember(srvNsfw, j.id), false);
    assert.equal((await inviteRow(code))!.usedCount, 0, "no use consumed on refusal");
    const row = (await db.select({ invited: schema.users.invitedServerId }).from(schema.users)
      .where(eq(schema.users.id, j.id)))[0];
    assert.equal(row?.invited, null);
    // Still a default-server member — the global onboarding path is untouched.
    assert.equal(await isMember(SYSTEM_SERVER_ID, j.id), true);
  });

  test("an application-mode invite never auto-joins at signup (review preserved)", async () => {
    const code = await mint(srvApp);
    const j = await register("Applicant_Invited", { inviteCode: code });
    assert.equal(await isMember(srvApp, j.id), false);
    assert.equal((await inviteRow(code))!.usedCount, 0);
  });

  test("the Google finish path's carry-through call joins adults and refuses minors", async () => {
    // /auth/google/finish invokes redeemInviteForSignup with exactly this
    // caller shape (id/role + isAdult derived from the finish form's DOB).
    const code = await mint(srvOpen, { maxUses: 5 });
    const adult = await createUser(db, { birthdate: ADULT_DOB });
    const joined = await redeemInviteForSignup(db, { id: adult.id, role: "user", isAdult: true }, code);
    assert.equal(joined.joined, true);
    assert.equal(joined.serverId, srvOpen);
    assert.equal(await isMember(srvOpen, adult.id), true);
    assert.equal((await inviteRow(code))!.usedCount, 1);

    const nsfwCode = await mint(srvNsfw);
    const kid = await createUser(db, { birthdate: MINOR_DOB });
    const refused = await redeemInviteForSignup(db, { id: kid.id, role: "user", isAdult: false }, nsfwCode);
    assert.equal(refused.joined, false);
    assert.equal(await isMember(srvNsfw, kid.id), false);
    assert.equal((await inviteRow(nsfwCode))!.usedCount, 0, "no use consumed on the minor refusal");
  });

  test("single-use consumption holds across signups", async () => {
    const code = await mint(srvOpen, { maxUses: 1 });
    const first = await register("Single_Use_A", { inviteCode: code });
    assert.equal(await isMember(srvOpen, first.id), true);
    assert.equal((await inviteRow(code))!.usedCount, 1);
    const second = await register("Single_Use_B", { inviteCode: code });
    assert.equal(await isMember(srvOpen, second.id), false, "spent code doesn't join the next signup");
    assert.equal((await inviteRow(code))!.usedCount, 1);
  });
});
