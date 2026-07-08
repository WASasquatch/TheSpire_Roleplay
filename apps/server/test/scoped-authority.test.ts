import "./helpers/env.js";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  FORUM_FEATURE_PERMISSIONS,
  FORUM_PERMISSIONS,
  SERVER_ADMIN_DEFAULT_PERMISSIONS,
  SERVER_FEATURE_PERMISSIONS,
  SERVER_PERMISSIONS,
  parseForumPermissions,
  parseServerFeaturePermissions,
  parseServerModPermissions,
  type ForumPermission,
  type ServerPermission,
} from "@thekeep/shared";
import { makeTestDb } from "./helpers/harness.js";
import { invalidatePermissionsCache } from "../src/auth/permissions.js";
import { isServerModerationActive } from "../src/servers/moderation.js";
import {
  resolveActiveScopedBan,
  resolveScopedAuthority,
  resolveScopedUsergroupPerms,
  scopedCan,
  type Caller,
  type ScopedUsergroup,
  type ScopeAuthorityConfig,
} from "../src/auth/scopedAuthority.js";
import type { Db } from "../src/db/index.js";

/**
 * Characterization test for the scope-parameterized authority scaffold
 * (`apps/server/src/auth/scopedAuthority.ts`), extracted from the two
 * near-identical inline resolvers in `forums/authority.ts` (`forumAuthority`)
 * and `servers/authority.ts` (`serverAuthority`).
 *
 * The generic core is shared; the two public resolvers stay as thin wrappers
 * that inject their tables + these knobs (plan.md F1 "options matrix"):
 *   - manageAnyPermission   manage_any_forum   vs manage_any_server
 *   - allPermissions        FORUM_PERMISSIONS  vs SERVER_PERMISSIONS
 *   - isModForRole          mod                vs admin|mod  (server admin tier)
 *   - directGrantForRole    mod grant          vs admin defaults / mod grant
 *   - isOpen                postingMode        vs joinMode
 *   - moderationActive      () => false        vs isServerModerationActive
 *   - usergroupParse        parseForumPerms    vs parseServerFeaturePerms
 *   - usergroupFallback     FORUM_FEATURE_*    vs SERVER_FEATURE_*
 *
 * `db` here is only used by `hasPermission` (the site-staff override); every
 * scope/member/ban/usergroup read is injected as a fake callback so scenarios
 * are exact. The migrated grants seed `manage_any_forum`/`manage_any_server`
 * for the `admin` role only, so an `admin` caller exercises the staff-override
 * (owner-equivalent) branch and a `user` caller does not.
 */

let db: Db;
const OWNER = "owner-1";
const OTHER = "user-2";
const userCaller = (id = OTHER): Caller => ({ id, role: "user" });
const adminCaller = (id = "site-admin"): Caller => ({ id, role: "admin" });

before(() => {
  invalidatePermissionsCache();
  db = makeTestDb().db;
});
after(() => invalidatePermissionsCache());

// ── Fake scope data ─────────────────────────────────────────────────────────
interface ForumScope {
  ownerUserId: string | null;
  isSystem: boolean | null;
  postingMode: string;
}
interface ServerScope {
  ownerUserId: string | null;
  isSystem: boolean | null;
  joinMode: string;
  moderationState: string;
  moderationUntil: Date | null;
}
interface Scenario<Role extends string> {
  scope?: object;
  member?: { role: Role | null; permissionsJson: string | null };
  ban?: { until: Date | null; reason: string | null };
  groups?: ScopedUsergroup[];
  memberGroupIds?: string[];
}

