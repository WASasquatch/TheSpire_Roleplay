/**
 * serverAuthority — the ONE resolver for "what may this user do in this
 * server". Every server-gated decision (rail join, room moderation, settings
 * management, membership review, bans) goes through here so the powers matrix
 * in plan.md §6.2 is enforced in exactly one place:
 *
 *   power                                   owner   admin   mod    member/visitor
 *   edit server appearance / theme / rules   ✅      ❌      ❌       ❌
 *   manage members / rooms / earning / etc.  ✅      ✅      ✅*      ❌
 *   sticky / lock / moderate room content    ✅      ✅      ✅*      ❌
 *   edit/delete others' messages             ✅      ✅      ✅*      ❌    (*never owner-authored content)
 *   assign admins / transfer / delete server ✅      ❌      ❌       ❌
 *   review membership applications           ✅      ✅      ✅*      ❌
 *     (*) admin = the lieutenant tier: implicitly holds every moderation key
 *         EXCEPT `manage_appearance` (SERVER_ADMIN_DEFAULT_PERMISSIONS).
 *         A plain mod holds only the granular subset the owner granted in
 *         `server_members.permissions_json`.
 *
 * Servers add the `admin` tier ABOVE `mod` that forums lack: an admin runs the
 * community day-to-day (members, rooms, usergroups, earning, announcements,
 * reports, mod cases, bans/mutes, message moderation…) but may NOT change the
 * server's appearance/settings (`manage_appearance` stays owner-only), and may
 * not assign other admins, transfer, or delete the server — those stay
 * owner/staff-only at the route layer.
 *
 * Site staff with `manage_any_server` resolve as owner-equivalent, and the
 * existing sitewide message-moderation permissions are NOT diminished by server
 * roles — a server mod can never out-rank site moderation.
 *
 * Server bans are scoped STRICTLY to the server's rooms: they gate room join,
 * posting, and membership applications, and nothing else anywhere.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Role, ServerFeaturePermission, ServerPermission } from "@thekeep/shared";
import {
  SERVER_ADMIN_DEFAULT_PERMISSIONS,
  SERVER_FEATURE_PERMISSIONS,
  SERVER_PERMISSIONS,
  parseServerFeaturePermissions,
  parseServerModPermissions,
} from "@thekeep/shared";
import { serverBans, serverMembers, serverUsergroupMembers, serverUsergroups, servers } from "../db/schema.js";
import { hasPermission } from "../auth/permissions.js";
import { isServerModerationActive } from "./moderation.js";
import type { Db } from "../db/index.js";

type ServerRow = typeof servers.$inferSelect;
type Caller = { id: string; role: Role };

export interface ServerAuthority {
  server: ServerRow | null;
  /** Relational role from server_members (staff override NOT folded in). */
  role: "owner" | "admin" | "mod" | "member" | null;
  /** True for the server owner OR site staff holding `manage_any_server`. */
  isOwner: boolean;
  /** Owner ⇒ also true; admins + mods get moderation powers (admin = all,
   *  mod = the owner-granted subset). */
  isMod: boolean;
  isMember: boolean;
  /** Effective server-permission set across the WHOLE registry (moderation +
   *  member features). Owner/staff hold EVERY key; an `admin` holds the full
   *  SERVER_MOD_PERMISSIONS set (the lieutenant) plus usergroup feature perms;
   *  a `mod` holds their direct grant plus usergroup perms; a `member` holds
   *  usergroup perms only. Use {@link serverCan} rather than reading this
   *  directly. */
  permissions: ServerPermission[];
  /** Active (non-expired) server ban, if any. `until` null = permanent. */
  ban: { until: Date | null; reason: string | null } | null;
  /**
   * May open the server's rooms and post (subject to each room's own
   * room-level checks, which still run after this): not banned, and on
   * application/invite-mode servers either a member/mod/admin/owner or staff.
   */
  canParticipate: boolean;
}

const NONE: ServerAuthority = {
  server: null, role: null, isOwner: false, isMod: false,
  isMember: false, permissions: [], ban: null, canParticipate: false,
};

/** Does this authority hold a given granular permission? Owner/staff always
 *  do. The single helper every server call site should use so the
 *  owner-implies-all rule lives in one place. */
export function serverCan(a: ServerAuthority, key: ServerPermission): boolean {
  return a.isOwner || a.permissions.includes(key);
}

/**
 * Resolve a member's usergroup-derived permissions for a server: the default
 * group's baseline (every participant) UNION every non-default group the user
 * is an explicit member of. Usergroups grant MEMBER-FEATURE perms ONLY — a
 * group can never confer moderation power (that comes from the role tier), so
 * we parse with {@link parseServerFeaturePermissions}. When the server has
 * defined NO groups at all, the baseline is the full feature set so behavior
 * is unchanged. Owner/staff skip this (they hold everything). `userId` null =
 * anonymous → no perms.
 */
