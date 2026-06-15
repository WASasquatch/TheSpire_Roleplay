import type { FastifyInstance } from "fastify";
import { hasPermission } from "../auth/permissions.js";
import type { Role } from "@thekeep/shared";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Server as IoServer } from "socket.io";
import type {
  ChatMessage,
  ClientToServerEvents,
  ServerToClientEvents,
} from "@thekeep/shared";
import { mentionsField } from "@thekeep/shared";
import { messages, rooms, users } from "../db/schema.js";
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
): Promise<{ tier: "owner" | "mod" | null; forumOwnerUserId: string } | null> {
  const room = (await db.select({ forumId: rooms.forumId }).from(rooms)
    .where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room?.forumId) return null;
  const { forumAuthority } = await import("../forums/authority.js");
  const a = await forumAuthority(db, user, room.forumId);
  if (!a.forum) return null;
  return {
    tier: a.isOwner ? "owner" : a.isMod ? "mod" : null,
    forumOwnerUserId: a.forum.ownerUserId,
  };
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
    ...(m.threadCategoryId ? { threadCategoryId: m.threadCategoryId } : {}),
    ...(m.title ? { title: m.title } : {}),
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
      // Forum boards: the owner may edit anything; a Forum Moderator may
      // edit anything EXCEPT the owner's own posts (powers matrix).
      const board = await boardModTier(db, me, m.roomId);
      const boardOk = board?.tier === "owner"
        || (board?.tier === "mod" && m.userId !== board.forumOwnerUserId);
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
      // Forum boards: owner deletes anything; a Forum Moderator deletes
      // anything EXCEPT owner-authored content (powers matrix).
      const board = await boardModTier(db, me, m.roomId);
      const boardOk = board?.tier === "owner"
        || (board?.tier === "mod" && m.userId !== board.forumOwnerUserId);
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
      if (!board?.tier) { reply.code(403); return { error: "not yours" }; }
    }

    const lockedAt = parsed.locked ? new Date() : null;
    await db
      .update(messages)
      .set({ lockedAt })
      .where(eq(messages.id, m.id));

    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (!updated) { reply.code(404); return { error: "not found" }; }
    io.to(`room:${m.roomId}`).emit("message:update", toWire(updated));
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
      if (!board?.tier) { reply.code(403); return { error: "admins only" }; }
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
