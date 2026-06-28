import type { FastifyInstance } from "fastify";
import { hasPermission } from "../auth/permissions.js";
import type { Role, ForumPermission, AuditAction } from "@thekeep/shared";
import { recordAudit } from "../audit.js";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Server as IoServer } from "socket.io";
import type {
  ChatMessage,
  ClientToServerEvents,
  ServerToClientEvents,
} from "@thekeep/shared";
import { mentionsField, parseNpcStats } from "@thekeep/shared";
import { messages, rooms, roomThreadCategories, users } from "../db/schema.js";
import { linkPreviewFromRow } from "../unfurl.js";
import { sanitizeBio } from "../auth/html.js";
import { getSessionUser } from "./auth.js";
import { getSettings } from "../settings.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

// Edit / delete grace window for chat (flat) rooms is now admin-
// configurable via `siteSettings.editGraceMs`. Each handler below
// reads the current value via `getSettings(db)` so a runtime tweak
// takes effect on the next attempt without restart. Forum rooms
// (replyMode="nested") bypass the cap entirely, posts there are
// long-lived and authors are expected to refine them indefinitely,
// with the (edited) badge providing transparency.

/**
 * Look up whether the message's room is a forum (nested-mode). Forum posts
 * skip the edit/delete grace window. Cached single-row lookup; cheap.
 */
async function isForumMessage(db: Db, roomId: string): Promise<boolean> {
  const row = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  return row?.replyMode === "nested";
}

/**
 * Powers-matrix tier for a FORUM board (rooms.forumId set), consulted by
 * the moderation gates below IN ADDITION to the sitewide permission keys:
 *
 *   owner (forum owner / manage_any_forum staff): sticky, lock, edit, and
 *     delete anything on their boards.
 *   mod (owner-assigned Forum Moderator): the same topic-level powers
 *     EXCEPT content authored by the forum owner — per the matrix a mod
 *     can never edit or delete the owner's posts (lock/sticky are state,
 *     not content, and stay allowed).
 *
 * Returns null for non-board rooms so flat chat and standalone nested
 * rooms keep today's gates untouched.
 */
async function boardModTier(
  db: Db,
  user: { id: string; role: Role },
  roomId: string,
): Promise<{
  /** True for the forum owner / manage_any_forum staff. */
  isOwner: boolean;
  /** Effective forum permissions this user holds (owner = all). */
  permissions: ForumPermission[];
  forumOwnerUserId: string;
} | null> {
  const room = (await db.select({ forumId: rooms.forumId }).from(rooms)
    .where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room?.forumId) return null;
  const { forumAuthority } = await import("../forums/authority.js");
  const a = await forumAuthority(db, user, room.forumId);
  if (!a.forum) return null;
  return {
    isOwner: a.isOwner,
    permissions: a.permissions,
    forumOwnerUserId: a.forum.ownerUserId,
  };
}

/** Owner-implies-all check for a board tier (mirrors forums/authority.forumCan
 *  without importing it, to keep messages.ts off the authority module's
 *  static import graph — boardModTier already imports it dynamically). */
function boardCan(
  board: { isOwner: boolean; permissions: ForumPermission[] } | null,
  key: ForumPermission,
): boolean {
  return !!board && (board.isOwner || board.permissions.includes(key));
}

/**
 * Record a forum-board moderation action into the audit log, stamping the
 * board's `forumId` into metadata so the forum's Mod Log can filter to it.
 * No-op for non-forum-board rooms (forumId null), so the chat moderation
 * paths that share these handlers don't pollute any forum's log.
 */
async function auditForumTopic(
  db: Db,
  actorUserId: string,
  roomId: string,
  messageId: string,
  action: AuditAction,
  metadata: Record<string, unknown>,
  targetUserId?: string | null,
): Promise<void> {
  const room = (await db.select({ forumId: rooms.forumId }).from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room?.forumId) return;
  await recordAudit(db, {
    actorUserId,
    action,
    targetRoomId: roomId,
    targetMessageId: messageId,
    ...(targetUserId ? { targetUserId } : {}),
    metadata: { ...metadata, forumId: room.forumId },
  });
}

const editBody = z.object({ body: z.string().min(1).max(20_000) }).strict();

