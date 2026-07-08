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
import type { ServerPermission } from "@thekeep/shared";
import {
  SERVER_ADMIN_DEFAULT_PERMISSIONS,
  SERVER_FEATURE_PERMISSIONS,
  SERVER_PERMISSIONS,
  parseServerFeaturePermissions,
  parseServerModPermissions,
} from "@thekeep/shared";
import { serverBans, serverMembers, serverUsergroupMembers, serverUsergroups, servers } from "../db/schema.js";
import { resolveScopedAuthority, scopedCan, type Caller } from "../auth/scopedAuthority.js";
import type { Db } from "../db/index.js";
import { isServerModerationActive } from "./moderation.js";

type ServerRow = typeof servers.$inferSelect;

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

/** Does this authority hold a given granular permission? Owner/staff always
 *  do. The single helper every server call site should use so the
 *  owner-implies-all rule lives in one place. */
export function serverCan(a: ServerAuthority, key: ServerPermission): boolean {
  return scopedCan(a, key);
}

/**
 * Resolve the caller's authority over a server. `user` null = anonymous
 * (public /s/ page): never participates, never banned, no roles.
 *
 * A thin wrapper over the shared {@link resolveScopedAuthority} scaffold: it
 * feeds in the server tables + knobs and renames `scope` → `server`. Servers
 * add the `admin` lieutenant tier above `mod`, parse usergroups as MEMBER-
 * FEATURE perms only (a group can never confer moderation power — that comes
 * from the role tier), and layer the global-admin moderation gate (migration
 * 0306) into `canParticipate` via {@link isServerModerationActive}.
 */
export async function serverAuthority(
  db: Db,
  user: Caller | null,
  serverId: string,
): Promise<ServerAuthority> {
  const core = await resolveScopedAuthority<ServerRow, "owner" | "admin" | "mod" | "member", ServerPermission>(db, user, {
    manageAnyPermission: "manage_any_server",
    allPermissions: SERVER_PERMISSIONS,
    // Servers add an `admin` lieutenant tier above `mod`; both are mods.
    isModForRole: (role) => role === "admin" || role === "mod",
    // An `admin` holds every moderation key EXCEPT `manage_appearance`
    // (SERVER_ADMIN_DEFAULT_PERMISSIONS — appearance/settings stay owner-only);
    // a plain `mod` holds the owner-granted subset (server_members
    // .permissions_json); a `member` holds usergroup (feature) perms only.
    directGrantForRole: (role, permissionsJson) =>
      role === "admin"
        ? [...SERVER_ADMIN_DEFAULT_PERMISSIONS]
        : role === "mod"
          ? parseServerModPermissions(permissionsJson)
          : [],
    isOpen: (server) => server.joinMode === "open",
    moderationActive: (server) => isServerModerationActive(server),
    fetchScope: async () =>
      (await db.select().from(servers).where(eq(servers.id, serverId)).limit(1))[0],
    fetchMember: async (userId) => {
      const row = (await db
        .select()
        .from(serverMembers)
        .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
        .limit(1))[0];
      return row ? { role: row.role, permissionsJson: row.permissionsJson ?? null } : undefined;
    },
    fetchBan: async (userId) =>
      (await db
        .select()
        .from(serverBans)
        .where(and(eq(serverBans.serverId, serverId), eq(serverBans.userId, userId)))
        .limit(1))[0],
    fetchGroups: async () =>
      db
        .select({ id: serverUsergroups.id, permissionsJson: serverUsergroups.permissionsJson, isDefault: serverUsergroups.isDefault })
        .from(serverUsergroups)
        .where(eq(serverUsergroups.serverId, serverId)),
    fetchMemberGroupIds: async (userId, nonDefaultIds) =>
      (await db
        .select({ groupId: serverUsergroupMembers.groupId })
        .from(serverUsergroupMembers)
        .where(and(eq(serverUsergroupMembers.userId, userId), inArray(serverUsergroupMembers.groupId, nonDefaultIds))))
        .map((m) => m.groupId),
    // Usergroups grant MEMBER-FEATURE perms ONLY (parseServerFeaturePermissions),
    // never moderation power.
    usergroupParse: parseServerFeaturePermissions,
    usergroupFallback: SERVER_FEATURE_PERMISSIONS,
  });
  // Rename the generic `scope` field to the server-specific `server` field so
  // the public ServerAuthority shape (and every call site) is unchanged.
  const { scope, ...rest } = core;
  return { server: scope, ...rest };
}