function forumConfig(s: Scenario<"owner" | "mod" | "member">): ScopeAuthorityConfig<ForumScope, "owner" | "mod" | "member", ForumPermission> {
  return {
    manageAnyPermission: "manage_any_forum",
    allPermissions: FORUM_PERMISSIONS,
    isModForRole: (role) => role === "mod",
    directGrantForRole: (role, permissionsJson) => (role === "mod" ? parseForumPermissions(permissionsJson) : []),
    isOpen: (forum) => forum.postingMode === "open",
    moderationActive: () => false,
    fetchScope: async () => s.scope as ForumScope | undefined,
    fetchMember: async () => s.member,
    fetchBan: async () => s.ban,
    fetchGroups: async () => s.groups ?? [],
    fetchMemberGroupIds: async () => s.memberGroupIds ?? [],
    usergroupParse: parseForumPermissions,
    usergroupFallback: FORUM_FEATURE_PERMISSIONS,
  };
}

function serverConfig(s: Scenario<"owner" | "admin" | "mod" | "member">): ScopeAuthorityConfig<ServerScope, "owner" | "admin" | "mod" | "member", ServerPermission> {
  return {
    manageAnyPermission: "manage_any_server",
    allPermissions: SERVER_PERMISSIONS,
    isModForRole: (role) => role === "admin" || role === "mod",
    directGrantForRole: (role, permissionsJson) =>
      role === "admin"
        ? [...SERVER_ADMIN_DEFAULT_PERMISSIONS]
        : role === "mod"
          ? parseServerModPermissions(permissionsJson)
          : [],
    isOpen: (server) => server.joinMode === "open",
    moderationActive: (server) => isServerModerationActive(server as never),
    fetchScope: async () => s.scope as ServerScope | undefined,
    fetchMember: async () => s.member,
    fetchBan: async () => s.ban,
    fetchGroups: async () => s.groups ?? [],
    fetchMemberGroupIds: async () => s.memberGroupIds ?? [],
    usergroupParse: parseServerFeaturePermissions,
    usergroupFallback: SERVER_FEATURE_PERMISSIONS,
  };
}

const openForum: ForumScope = { ownerUserId: OWNER, isSystem: false, postingMode: "open" };
const appForum: ForumScope = { ownerUserId: OWNER, isSystem: false, postingMode: "application" };
const openServer: ServerScope = { ownerUserId: OWNER, isSystem: false, joinMode: "open", moderationState: "none", moderationUntil: null };
const appServer: ServerScope = { ownerUserId: OWNER, isSystem: false, joinMode: "application", moderationState: "none", moderationUntil: null };

// ── Pure helpers ─────────────────────────────────────────────────────────────
describe("scopedCan — owner-implies-all", () => {
  test("owner holds every key regardless of the permissions array", () => {
    assert.equal(scopedCan({ isOwner: true, permissions: [] }, "x"), true);
  });
  test("non-owner holds only listed keys", () => {
    assert.equal(scopedCan({ isOwner: false, permissions: ["a", "b"] }, "a"), true);
    assert.equal(scopedCan({ isOwner: false, permissions: ["a", "b"] }, "c"), false);
  });
});

describe("resolveActiveScopedBan — lazy expiry", () => {
  test("missing row = no ban", () => assert.equal(resolveActiveScopedBan(undefined), null));
  test("permanent ban (until null) is active", () =>
    assert.deepEqual(resolveActiveScopedBan({ until: null, reason: "r" }), { until: null, reason: "r" }));
  test("future until is active", () => {
    const until = new Date(Date.now() + 60_000);
    assert.deepEqual(resolveActiveScopedBan({ until, reason: null }), { until, reason: null });
  });
  test("expired until reads as absent", () =>
    assert.equal(resolveActiveScopedBan({ until: new Date(Date.now() - 60_000), reason: "old" }), null));
});

