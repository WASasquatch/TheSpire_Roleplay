/**
 * scopedAuthority — the shared, scope-parameterized SCAFFOLD behind
 * {@link module:forums/authority.forumAuthority} and
 * {@link module:servers/authority.serverAuthority}.
 *
 * Forums and servers resolve "what may this user do here" with near-identical
 * machinery: load the scope row, resolve the caller's relational role + a
 * lazily-expiring ban, fold site-staff override into `isOwner`, derive the
 * effective granular-permission set (owner ⇒ everything; everyone else = the
 * union of a role-tier direct grant + usergroup perms), and compute
 * `canParticipate`. Only a handful of knobs differ between the two surfaces
 * (parse-fn, fallback feature-set, the extra server `admin` lieutenant tier,
 * and the server-only moderation gate), so the generic core lives here and the
 * two public resolvers stay as thin, intentionally-separate wrappers that just
 * feed in their tables + knobs and rename `scope` → `forum`/`server`.
 *
 * This module changes NO authority decision: with a forum's knobs it is
 * byte-identical to the old inline forum resolver, and with a server's knobs
 * byte-identical to the old inline server resolver (the unified `canParticipate`
 * formula collapses to the forum formula whenever `moderationActive` is false,
 * which is always the case for forums).
 */
import type { PermissionKey, Role } from "@thekeep/shared";
import { hasPermission } from "./permissions.js";
import type { Db } from "../db/index.js";

export type Caller = { id: string; role: Role };

/** Minimal shape every scope row (forum/server) shares that the core reads. */
export interface ScopedRowBase {
  ownerUserId: string | null;
  isSystem: boolean | null;
}

/** Normalized ban shape after lazy-expiry resolution. `until` null = permanent. */
export interface ScopedBan {
  until: Date | null;
  reason: string | null;
}

/** The generic authority core the wrappers re-shape (`scope` → `forum`/`server`). */
export interface ScopedAuthorityCore<Row, RoleName extends string, Perm extends string> {
  scope: Row | null;
  role: RoleName | null;
  isOwner: boolean;
  isMod: boolean;
  isMember: boolean;
  permissions: Perm[];
  ban: ScopedBan | null;
  canParticipate: boolean;
}

/** Owner/staff implicitly hold every key. The single owner-implies-all check
 *  both `forumCan` and `serverCan` delegate to so that rule lives in one place. */
export function scopedCan<Perm extends string>(
  a: { isOwner: boolean; permissions: Perm[] },
  key: Perm,
): boolean {
  return a.isOwner || a.permissions.includes(key);
}

/**
 * Lazy ban-expiry: a ban row whose `until` is in the past (or a missing row)
 * reads as "no active ban". Expired rows are lazily ignored, never deleted, so
 * the owner's Bans tab can still show history until lifted.
 */
export function resolveActiveScopedBan(
  banRow: { until: Date | null; reason: string | null } | null | undefined,
): ScopedBan | null {
  const active = banRow && (!banRow.until || +banRow.until > Date.now());
  return active ? { until: banRow!.until ?? null, reason: banRow!.reason ?? null } : null;
}

/** A usergroup row as the core needs to see it. */
export interface ScopedUsergroup {
  id: string;
  permissionsJson: string | null;
  isDefault: boolean | null;
}

/**
 * Resolve a member's usergroup-derived permissions: the default group's
 * baseline (every participant) UNION every non-default group the user is an
 * explicit member of. When the scope has defined NO groups at all, the baseline
 * is the full feature set so behavior is unchanged. `userId` null = anonymous →
 * no perms. Parsing + fallback feature-set are injected because forums parse the
 * whole registry while servers parse feature-only perms.
 */
export async function resolveScopedUsergroupPerms<Perm extends string>(opts: {
  userId: string | null;
  fetchGroups: () => Promise<ScopedUsergroup[]>;
  fetchMemberGroupIds: (nonDefaultIds: string[]) => Promise<string[]>;
  parse: (json: string | null | undefined) => Perm[];
  fallback: readonly Perm[];
}): Promise<Perm[]> {
  const { userId, fetchGroups, fetchMemberGroupIds, parse, fallback } = opts;
  if (!userId) return [];
  const groups = await fetchGroups();
  if (!groups.length) return [...fallback];
  const defaultGroup = groups.find((g) => g.isDefault);
  const out = new Set<Perm>(defaultGroup ? parse(defaultGroup.permissionsJson) : [...fallback]);
  const nonDefaultIds = groups.filter((g) => !g.isDefault).map((g) => g.id);
  if (nonDefaultIds.length) {
    const myIds = new Set(await fetchMemberGroupIds(nonDefaultIds));
    for (const g of groups) {
      if (!g.isDefault && myIds.has(g.id)) for (const p of parse(g.permissionsJson)) out.add(p);
    }
  }
  return [...out];
}

/** A member row as the core needs to see it (both scopes expose role + grant). */
export interface ScopedMember<RoleName extends string> {
  role: RoleName | null;
  permissionsJson: string | null;
}

