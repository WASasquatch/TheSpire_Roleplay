/**
 * forumAuthority — the ONE resolver for "what may this user do in this
 * forum". Every forum-gated decision (board join, topic moderation,
 * category management, membership review, bans) goes through here so the
 * powers matrix in plan.md is enforced in exactly one place:
 *
 *   power                                   owner   mod   member/visitor
 *   edit forum settings / boards / cats      ✅      ❌        ❌
 *   sticky / lock topics                     ✅      ✅        ❌
 *   edit/delete others' topics+replies       ✅      ✅*       ❌    (*never owner-authored content)
 *   assign mods / ban / delete forum         ✅      ❌        ❌
 *   review membership applications           ✅      ✅        ❌
 *
 * Site staff with `manage_any_forum` resolve as owner-equivalent, and the
 * existing sitewide message-moderation permissions are NOT diminished by
 * forum roles — a forum mod can never out-rank site moderation.
 *
 * Forum bans are scoped STRICTLY to the forum's boards: they gate board
 * join, posting, and membership applications, and nothing else anywhere.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { ForumPermission } from "@thekeep/shared";
import { FORUM_FEATURE_PERMISSIONS, FORUM_PERMISSIONS, parseForumPermissions } from "@thekeep/shared";
import { forumBans, forumMembers, forumUsergroupMembers, forumUsergroups, forums, roomThreadCategories, rooms } from "../db/schema.js";
import { resolveScopedAuthority, scopedCan, type Caller } from "../auth/scopedAuthority.js";
import { tFor } from "../i18n.js";
import type { Db } from "../db/index.js";

type ForumRow = typeof forums.$inferSelect;

export interface ForumAuthority {
  forum: ForumRow | null;
  /** Relational role from forum_members (staff override NOT folded in). */
  role: "owner" | "mod" | "member" | null;
  /** True for the forum owner OR site staff holding `manage_any_forum`. */
  isOwner: boolean;
  /** Owner ⇒ also true; mods get topic-level powers only. */
  isMod: boolean;
  isMember: boolean;
  /** Effective forum-permission set across the WHOLE registry (moderation +
   *  member features). Owner/staff hold EVERY key; everyone else holds the
   *  union of their default usergroup, every group they're in, and any direct
   *  mod grant. Use {@link forumCan} rather than reading this directly. */
  permissions: ForumPermission[];
  /** Active (non-expired) forum ban, if any. `until` null = permanent. */
  ban: { until: Date | null; reason: string | null } | null;
  /**
   * May open the forum's boards and post (subject to the board's own
   * room-level checks, which still run after this): not banned, and on
   * application-mode forums either a member/mod/owner or staff.
   */
  canParticipate: boolean;
}

/** Does this authority hold a given granular mod permission? Owner/staff
 *  always do. The single helper every forum call site should use so the
 *  owner-implies-all rule lives in one place. */
export function forumCan(a: ForumAuthority, key: ForumPermission): boolean {
  return scopedCan(a, key);
}

/**
 * Resolve the caller's authority over a forum. `user` null = anonymous
 * (public /f/ page): never participates, never banned, no roles.
 *
 * A thin wrapper over the shared {@link resolveScopedAuthority} scaffold: it
 * feeds in the forum tables + knobs and renames `scope` → `forum`. Forums have
 * a single `mod` tier, parse the whole registry for both direct grants and
 * usergroups, and never have a global-moderation gate (`moderationActive` is
 * always false, so the unified `canParticipate` collapses to the forum formula).
 */
export async function forumAuthority(
  db: Db,
  user: Caller | null,
  forumId: string,
): Promise<ForumAuthority> {
  const core = await resolveScopedAuthority<ForumRow, "owner" | "mod" | "member", ForumPermission>(db, user, {
    manageAnyPermission: "manage_any_forum",
    allPermissions: FORUM_PERMISSIONS,
    isModForRole: (role) => role === "mod",
    directGrantForRole: (role, permissionsJson) =>
      role === "mod" ? parseForumPermissions(permissionsJson) : [],
    isOpen: (forum) => forum.postingMode === "open",
    moderationActive: () => false,
    fetchScope: async () =>
      (await db.select().from(forums).where(eq(forums.id, forumId)).limit(1))[0],
    fetchMember: async (userId) => {
      const row = (await db
        .select()
        .from(forumMembers)
        .where(and(eq(forumMembers.forumId, forumId), eq(forumMembers.userId, userId)))
        .limit(1))[0];
      return row ? { role: row.role, permissionsJson: row.permissionsJson ?? null } : undefined;
    },
    fetchBan: async (userId) =>
      (await db
        .select()
        .from(forumBans)
        .where(and(eq(forumBans.forumId, forumId), eq(forumBans.userId, userId)))
        .limit(1))[0],
    fetchGroups: async () =>
      db
        .select({ id: forumUsergroups.id, permissionsJson: forumUsergroups.permissionsJson, isDefault: forumUsergroups.isDefault })
        .from(forumUsergroups)
        .where(eq(forumUsergroups.forumId, forumId)),
    fetchMemberGroupIds: async (userId, nonDefaultIds) =>
      (await db
        .select({ groupId: forumUsergroupMembers.groupId })
        .from(forumUsergroupMembers)
        .where(and(eq(forumUsergroupMembers.userId, userId), inArray(forumUsergroupMembers.groupId, nonDefaultIds))))
        .map((m) => m.groupId),
    usergroupParse: parseForumPermissions,
    usergroupFallback: FORUM_FEATURE_PERMISSIONS,
  });
  // Rename the generic `scope` field to the forum-specific `forum` field so the
  // public ForumAuthority shape (and every call site) is unchanged.
  const { scope, ...rest } = core;
  return { forum: scope, ...rest };
}