export function toWire(m: typeof messages.$inferSelect, viewerIsAdmin = false): ChatMessage {
  // Mirrors the row→ChatMessage shape used in broadcast.ts; if either side
  // adds fields, both should be updated. Snapshotted fields stay as-is on
  // edit (mood, npcVoicedBy, replyTo*, etc.), only `body` and `editedAt`
  // change.
  //
  // Deleted messages: the visible body is stripped to "" for everyone
  // (renderer paints "[message removed]"). Viewers with the
  // `view_deleted_message_body` permission additionally receive the
  // original body on a separate `originalBody` field so they can
  // audit what got hidden. Viewers without the permission don't get
  // the field, gate is `viewerIsAdmin`, which the caller computes
  // from `hasPermission(viewer, "view_deleted_message_body")`. (The
  // parameter name is kept for back-compat; semantics moved to the
  // catalog key, but every existing call site passes the same boolean.)
  return {
    id: m.id,
    roomId: m.roomId,
    userId: m.userId,
    characterId: m.characterId,
    displayName: m.displayName,
    kind: m.kind,
    body: m.deletedAt ? "" : m.body,
    color: m.color,
    createdAt: +m.createdAt,
    ...(m.toUserId ? { toUserId: m.toUserId } : {}),
    ...(m.toCharacterId ? { toCharacterId: m.toCharacterId } : {}),
    ...(m.toDisplayName ? { toDisplayName: m.toDisplayName } : {}),
    ...(m.replyToId ? { replyToId: m.replyToId } : {}),
    ...(m.replyToDisplayName ? { replyToDisplayName: m.replyToDisplayName } : {}),
    ...(m.replyToBodySnippet ? { replyToBodySnippet: m.replyToBodySnippet } : {}),
    ...(m.moodSnapshot ? { moodSnapshot: m.moodSnapshot } : {}),
    ...(m.npcVoicedBy ? { npcVoicedBy: m.npcVoicedBy } : {}),
    ...(m.npcStatsJson ? { npcStats: parseNpcStats(m.npcStatsJson) } : {}),
    ...(m.threadCategoryId ? { threadCategoryId: m.threadCategoryId } : {}),
    ...(m.title ? { title: m.title } : {}),
    ...(m.prefixId ? { prefixId: m.prefixId } : {}),
    ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    ...(m.editedAt ? { editedAt: +m.editedAt } : {}),
    ...(m.deletedAt ? { deletedAt: +m.deletedAt } : {}),
    ...(m.lockedAt ? { lockedAt: +m.lockedAt } : {}),
    ...(m.lastActivityAt ? { lastActivityAt: +m.lastActivityAt } : {}),
    ...(m.isSticky ? { isSticky: true } : {}),
    ...(m.cmdCss ? { cmdCss: m.cmdCss } : {}),
    ...(() => { const lp = linkPreviewFromRow(m.linkPreviewJson); return lp ? { linkPreview: lp } : {}; })(),
    ...(m.sceneImageUrl ? { sceneImageUrl: m.sceneImageUrl } : {}),
    ...(m.bodyHtml ? { bodyHtml: m.bodyHtml } : {}),
    ...mentionsField(m.mentionsJson),
    ...(m.rankKey ? { rankKey: m.rankKey } : {}),
    ...(m.tier != null ? { tier: m.tier } : {}),
    ...(m.senderInlineAvatarEnabled ? { senderInlineAvatarEnabled: true } : {}),
    ...(m.senderSelectedBorderRankKey ? { senderSelectedBorderRankKey: m.senderSelectedBorderRankKey } : {}),
    ...(viewerIsAdmin && m.deletedAt ? { originalBody: m.body } : {}),
    // Admin-only audit snapshot of who performed the delete. Mirrors
    // the originalBody carve-out, site admins see who took the
    // moderation action; mods and ordinary viewers don't. Falls back
    // to undefined when the snapshot isn't present (pre-0084 deletes).
    ...(viewerIsAdmin && m.deletedAt && m.deletedByUserId
      ? { deletedByUserId: m.deletedByUserId }
      : {}),
    ...(viewerIsAdmin && m.deletedAt && m.deletedByDisplayName
      ? { deletedByDisplayName: m.deletedByDisplayName }
      : {}),
  };
}