describe("resolveScopedUsergroupPerms — union algorithm + injected parse/fallback", () => {
  test("anonymous → no perms", async () => {
    assert.deepEqual(
      await resolveScopedUsergroupPerms<ForumPermission>({
        userId: null, fetchGroups: async () => [], fetchMemberGroupIds: async () => [],
        parse: parseForumPermissions, fallback: FORUM_FEATURE_PERMISSIONS,
      }),
      [],
    );
  });
  test("no groups defined → full fallback feature-set (forum vs server differ)", async () => {
    const noGroups = { fetchGroups: async () => [] as ScopedUsergroup[], fetchMemberGroupIds: async () => [] };
    assert.deepEqual(
      await resolveScopedUsergroupPerms<ForumPermission>({ userId: OTHER, ...noGroups, parse: parseForumPermissions, fallback: FORUM_FEATURE_PERMISSIONS }),
      [...FORUM_FEATURE_PERMISSIONS],
    );
    assert.deepEqual(
      await resolveScopedUsergroupPerms<ServerPermission>({ userId: OTHER, ...noGroups, parse: parseServerFeaturePermissions, fallback: SERVER_FEATURE_PERMISSIONS }),
      [...SERVER_FEATURE_PERMISSIONS],
    );
  });
  test("default-group baseline UNION explicit non-default groups, order-preserving", async () => {
    const feat0 = FORUM_FEATURE_PERMISSIONS[0];
    const feat1 = FORUM_FEATURE_PERMISSIONS[1];
    const groups: ScopedUsergroup[] = [
      { id: "g-def", permissionsJson: JSON.stringify([feat0]), isDefault: true },
      { id: "g-a", permissionsJson: JSON.stringify([feat1]), isDefault: false },
      { id: "g-b", permissionsJson: JSON.stringify([feat0, feat1]), isDefault: false },
    ];
    // Member of g-a only → default (feat0) + g-a (feat1).
    const perms = await resolveScopedUsergroupPerms<ForumPermission>({
      userId: OTHER, fetchGroups: async () => groups, fetchMemberGroupIds: async () => ["g-a"],
      parse: parseForumPermissions, fallback: FORUM_FEATURE_PERMISSIONS,
    });
    assert.deepEqual(perms, [feat0, feat1]);
  });
  test("no default group → fallback baseline, then explicit groups added", async () => {
    const feat1 = FORUM_FEATURE_PERMISSIONS[1];
    const perms = await resolveScopedUsergroupPerms<ForumPermission>({
      userId: OTHER,
      fetchGroups: async () => [{ id: "g-a", permissionsJson: JSON.stringify([feat1]), isDefault: false }],
      fetchMemberGroupIds: async () => ["g-a"],
      parse: parseForumPermissions, fallback: FORUM_FEATURE_PERMISSIONS,
    });
    // Baseline = full fallback (deduped), feat1 already present → unchanged set.
    assert.deepEqual(perms, [...FORUM_FEATURE_PERMISSIONS]);
  });
});

// ── Full resolver: shared core + injected knobs ──────────────────────────────
describe("resolveScopedAuthority — sentinels", () => {
  test("missing scope → NONE (no scope object)", async () => {
    const a = await resolveScopedAuthority(db, userCaller(), forumConfig({ scope: undefined }));
    assert.deepEqual(a, { scope: null, role: null, isOwner: false, isMod: false, isMember: false, permissions: [], ban: null, canParticipate: false });
  });
  test("anonymous caller → NONE fields but scope attached", async () => {
    const a = await resolveScopedAuthority(db, null, forumConfig({ scope: openForum }));
    assert.equal(a.scope, openForum);
    assert.equal(a.canParticipate, false);
    assert.equal(a.isOwner, false);
    assert.deepEqual(a.permissions, []);
  });
});

