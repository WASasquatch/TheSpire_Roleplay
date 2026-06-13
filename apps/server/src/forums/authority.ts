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
import { and, eq } from "drizzle-orm";
import type { Role } from "@thekeep/shared";
import { forumBans, forumMembers, forums, roomThreadCategories, rooms } from "../db/schema.js";
import { hasPermission } from "../auth/permissions.js";
import type { Db } from "../db/index.js";

type ForumRow = typeof forums.$inferSelect;
type Caller = { id: string; role: Role };

export interface ForumAuthority {
  forum: ForumRow | null;
  /** Relational role from forum_members (staff override NOT folded in). */
  role: "owner" | "mod" | "member" | null;
  /** True for the forum owner OR site staff holding `manage_any_forum`. */
  isOwner: boolean;
  /** Owner ⇒ also true; mods get topic-level powers only. */
  isMod: boolean;
  isMember: boolean;
  /** Active (non-expired) forum ban, if any. `until` null = permanent. */
  ban: { until: Date | null; reason: string | null } | null;
  /**
   * May open the forum's boards and post (subject to the board's own
   * room-level checks, which still run after this): not banned, and on
   * application-mode forums either a member/mod/owner or staff.
   */
  canParticipate: boolean;
}

const NONE: ForumAuthority = {
  forum: null, role: null, isOwner: false, isMod: false,
  isMember: false, ban: null, canParticipate: false,
};

/**
 * Resolve the caller's authority over a forum. `user` null = anonymous
 * (public /f/ page): never participates, never banned, no roles.
 */
export async function forumAuthority(
  db: Db,
  user: Caller | null,
  forumId: string,
): Promise<ForumAuthority> {
  const forum = (await db.select().from(forums).where(eq(forums.id, forumId)).limit(1))[0];
  if (!forum) return NONE;
  if (!user) return { ...NONE, forum };

  const memberRow = (await db
    .select()
    .from(forumMembers)
    .where(and(eq(forumMembers.forumId, forumId), eq(forumMembers.userId, user.id)))
    .limit(1))[0];
  const role = memberRow?.role ?? null;

  // Expired bans are treated as absent (the row is lazily ignored, not
  // deleted, so the owner's Bans tab can still show history until lifted).
  const banRow = (await db
    .select()
    .from(forumBans)
    .where(and(eq(forumBans.forumId, forumId), eq(forumBans.userId, user.id)))
    .limit(1))[0];
  const banActive = banRow && (!banRow.until || +banRow.until > Date.now());
  const ban = banActive ? { until: banRow.until ?? null, reason: banRow.reason ?? null } : null;

  const staffOverride = await hasPermission(user, "manage_any_forum", db);
  const isOwner = staffOverride || forum.ownerUserId === user.id || role === "owner";
  const isMod = isOwner || role === "mod";
  const isMember = isMod || role === "member";

  // Owner/staff can always act (even on a forum they were oddly banned
  // in — a ban row against the owner is a data bug, not a lockout).
  const canParticipate =
    isOwner || (!ban && (forum.postingMode === "open" || isMember));

  return { forum, role, isOwner, isMod, isMember, ban, canParticipate };
}

/**
 * Convenience for board-level call sites that have a room row with a
 * `forumId`: resolves authority and answers the single most common
 * question — "may this user enter/post in this board's forum?" — with a
 * user-facing denial message when not.
 */
export async function forumGateForBoard(
  db: Db,
  user: Caller,
  forumId: string,
): Promise<{ ok: true; authority: ForumAuthority } | { ok: false; code: string; message: string }> {
  const authority = await forumAuthority(db, user, forumId);
  if (!authority.forum) {
    // Orphaned forumId (forum hard-deleted without archiving boards —
    // shouldn't happen, but never strand the room behind a dead gate).
    return { ok: true, authority };
  }
  if (authority.ban) {
    const untilTxt = authority.ban.until
      ? ` until ${authority.ban.until.toISOString().slice(0, 10)}`
      : "";
    return {
      ok: false,
      code: "FORUM_BANNED",
      message: `You are banned from the "${authority.forum.name}" forum${untilTxt}.`,
    };
  }
  if (!authority.canParticipate) {
    return {
      ok: false,
      code: "FORUM_MEMBERS_ONLY",
      message: `"${authority.forum.name}" accepts posts from approved members — apply from the forum's page.`,
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