/**
 * Convenience for board-level call sites that have a room row with a
 * `forumId`: resolves authority and answers the single most common
 * question — "may this user enter/post in this board's forum?" — with a
 * user-facing denial message when not.
 */
export async function forumGateForBoard(
  db: Db,
  // Denial copy renders in the CALLER's language when the caller shape
  // carries users.locale (SessionUser does); narrow {id, role} callers
  // simply fall back to en.
  user: Caller & { locale?: string | null },
  forumId: string,
): Promise<{ ok: true; authority: ForumAuthority } | { ok: false; code: string; message: string }> {
  const authority = await forumAuthority(db, user, forumId);
  if (!authority.forum) {
    // Orphaned forumId (forum hard-deleted without archiving boards —
    // shouldn't happen, but never strand the room behind a dead gate).
    return { ok: true, authority };
  }
  if (authority.ban) {
    return {
      ok: false,
      code: "FORUM_BANNED",
      message: authority.ban.until
        ? tFor(user.locale, "errors:server.forums.bannedFromNamedUntil", {
            name: authority.forum.name,
            date: authority.ban.until.toISOString().slice(0, 10),
          })
        : tFor(user.locale, "errors:server.forums.bannedFromNamed", { name: authority.forum.name }),
    };
  }
  if (!authority.canParticipate) {
    return {
      ok: false,
      code: "FORUM_MEMBERS_ONLY",
      message: tFor(user.locale, "errors:server.forums.approvedMembersOnly", { name: authority.forum.name }),
    };
  }
  return { ok: true, authority };
}

/**
 * Per-section READ gate for a forum board (migration 0239). Resolves, for one
 * viewer + one room, whether the board or any of its categories is marked
 * "members only" and the viewer isn't a member. Used by the content-read
 * routes (`/rooms/:id/topics`, `/rooms/:id/thread-categories`, the thread
 * reader, and the permalink locator) so a private board/category can't be
 * read by guests OR logged-in non-members. Owner/mods/members pass freely.
 *
 * Non-forum rooms (no `forumId`) return `isBoard: false` and never gate —
 * the helper is a no-op for ordinary chat rooms.
 */
export interface ForumBoardReadGate {
  /** The room is a forum board (membersOnly semantics apply). */
  isBoard: boolean;
  /** Viewer is owner/mod/member of the board's forum. */
  isMember: boolean;
  /** Board is members-only AND the viewer isn't a member → withhold ALL content. */
  boardLocked: boolean;
  /** Category ids the viewer may not read (members-only, viewer not a member). */
  lockedCatIds: Set<string>;
}

export async function forumBoardReadGate(
  db: Db,
  user: Caller | null,
  roomId: string,
): Promise<ForumBoardReadGate> {
  const room = (await db
    .select({ forumId: rooms.forumId, forumMembersOnly: rooms.forumMembersOnly })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1))[0];
  if (!room?.forumId) {
    return { isBoard: false, isMember: false, boardLocked: false, lockedCatIds: new Set() };
  }
  const authority = await forumAuthority(db, user, room.forumId);
  if (authority.isMember) {
    return { isBoard: true, isMember: true, boardLocked: false, lockedCatIds: new Set() };
  }
  const lockedCats = await db
    .select({ id: roomThreadCategories.id })
    .from(roomThreadCategories)
    .where(and(eq(roomThreadCategories.roomId, roomId), eq(roomThreadCategories.membersOnly, true)));
  return {
    isBoard: true,
    isMember: false,
    boardLocked: !!room.forumMembersOnly,
    lockedCatIds: new Set(lockedCats.map((c) => c.id)),
  };
}