describe("resolveScopedAuthority — owner / staff-override branch", () => {
  test("relational owner holds the FULL registry (forum vs server differ)", async () => {
    const f = await resolveScopedAuthority(db, userCaller(OWNER), forumConfig({ scope: openForum }));
    assert.equal(f.isOwner, true);
    assert.equal(f.isMod, true);
    assert.deepEqual(f.permissions, [...FORUM_PERMISSIONS]);
    assert.equal(f.canParticipate, true);
    const s = await resolveScopedAuthority(db, userCaller(OWNER), serverConfig({ scope: openServer }));
    assert.deepEqual(s.permissions, [...SERVER_PERMISSIONS]);
  });
  test("site admin (manage_any_*) resolves owner-equivalent on a scope it doesn't own", async () => {
    const f = await resolveScopedAuthority(db, adminCaller(), forumConfig({ scope: appForum }));
    assert.equal(f.isOwner, true);
    assert.deepEqual(f.permissions, [...FORUM_PERMISSIONS]);
    const s = await resolveScopedAuthority(db, adminCaller(), serverConfig({ scope: appServer }));
    assert.equal(s.isOwner, true);
    assert.deepEqual(s.permissions, [...SERVER_PERMISSIONS]);
  });
  test("plain user is NOT staff-overridden", async () => {
    const f = await resolveScopedAuthority(db, userCaller(), forumConfig({ scope: appForum }));
    assert.equal(f.isOwner, false);
  });
  test("owner banned in their own scope still participates (ban is a data bug)", async () => {
    const a = await resolveScopedAuthority(db, userCaller(OWNER), forumConfig({ scope: appForum, ban: { until: null, reason: "x" } }));
    assert.equal(a.isOwner, true);
    assert.equal(a.canParticipate, true);
    assert.deepEqual(a.ban, { until: null, reason: "x" });
  });
});

describe("resolveScopedAuthority — mod-tier divergence (server adds admin)", () => {
  test("forum: only role 'mod' is a mod; direct grant parsed from member perms", async () => {
    const grant = JSON.stringify([FORUM_PERMISSIONS[0]]);
    const a = await resolveScopedAuthority(db, userCaller(), forumConfig({ scope: openForum, member: { role: "mod", permissionsJson: grant } }));
    assert.equal(a.isMod, true);
    assert.equal(a.isOwner, false);
    assert.ok(a.permissions.includes(FORUM_PERMISSIONS[0]));
    // member baseline (no groups) folds in the fallback feature-set too.
    for (const p of FORUM_FEATURE_PERMISSIONS) assert.ok(a.permissions.includes(p));
  });
  test("server: role 'admin' is a mod holding the lieutenant default set (NOT manage_appearance)", async () => {
    const a = await resolveScopedAuthority(db, userCaller(), serverConfig({ scope: openServer, member: { role: "admin", permissionsJson: null } }));
    assert.equal(a.isMod, true);
    assert.equal(a.isOwner, false);
    for (const p of SERVER_ADMIN_DEFAULT_PERMISSIONS) assert.ok(a.permissions.includes(p));
    assert.equal(a.permissions.includes("manage_appearance"), SERVER_ADMIN_DEFAULT_PERMISSIONS.includes("manage_appearance" as never));
  });
  test("server: role 'mod' holds only the owner-granted subset (not the admin defaults)", async () => {
    const grant = JSON.stringify([SERVER_PERMISSIONS.find((p) => p !== "manage_appearance")]);
    const a = await resolveScopedAuthority(db, userCaller(), serverConfig({ scope: openServer, member: { role: "mod", permissionsJson: grant } }));
    assert.equal(a.isMod, true);
    assert.deepEqual(new Set(parseServerModPermissions(grant)).size > 0, true);
    for (const p of parseServerModPermissions(grant)) assert.ok(a.permissions.includes(p));
  });
  test("plain member is not a mod but holds usergroup feature perms", async () => {
    const a = await resolveScopedAuthority(db, userCaller(), serverConfig({ scope: openServer, member: { role: "member", permissionsJson: null } }));
    assert.equal(a.isMod, false);
    assert.equal(a.isMember, true);
    assert.deepEqual(a.permissions, [...SERVER_FEATURE_PERMISSIONS]);
  });
});