/**
 * Everything a wrapper injects to specialize the generic resolver for its
 * scope. All DB access is injected as callbacks so the wrapper keeps its own
 * concrete drizzle queries (identical to before); the core only orchestrates.
 */
export interface ScopeAuthorityConfig<Row extends ScopedRowBase, RoleName extends string, Perm extends string> {
  /** Site-staff override permission (`manage_any_forum` / `manage_any_server`). */
  manageAnyPermission: PermissionKey;
  /** Full permission registry an owner/staff implicitly holds. */
  allPermissions: readonly Perm[];
  /** Extra mod tiers beyond owner (`role === "mod"`, plus servers add `admin`). */
  isModForRole: (role: RoleName | null) => boolean;
  /** Role-tier direct grant for a NON-owner (mod grant / server admin defaults). */
  directGrantForRole: (role: RoleName | null, permissionsJson: string | null) => Perm[];
  /** True when the scope admits any signed-in non-banned user (open posting/join). */
  isOpen: (scope: Row) => boolean;
  /** Server-only global-moderation gate; forums always pass `() => false`. */
  moderationActive: (scope: Row) => boolean;
  fetchScope: () => Promise<Row | undefined>;
  fetchMember: (userId: string) => Promise<ScopedMember<RoleName> | undefined>;
  fetchBan: (userId: string) => Promise<{ until: Date | null; reason: string | null } | undefined>;
  fetchGroups: (userId: string) => Promise<ScopedUsergroup[]>;
  fetchMemberGroupIds: (userId: string, nonDefaultIds: string[]) => Promise<string[]>;
  usergroupParse: (json: string | null | undefined) => Perm[];
  usergroupFallback: readonly Perm[];
}

/**
 * The generic authority resolver. Both `forumAuthority` and `serverAuthority`
 * are thin wrappers over this: they build a {@link ScopeAuthorityConfig} for
 * their tables/knobs, call this, then rename `scope` to their field name.
 */
export async function resolveScopedAuthority<Row extends ScopedRowBase, RoleName extends string, Perm extends string>(
  db: Db,
  user: Caller | null,
  config: ScopeAuthorityConfig<Row, RoleName, Perm>,
): Promise<ScopedAuthorityCore<Row, RoleName, Perm>> {
  const none: ScopedAuthorityCore<Row, RoleName, Perm> = {
    scope: null, role: null, isOwner: false, isMod: false,
    isMember: false, permissions: [], ban: null, canParticipate: false,
  };

  const scope = await config.fetchScope();
  if (!scope) return none;
  if (!user) return { ...none, scope };

  const member = await config.fetchMember(user.id);
  const role = (member?.role ?? null) as RoleName | null;

  const ban = resolveActiveScopedBan(await config.fetchBan(user.id));

  const staffOverride = await hasPermission(user, config.manageAnyPermission, db);
  const isOwner = staffOverride || scope.ownerUserId === user.id || role === ("owner" as RoleName);
  const isMod = isOwner || config.isModForRole(role);

  // Owner/staff implicitly hold EVERY permission. Everyone else: the union of
  // their role-tier direct grant + their usergroup perms (default-group baseline
  // + explicit groups). One unified registry.
  let permissions: Perm[];
  if (isOwner) {
    permissions = [...config.allPermissions];
  } else {
    const directGrant = config.directGrantForRole(role, member?.permissionsJson ?? null);
    const groupPerms = await resolveScopedUsergroupPerms<Perm>({
      userId: user.id,
      fetchGroups: () => config.fetchGroups(user.id),
      fetchMemberGroupIds: (ids) => config.fetchMemberGroupIds(user.id, ids),
      parse: config.usergroupParse,
      fallback: config.usergroupFallback,
    });
    permissions = [...new Set<Perm>([...directGrant, ...groupPerms])];
  }

  // The system scope (isSystem) is the site-wide DEFAULT: every signed-in user
  // is implicitly a member, so its members-only surfaces act as "signed-in
  // members only" (everyone but logged-out guests) WITHOUT a per-account row.
  // Anonymous callers already returned early, so this only elevates logged-in
  // users.
  const isMember = isMod || role === ("member" as RoleName) || scope.isSystem === true;

  // Owner/staff can always act (even on a scope they were oddly banned in — a
  // ban row against the owner is a data bug, not a lockout). Open scopes admit
  // any signed-in non-banned user; application/invite scopes require membership
  // (or a mod tier, folded into isMember above). A moderated scope additionally
  // blocks non-mod participants (owner/mods/staff pass so they can fix it). For
  // forums `moderationActive` is always false, so this collapses to the forum
  // formula exactly.
  const moderationActive = config.moderationActive(scope);
  const canParticipate =
    isOwner ||
    ((isMod || !moderationActive) && !ban && (config.isOpen(scope) || isMember));

  return { scope, role, isOwner, isMod, isMember, permissions, ban, canParticipate };
}