async function resolveUsergroupPerms(db: Db, serverId: string, userId: string | null): Promise<ServerFeaturePermission[]> {
  if (!userId) return [];
  const groups = await db
    .select({ id: serverUsergroups.id, permissionsJson: serverUsergroups.permissionsJson, isDefault: serverUsergroups.isDefault })
    .from(serverUsergroups)
    .where(eq(serverUsergroups.serverId, serverId));
  if (!groups.length) return [...SERVER_FEATURE_PERMISSIONS];
  const defaultGroup = groups.find((g) => g.isDefault);
  const out = new Set<ServerFeaturePermission>(
    defaultGroup ? parseServerFeaturePermissions(defaultGroup.permissionsJson) : [...SERVER_FEATURE_PERMISSIONS],
  );
  const nonDefaultIds = groups.filter((g) => !g.isDefault).map((g) => g.id);
  if (nonDefaultIds.length) {
    const mine = await db
      .select({ groupId: serverUsergroupMembers.groupId })
      .from(serverUsergroupMembers)
      .where(and(eq(serverUsergroupMembers.userId, userId), inArray(serverUsergroupMembers.groupId, nonDefaultIds)));
    const myIds = new Set(mine.map((m) => m.groupId));
    for (const g of groups) {
      if (!g.isDefault && myIds.has(g.id)) for (const p of parseServerFeaturePermissions(g.permissionsJson)) out.add(p);
    }
  }
  return [...out];
}

/**
 * Resolve the caller's authority over a server. `user` null = anonymous
 * (public /s/ page): never participates, never banned, no roles.
 */
export async function serverAuthority(
  db: Db,
  user: Caller | null,
  serverId: string,
): Promise<ServerAuthority> {
  const server = (await db.select().from(servers).where(eq(servers.id, serverId)).limit(1))[0];
  if (!server) return NONE;
  if (!user) return { ...NONE, server };

  const memberRow = (await db
    .select()
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, user.id)))
    .limit(1))[0];
  const role = memberRow?.role ?? null;

  // Expired bans are treated as absent (the row is lazily ignored, not
  // deleted, so the owner's Bans tab can still show history until lifted).
  const banRow = (await db
    .select()
    .from(serverBans)
    .where(and(eq(serverBans.serverId, serverId), eq(serverBans.userId, user.id)))
    .limit(1))[0];
  const banActive = banRow && (!banRow.until || +banRow.until > Date.now());
  const ban = banActive ? { until: banRow.until ?? null, reason: banRow.reason ?? null } : null;

  const staffOverride = await hasPermission(user, "manage_any_server", db);
  const isOwner = staffOverride || server.ownerUserId === user.id || role === "owner";
  // Servers add an `admin` lieutenant tier above `mod`; both are mods.
  const isMod = isOwner || role === "admin" || role === "mod";
  // Owner/staff implicitly hold EVERY permission. An `admin` holds every
  // moderation key EXCEPT `manage_appearance` (SERVER_ADMIN_DEFAULT_PERMISSIONS
  // — appearance/settings stay owner-only) + usergroup perms; a plain `mod`
  // holds the owner-granted subset (server_members.permissions_json) + usergroup
  // perms; a `member` holds usergroup (feature) perms only. One unified registry.
  let permissions: ServerPermission[];
  if (isOwner) {
    permissions = [...SERVER_PERMISSIONS];
  } else {
    const directGrant: ServerPermission[] =
      role === "admin"
        ? [...SERVER_ADMIN_DEFAULT_PERMISSIONS]
        : role === "mod"
          ? parseServerModPermissions(memberRow?.permissionsJson)
          : [];
    const groupPerms = await resolveUsergroupPerms(db, serverId, user.id);
    permissions = [...new Set<ServerPermission>([...directGrant, ...groupPerms])];
  }
  // The Spire (isSystem) is the site-wide DEFAULT server: every signed-in user
  // is implicitly a member, so its members-only surfaces act as "signed-in
  // members only" (i.e. everyone but logged-out guests) WITHOUT needing a
  // server_members row per account. Without this, members-only sections of the
  // default server were invisible to everyone who hadn't been explicitly
  // enrolled. Anonymous callers already returned early above, so this only
  // elevates logged-in users.
  const isMember = isMod || role === "member" || server.isSystem === true;

  // Global-admin moderation gate (migration 0306): a suspended/banned server is
  // enterable ONLY by the owner, the owner's server admins/mods, and global
  // staff (all of whom pass via `isOwner`/`isMod` below) so they can review and
  // rectify it. Everyone else is blocked. Lazy expiry is handled inside the
  // helper: an expired ban reads as inactive, so this is byte-identical to the
  // prior formula whenever moderation is 'none' (or a ban has lapsed).
  const moderationActive = isServerModerationActive(server);

  // Owner/staff can always act (even on a server they were oddly banned in — a
  // ban row against the owner is a data bug, not a lockout). Open servers admit
  // any signed-in non-banned user; application/invite servers require
  // membership (or mod/admin/owner, folded into isMember above). A moderated
  // server additionally blocks non-mod participants (owner/admin/mod/staff are
  // allowed through so they can fix it — they satisfy isOwner or isMod).
  const canParticipate =
    isOwner ||
    ((isMod || !moderationActive) && !ban && (server.joinMode === "open" || isMember));

  return { server, role, isOwner, isMod, isMember, permissions, ban, canParticipate };
}