describe("resolveScopedAuthority — isMember / system scope", () => {
  test("system scope makes any signed-in user an implicit member", async () => {
    const a = await resolveScopedAuthority(db, userCaller(), forumConfig({ scope: { ownerUserId: OWNER, isSystem: true, postingMode: "application" } }));
    assert.equal(a.isMember, true);
    assert.equal(a.canParticipate, true); // members-only forum, but system ⇒ member
  });
  test("non-member on application scope is not a member", async () => {
    const a = await resolveScopedAuthority(db, userCaller(), forumConfig({ scope: appForum }));
    assert.equal(a.isMember, false);
    assert.equal(a.canParticipate, false);
  });
});

describe("resolveScopedAuthority — canParticipate matrix", () => {
  test("open scope: any signed-in non-banned user participates", async () => {
    assert.equal((await resolveScopedAuthority(db, userCaller(), forumConfig({ scope: openForum }))).canParticipate, true);
    assert.equal((await resolveScopedAuthority(db, userCaller(), serverConfig({ scope: openServer }))).canParticipate, true);
  });
  test("open scope + active ban: blocked", async () => {
    const a = await resolveScopedAuthority(db, userCaller(), forumConfig({ scope: openForum, ban: { until: null, reason: null } }));
    assert.equal(a.canParticipate, false);
  });
  test("open scope + EXPIRED ban: participates (lazy expiry)", async () => {
    const a = await resolveScopedAuthority(db, userCaller(), forumConfig({ scope: openForum, ban: { until: new Date(Date.now() - 1000), reason: null } }));
    assert.equal(a.ban, null);
    assert.equal(a.canParticipate, true);
  });
  test("application scope: member participates, non-member does not", async () => {
    assert.equal((await resolveScopedAuthority(db, userCaller(), serverConfig({ scope: appServer, member: { role: "member", permissionsJson: null } }))).canParticipate, true);
    assert.equal((await resolveScopedAuthority(db, userCaller(), serverConfig({ scope: appServer }))).canParticipate, false);
  });
});

describe("resolveScopedAuthority — server-only moderation gate (forum knob is a no-op)", () => {
  const modServer: ServerScope = { ownerUserId: OWNER, isSystem: false, joinMode: "open", moderationState: "suspended", moderationUntil: null };
  test("moderated server blocks a plain member (non-mod)", async () => {
    const a = await resolveScopedAuthority(db, userCaller(), serverConfig({ scope: modServer, member: { role: "member", permissionsJson: null } }));
    assert.equal(a.isMod, false);
    assert.equal(a.canParticipate, false); // (isMod||!moderationActive) is false
  });
  test("moderated server still admits a server mod/admin so they can fix it", async () => {
    const a = await resolveScopedAuthority(db, userCaller(), serverConfig({ scope: modServer, member: { role: "admin", permissionsJson: null } }));
    assert.equal(a.isMod, true);
    assert.equal(a.canParticipate, true);
  });
  test("moderated server admits the owner", async () => {
    const a = await resolveScopedAuthority(db, userCaller(OWNER), serverConfig({ scope: modServer }));
    assert.equal(a.canParticipate, true);
  });
  test("EXPIRED banned-state server behaves like 'none' (lazy expiry) → member participates", async () => {
    const expired: ServerScope = { ownerUserId: OWNER, isSystem: false, joinMode: "open", moderationState: "banned", moderationUntil: new Date(Date.now() - 1000) };
    const a = await resolveScopedAuthority(db, userCaller(), serverConfig({ scope: expired, member: { role: "member", permissionsJson: null } }));
    assert.equal(a.canParticipate, true);
  });
  test("forum moderationActive knob is always false → moderation never blocks a forum member", async () => {
    // A forum member on an application forum participates; there is no moderation gate.
    const a = await resolveScopedAuthority(db, userCaller(), forumConfig({ scope: appForum, member: { role: "member", permissionsJson: null } }));
    assert.equal(a.canParticipate, true);
  });
});