export async function registerMessageRoutes(
  app: FastifyInstance,
  db: Db,
  io: Io,
): Promise<void> {
  /**
   * Edit a message.
   *
   * Auth: author within the grace window (flat rooms) / anytime (forum
   * rooms), OR any admin / masteradmin (no grace window, no room-shape
   * restriction). Mods are intentionally left out: they can hide a post
   * via DELETE but rewriting another user's words is reserved for the
   * admin tier. Authors who miss the edit window can request an admin
   * touch-up.
   *
   * Replies: when a parent is edited the snapshot in the child's
   * `replyToBodySnippet` is *not* rewritten, child snapshots remain frozen
   * at the moment they were created, which keeps the audit trail honest
   * and matches the "snapshot at send time" pattern used for displayName
   * and to_display_name.
   */
  app.patch<{ Params: { id: string }; Body: unknown }>("/messages/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let body;
    try { body = editBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m) { reply.code(404); return { error: "not found" }; }

    const isAuthor = m.userId === me.id;
    // `edit_others_message` covers both the gate for editing someone
    // else's message AND the grace-window bypass for editing past the
    // author cap. One permission, one decision. Authors get
    // unconditional access to their own messages (within the window)
    // independently.
    const canEditOthers = await hasPermission(me, "edit_others_message", db);
    if (!isAuthor && !canEditOthers) {
      // Forum boards: the owner may edit anything; a mod needs the
      // `edit_posts` grant AND may never edit the owner's own posts.
      const board = await boardModTier(db, me, m.roomId);
      const boardOk = !!board && (board.isOwner
        || (boardCan(board, "edit_posts") && m.userId !== board.forumOwnerUserId));
      if (!boardOk) { reply.code(403); return { error: "not yours" }; }
    }
    if (m.deletedAt) { reply.code(410); return { error: "already removed" }; }

    const now = Date.now();
    const forum = await isForumMessage(db, m.roomId);
    // Single settings read covers both gates (edit window + size cap)
    // so we don't pay two getSettings round-trips per edit.
    const { maxMessageLength, maxForumPostLength, editGraceMs } = await getSettings(db);
    // Holders of edit_others_message bypass the grace window entirely
    // (a moderation lever for touch-ups requested by an author after
    // the cap has expired).
    if (!canEditOthers && !forum && now - +m.createdAt > editGraceMs) {
      reply.code(403);
      return { error: `Edit window has closed (${Math.round(editGraceMs / 1000)}s after sending).` };
    }

    // Apply the same per-surface length cap as fresh messages so
    // editing isn't a back door around the configured limit. Forum
    // posts use the larger forum cap; flat-chat edits use the chat
    // cap.
    const trimmed = body.body.trim();
    if (!trimmed) { reply.code(400); return { error: "empty" }; }
    const effectiveCap = forum ? maxForumPostLength : maxMessageLength;
    if (trimmed.length > effectiveCap) {
      reply.code(413);
      return {
        error: forum
          ? `Forum posts capped at ${effectiveCap} chars.`
          : `Messages capped at ${effectiveCap} chars.`,
      };
    }

    // Re-sanitise for kinds whose bodies feed renderers that trust them. We
    // don't currently render body via dangerouslySetInnerHTML on the chat
    // line, but be defensive, sanitiseBio is the same routine used for bio
    // HTML and is safe to apply to plain text (it's a no-op for text-only).
    const safeBody = m.kind === "say" || m.kind === "me" || m.kind === "ooc" || m.kind === "scene"
      ? trimmed
      : sanitizeBio(trimmed);

    const editedAt = new Date(now);
    await db
      .update(messages)
      .set({ body: safeBody, editedAt })
      .where(eq(messages.id, m.id));

    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (!updated) { reply.code(404); return { error: "not found" }; }
    io.to(`room:${m.roomId}`).emit("message:update", toWire(updated));
    // Cross-room whisper overlay: the recipient may be viewing the
    // whisper from another room (their bucket holds it under a
    // different roomId). Fan the update out to their sockets too so
    // the live edit lands wherever they're looking. Skips if recipient
    // is already in the sender's room, the room broadcast above
    // already covered them, and the client's updateMessage is
    // idempotent on duplicate updates anyway.
    if (updated.kind === "whisper" && updated.toUserId) {
      const toId = updated.toUserId;
      const wire = toWire(updated);
      const sockets = await io.fetchSockets();
      for (const s of sockets) {
        const uid = (s.data as { userId?: string }).userId;
        if (uid !== toId) continue;
        if ((s.data as { roomId?: string }).roomId === m.roomId) continue;
        s.emit("message:update", wire);
      }
    }
    return { ok: true };
  });

  /**
   * Soft-delete a message. Permitted for:
   *   * the author (within 60s in flat rooms, anytime in forum rooms)
   *   * any moderator or admin (no time gate, moderation action)
   *
   * The body is preserved on the row server-side so admin/report review
   * can still see the original content; `toWire` returns body="" to all
   * end-user surfaces (the renderer paints "[message removed]"). Reply
   * snippets in children stay coherent regardless since they were
   * frozen at reply time.
   */
  app.delete<{ Params: { id: string } }>("/messages/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m) { reply.code(404); return { error: "not found" }; }

    const isAuthor = m.userId === me.id;
    // `delete_others_message` covers both gate + grace-window bypass
    // for moderators. Same shape as the edit path above.
    const canDeleteOthers = await hasPermission(me, "delete_others_message", db);
    if (!isAuthor && !canDeleteOthers) {
      // Forum boards: owner deletes anything; a mod needs the
      // `delete_posts` grant AND may never delete owner-authored content.
      const board = await boardModTier(db, me, m.roomId);
      const boardOk = !!board && (board.isOwner
        || (boardCan(board, "delete_posts") && m.userId !== board.forumOwnerUserId));
      if (!boardOk) { reply.code(403); return { error: "not yours" }; }
    }
    if (m.deletedAt) { reply.code(410); return { error: "already removed" }; }

    const now = Date.now();
    const forum = await isForumMessage(db, m.roomId);
    // Holders of `delete_others_message` bypass the grace window
    // entirely; authors only get the bypass in forum rooms (and in
    // flat-chat rooms within the admin-configured grace window).
    const { editGraceMs } = await getSettings(db);
    if (!canDeleteOthers && !forum && now - +m.createdAt > editGraceMs) {
      reply.code(403);
      return { error: `Delete window has closed (${Math.round(editGraceMs / 1000)}s after sending).` };
    }

    const deletedAt = new Date(now);
    // Snapshot the actor's identity onto the row so the admin-audit
    // render in chat can show who performed the delete (self vs
    // admin/mod). We snapshot `username` (the underlying account)
    // rather than the active character's displayName because
    // moderation transparency is the goal, admins doing a delete
    // should be identifiable as their account, not as whatever
    // character they happened to be voicing at the time. Self-delete
    // detection at render time compares by userId, so the snapshot
    // name is presentation-only.
    await db
      .update(messages)
      .set({
        deletedAt,
        deletedByUserId: me.id,
        deletedByDisplayName: me.username,
      })
      .where(eq(messages.id, m.id));

    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (!updated) { reply.code(404); return { error: "not found" }; }
    // Mod Log: a moderator removing someone ELSE's forum post (self-deletes
    // aren't moderation). No-op off forum boards.
    if (!isAuthor) {
      await auditForumTopic(db, me.id, m.roomId, m.id, "forum_post_delete", { isTopic: !m.replyToId, title: m.title ?? null }, m.userId);
    }
    // Per-socket emit so site admins (admin / masteradmin) receive the
    // original body alongside the deletion marker, they need to see
    // what got hidden in case the author was burying something. Mods,
    // room-owner mods, and ordinary viewers get the bare wire payload
    // (no `originalBody` field). This means the deleted content never
    // crosses the wire to anyone who shouldn't have it.
    const adminWire = toWire(updated, true);
    const plainWire = toWire(updated, false);
    const roomSockets = await io.in(`room:${m.roomId}`).fetchSockets();
    if (roomSockets.length === 0) return { ok: true };
    // Look the viewer roles up in one batch, typical room has ≤ 50
    // sockets, so a single SELECT keyed by userId beats per-socket
    // round-trips. Sockets with no resolvable userId (unauthenticated
    // edge cases) get the plain payload by default.
    const userIds = [
      ...new Set(
        roomSockets
          .map((s) => (s.data as { userId?: string }).userId)
          .filter((u): u is string => !!u),
      ),
    ];
    const roles =
      userIds.length === 0
        ? new Map<string, string>()
        : new Map(
            (
              await db
                .select({ id: users.id, role: users.role })
                .from(users)
                .where(inArray(users.id, userIds))
            ).map((r) => [r.id, r.role]),
          );
    for (const s of roomSockets) {
      const uid = (s.data as { userId?: string }).userId ?? "";
      const role = roles.get(uid) ?? "user";
      // Reveal `originalBody` only to viewers with the
      // `view_deleted_message_body` permission. The per-viewer check
      // is per-socket so granting / revoking the permission in the
      // matrix takes effect on the next fanout without code changes.
      const canSeeOriginal = await hasPermission({ id: uid, role: role as Role }, "view_deleted_message_body", db);
      s.emit("message:update", canSeeOriginal ? adminWire : plainWire);
    }
    // Cross-room whisper overlay: fan the delete out to the recipient
    // even when they're viewing from another room. Same shape as the
    // edit path; recipient role determines admin vs plain wire (it
    // matters for the originalBody audit field, though admins viewing
    // their own whispers from outside the sender's room is rare).
    if (updated.kind === "whisper" && updated.toUserId) {
      const toId = updated.toUserId;
      const allSockets = await io.fetchSockets();
      const recipientSockets = allSockets.filter((s) => {
        const uid = (s.data as { userId?: string }).userId;
        if (uid !== toId) return false;
        return (s.data as { roomId?: string }).roomId !== m.roomId;
      });
      if (recipientSockets.length > 0) {
        const recipRole = (await db
          .select({ role: users.role })
          .from(users)
          .where(eq(users.id, toId))
          .limit(1))[0]?.role ?? "user";
        const canSeeOriginal = await hasPermission({ id: toId, role: recipRole as Role }, "view_deleted_message_body", db);
        const wire = canSeeOriginal ? adminWire : plainWire;
        for (const s of recipientSockets) s.emit("message:update", wire);
      }
    }
    return { ok: true };
  });

  /**
   * Lock or unlock a forum topic. Locked topics still display normally
   * but reject new replies server-side (`dispatch.ts` checks
   * `parent.lockedAt` and returns LOCKED). Permitted for:
   *   * the topic's author (close-my-own-thread)
   *   * any mod or admin (moderation)
   *
   * Only works on top-level topics (`replyToId IS NULL`) in nested-mode
   * rooms, locking a reply or a flat-chat message is a category error
   * and is rejected with 400.
   */
  const lockBody = z.object({ locked: z.boolean() }).strict();
  app.patch<{ Params: { id: string }; Body: unknown }>("/messages/:id/lock", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let parsed;
    try { parsed = lockBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m) { reply.code(404); return { error: "not found" }; }
    if (m.deletedAt) { reply.code(410); return { error: "already removed" }; }
    if (m.replyToId) { reply.code(400); return { error: "Only top-level topics can be locked." }; }

    const forum = await isForumMessage(db, m.roomId);
    if (!forum) { reply.code(400); return { error: "Locking applies only to forum-mode rooms." }; }

    const isAuthor = m.userId === me.id;
    // Authors can lock their own topic; mods/admins with the
    // appropriate permission lock or unlock any topic. On forum BOARDS
    // the forum owner + Forum Moderators get the same lever (lock is
    // state, not content, so the owner-content exception doesn't apply).
    const key = parsed.locked ? "lock_forum_topic" : "unlock_forum_topic";
    const canModerate = await hasPermission(me, key, db);
    if (!isAuthor && !canModerate) {
      const board = await boardModTier(db, me, m.roomId);
      if (!boardCan(board, "lock_topics")) { reply.code(403); return { error: "not yours" }; }
    }

    const lockedAt = parsed.locked ? new Date() : null;
    await db
      .update(messages)
      .set({ lockedAt })
      .where(eq(messages.id, m.id));

    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (!updated) { reply.code(404); return { error: "not found" }; }
    io.to(`room:${m.roomId}`).emit("message:update", toWire(updated));
    // Mod Log: only when a moderator acts on someone ELSE's topic (an author
    // locking their own thread isn't moderation).
    if (m.userId !== me.id) {
      await auditForumTopic(db, me.id, m.roomId, m.id, "forum_topic_lock", { locked: parsed.locked, title: m.title ?? null }, m.userId);
    }
    return { ok: true };
  });

  /**
   * Pin or unpin a forum topic (admin-only). Sticky topics float to
   * the top of their category section regardless of `lastActivityAt`
   * ordering and stay loaded on every page of `/rooms/:id/topics`.
   * Mods can lock/delete but NOT pin, pinning is a persistent
   * room-furniture decision reserved for site admins.
   *
   * Same shape as the lock route: forum rooms only, topics only,
   * non-deleted only, `{ sticky: boolean }` body.
   */
  const stickyBody = z.object({ sticky: z.boolean() }).strict();
  app.patch<{ Params: { id: string }; Body: unknown }>("/messages/:id/sticky", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let parsed;
    try { parsed = stickyBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m) { reply.code(404); return { error: "not found" }; }
    // Sitewide pin permission (admins), OR — on a forum board — the forum
    // owner / a Forum Moderator (stickies are the matrix's topic-level
    // furniture; mods CAN sticky, including the owner's topics).
    if (!(await hasPermission(me, "pin_forum_topic", db))) {
      const board = await boardModTier(db, me, m.roomId);
      if (!boardCan(board, "pin_topics")) { reply.code(403); return { error: "admins only" }; }
    }
    if (m.deletedAt) { reply.code(410); return { error: "already removed" }; }
    if (m.replyToId) { reply.code(400); return { error: "Only top-level topics can be pinned." }; }

    const forum = await isForumMessage(db, m.roomId);
    if (!forum) { reply.code(400); return { error: "Pinning applies only to forum-mode rooms." }; }

    await db
      .update(messages)
      .set({ isSticky: parsed.sticky })
      .where(eq(messages.id, m.id));

    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (!updated) { reply.code(404); return { error: "not found" }; }
    io.to(`room:${m.roomId}`).emit("message:update", toWire(updated));
    await auditForumTopic(db, me.id, m.roomId, m.id, "forum_topic_sticky", { sticky: parsed.sticky, title: m.title ?? null }, m.userId);
    return { ok: true };
  });

  /**
   * Move a forum topic to a different category (or to Uncategorized with
   * `categoryId: null`). Mods/admins only — recategorizing is a curation
   * lever, not an authoring one, so the topic author does NOT get it by
   * default; it reuses the `lock_forum_topic` permission (the general
   * "can moderate forum topics" capability) plus the forum-board
   * owner/Forum-Moderator tier.
   *
   * Same guards as lock/sticky: forum room only, top-level topic only,
   * non-deleted only. A non-null target category must belong to the
   * topic's own room (you can't fling a topic into another board).
   */
  const categoryBody = z.object({ categoryId: z.string().min(1).nullable() }).strict();
  app.patch<{ Params: { id: string }; Body: unknown }>("/messages/:id/category", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let parsed;
    try { parsed = categoryBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m) { reply.code(404); return { error: "not found" }; }
    if (m.deletedAt) { reply.code(410); return { error: "already removed" }; }
    if (m.replyToId) { reply.code(400); return { error: "Only top-level topics can be moved." }; }

    const forum = await isForumMessage(db, m.roomId);
    if (!forum) { reply.code(400); return { error: "Moving applies only to forum-mode rooms." }; }

    if (!(await hasPermission(me, "lock_forum_topic", db))) {
      const board = await boardModTier(db, me, m.roomId);
      if (!boardCan(board, "move_topics")) { reply.code(403); return { error: "mods only" }; }
    }

    // A non-null target must be a real category in this same room.
    if (parsed.categoryId) {
      const cat = (await db
        .select()
        .from(roomThreadCategories)
        .where(and(eq(roomThreadCategories.id, parsed.categoryId), eq(roomThreadCategories.roomId, m.roomId)))
        .limit(1))[0];
      if (!cat) { reply.code(400); return { error: "That category does not exist in this board." }; }
    }

    await db
      .update(messages)
      .set({ threadCategoryId: parsed.categoryId })
      .where(eq(messages.id, m.id));

    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (!updated) { reply.code(404); return { error: "not found" }; }
    io.to(`room:${m.roomId}`).emit("message:update", toWire(updated));
    await auditForumTopic(db, me.id, m.roomId, m.id, "forum_topic_move", { from: m.threadCategoryId ?? null, to: parsed.categoryId, title: m.title ?? null }, m.userId);
    return { ok: true };
  });

  /**
   * PATCH /messages/:id/prefix — set or clear a forum topic's prefix.
   * Allowed for the topic author OR a mod holding `manage_prefixes`. The
   * prefix must belong to the topic's own forum. `prefixId: null` clears it.
   */
  const prefixBody = z.object({ prefixId: z.string().min(1).nullable() }).strict();
  app.patch<{ Params: { id: string }; Body: unknown }>("/messages/:id/prefix", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let parsed: z.infer<typeof prefixBody>;
    try { parsed = prefixBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m || m.deletedAt) { reply.code(404); return { error: "not found" }; }
    if (m.replyToId) { reply.code(400); return { error: "Only topics carry a prefix." }; }
    const room = (await db.select({ forumId: rooms.forumId }).from(rooms).where(eq(rooms.id, m.roomId)).limit(1))[0];
    if (!room?.forumId) { reply.code(400); return { error: "Prefixes apply only to forum topics." }; }
    // Author may tag their own topic; otherwise needs the manage_prefixes grant.
    // We resolve the grant up front because staff-only tags are manager-gated
    // even for the author (see below).
    const isManager = boardCan(await boardModTier(db, me, m.roomId), "manage_prefixes");
    if (m.userId !== me.id && !isManager) { reply.code(403); return { error: "not yours" }; }
    const { forumPrefixes } = await import("../db/schema.js");
    // A staff-only tag already ON the topic can only be changed or cleared by a
    // manager — an author can't quietly drop the keeper's "Announcement".
    if (m.prefixId && !isManager) {
      const cur = (await db.select({ staffOnly: forumPrefixes.staffOnly }).from(forumPrefixes)
        .where(eq(forumPrefixes.id, m.prefixId)).limit(1))[0];
      if (cur?.staffOnly) { reply.code(403); return { error: "Only staff can change this topic's tag." }; }
    }
    // A non-null prefix must belong to THIS forum AND be offered in the
    // topic's category (global tags apply everywhere; scoped tags only in
    // their listed categories). Author and mod alike respect the scope. A
    // staff-only tag additionally requires the manage_prefixes grant to apply.
    if (parsed.prefixId) {
      const { parsePrefixCategoryIds, prefixAppliesToCategory } = await import("@thekeep/shared");
      const pref = (await db.select({ id: forumPrefixes.id, categoryIdsJson: forumPrefixes.categoryIdsJson, staffOnly: forumPrefixes.staffOnly }).from(forumPrefixes)
        .where(and(eq(forumPrefixes.id, parsed.prefixId), eq(forumPrefixes.forumId, room.forumId))).limit(1))[0];
      if (!pref) { reply.code(400); return { error: "That prefix isn't in this forum." }; }
      if (pref.staffOnly && !isManager) { reply.code(403); return { error: "That tag can only be set by staff." }; }
      if (!prefixAppliesToCategory({ categoryIds: parsePrefixCategoryIds(pref.categoryIdsJson) }, m.threadCategoryId ?? null)) {
        reply.code(400); return { error: "That tag isn't available in this topic's category." };
      }
    }
    await db.update(messages).set({ prefixId: parsed.prefixId }).where(eq(messages.id, m.id));
    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (updated) io.to(`room:${m.roomId}`).emit("message:update", toWire(updated));
    return { ok: true };
  });

  /** Shared move/merge permission check: the sitewide forum-topic permission
   *  OR the `move_topics` grant on the topic's own board. Returns true when
   *  allowed. */
  async function canMoveTopics(meUser: { id: string; role: Role }, roomId: string): Promise<boolean> {
    if (await hasPermission(meUser, "lock_forum_topic", db)) return true;
    return boardCan(await boardModTier(db, meUser, roomId), "move_topics");
  }

  /**
   * POST /messages/:id/move-to-board — move a whole topic (header + every
   * reply) to a DIFFERENT board in the SAME forum, optionally dropping it
   * into a category there. Needs `move_topics`. Cross-FORUM moves are
   * refused (a topic can't leave its forum). Replies follow the header.
   */
  const moveBoardBody = z.object({
    boardRoomId: z.string().min(1),
    categoryId: z.string().min(1).nullable().optional(),
  }).strict();
  app.post<{ Params: { id: string }; Body: unknown }>("/messages/:id/move-to-board", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let parsed: z.infer<typeof moveBoardBody>;
    try { parsed = moveBoardBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m || m.deletedAt) { reply.code(404); return { error: "not found" }; }
    if (m.replyToId) { reply.code(400); return { error: "Only top-level topics can be moved." }; }
    const srcRoom = (await db.select({ forumId: rooms.forumId }).from(rooms).where(eq(rooms.id, m.roomId)).limit(1))[0];
    if (!srcRoom?.forumId) { reply.code(400); return { error: "Moving applies only to forum boards." }; }
    const tgtRoom = (await db.select({ id: rooms.id, forumId: rooms.forumId }).from(rooms).where(eq(rooms.id, parsed.boardRoomId)).limit(1))[0];
    if (!tgtRoom?.forumId) { reply.code(404); return { error: "That board doesn't exist." }; }
    if (tgtRoom.forumId !== srcRoom.forumId) { reply.code(400); return { error: "You can only move a topic between boards in the same forum." }; }
    if (tgtRoom.id === m.roomId) { reply.code(400); return { error: "That topic is already on this board." }; }
    if (!(await canMoveTopics(me, m.roomId))) { reply.code(403); return { error: "mods only" }; }
    // A non-null target category must belong to the TARGET board.
    if (parsed.categoryId) {
      const cat = (await db.select({ id: roomThreadCategories.id }).from(roomThreadCategories)
        .where(and(eq(roomThreadCategories.id, parsed.categoryId), eq(roomThreadCategories.roomId, tgtRoom.id))).limit(1))[0];
      if (!cat) { reply.code(400); return { error: "That category isn't on the destination board." }; }
    }
    const oldRoomId = m.roomId;
    await db.update(messages).set({ roomId: tgtRoom.id, threadCategoryId: parsed.categoryId ?? null }).where(eq(messages.id, m.id));
    // Re-home the replies (matched by the OLD room so we don't catch unrelated rows).
    await db.update(messages).set({ roomId: tgtRoom.id }).where(and(eq(messages.replyToId, m.id), eq(messages.roomId, oldRoomId)));
    await auditForumTopic(db, me.id, tgtRoom.id, m.id, "forum_topic_move", { toBoard: tgtRoom.id, fromBoard: oldRoomId, title: m.title ?? null }, m.userId);
    return { ok: true };
  });

  /**
   * POST /messages/:id/merge-into — merge THIS topic into another topic in
   * the same forum. Non-destructive: this topic's replies become replies of
   * the target, and this topic's header becomes a plain reply (its title is
   * dropped, its sticky/lock cleared). The target's last-activity is
   * recomputed so it floats correctly. Needs `move_topics`.
   */
  const mergeBody = z.object({ targetTopicId: z.string().min(1) }).strict();
  app.post<{ Params: { id: string }; Body: unknown }>("/messages/:id/merge-into", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let parsed: z.infer<typeof mergeBody>;
    try { parsed = mergeBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const src = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!src || src.deletedAt) { reply.code(404); return { error: "not found" }; }
    if (src.replyToId) { reply.code(400); return { error: "Only a top-level topic can be merged." }; }
    if (parsed.targetTopicId === src.id) { reply.code(400); return { error: "A topic can't merge into itself." }; }
    const tgt = (await db.select().from(messages).where(eq(messages.id, parsed.targetTopicId)).limit(1))[0];
    if (!tgt || tgt.deletedAt || tgt.replyToId) { reply.code(400); return { error: "The destination must be a live topic." }; }
    const srcRoom = (await db.select({ forumId: rooms.forumId }).from(rooms).where(eq(rooms.id, src.roomId)).limit(1))[0];
    const tgtRoom = (await db.select({ forumId: rooms.forumId }).from(rooms).where(eq(rooms.id, tgt.roomId)).limit(1))[0];
    if (!srcRoom?.forumId || srcRoom.forumId !== tgtRoom?.forumId) { reply.code(400); return { error: "Both topics must be in the same forum." }; }
    if (!(await canMoveTopics(me, src.roomId))) { reply.code(403); return { error: "mods only" }; }

    const oldRoomId = src.roomId;
    // Source's replies → replies of the target, in the target's room.
    await db.update(messages).set({ replyToId: tgt.id, roomId: tgt.roomId })
      .where(and(eq(messages.replyToId, src.id), eq(messages.roomId, oldRoomId)));
    // Source header → a plain reply of the target (drop topic-only fields).
    await db.update(messages).set({
      replyToId: tgt.id, roomId: tgt.roomId, title: null,
      threadCategoryId: tgt.threadCategoryId, isSticky: false, lockedAt: null,
    }).where(eq(messages.id, src.id));
    // Recompute the target's last-activity across its (now larger) thread.
    const latest = (await db
      .select({ mx: sql<number>`max(${messages.createdAt})` })
      .from(messages)
      .where(or(eq(messages.id, tgt.id), eq(messages.replyToId, tgt.id))))[0];
    if (latest?.mx) {
      await db.update(messages).set({ lastActivityAt: new Date(Number(latest.mx)) }).where(eq(messages.id, tgt.id));
    }
    await auditForumTopic(db, me.id, tgt.roomId, tgt.id, "forum_topic_move", { mergedFrom: src.id, mergedTitle: src.title ?? null, title: tgt.title ?? null }, src.userId);
    return { ok: true };
  });

  /**
   * DELETE /messages/:id/link-preview — the author removes the unfurled
   * card from their own message (Discord's ✕). Writes a {"hidden":true}
   * tombstone (so a late/re-run unfurl can't resurrect it) and
   * broadcasts the refreshed row; the card disappears for everyone.
   */
  app.delete<{ Params: { id: string } }>("/messages/:id/link-preview", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m) { reply.code(404); return { error: "not found" }; }
    if (m.userId !== me.id) { reply.code(403); return { error: "Only the author can remove their link preview." }; }
    await db
      .update(messages)
      .set({ linkPreviewJson: JSON.stringify({ hidden: true }) })
      .where(eq(messages.id, m.id));
    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (updated) io.to(`room:${m.roomId}`).emit("message:update", toWire(updated));
    return { ok: true };
  });
}
