import type { FastifyInstance } from "fastify";
import { isAdminRole } from "@thekeep/shared";
import type { Role } from "@thekeep/shared";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Server as IoServer } from "socket.io";
import type {
  ChatMessage,
  ClientToServerEvents,
  ServerToClientEvents,
} from "@thekeep/shared";
import { messages, rooms, users } from "../db/schema.js";
import { sanitizeBio } from "../auth/html.js";
import { getSessionUser } from "./auth.js";
import { getSettings } from "../settings.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

// Edit / delete grace window for chat (flat) rooms is now admin-
// configurable via `siteSettings.editGraceMs`. Each handler below
// reads the current value via `getSettings(db)` so a runtime tweak
// takes effect on the next attempt without restart. Forum rooms
// (replyMode="nested") bypass the cap entirely — posts there are
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

const editBody = z.object({ body: z.string().min(1).max(20_000) }).strict();

function toWire(m: typeof messages.$inferSelect, viewerIsAdmin = false): ChatMessage {
  // Mirrors the row→ChatMessage shape used in broadcast.ts; if either side
  // adds fields, both should be updated. Snapshotted fields stay as-is on
  // edit (mood, npcVoicedBy, replyTo*, etc.) — only `body` and `editedAt`
  // change.
  //
  // Deleted messages: the visible body is stripped to "" for everyone
  // (renderer paints "[message removed]"). Site admins (admin /
  // masteradmin) additionally receive the original body on a separate
  // `originalBody` field so they can audit what got hidden. Mods +
  // room-owner mods + ordinary viewers don't get the field — gate is
  // `viewerIsAdmin`, which the caller computes from `isAdminRole(role)`.
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
    ...(viewerIsAdmin && m.deletedAt ? { originalBody: m.body } : {}),
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
   * `replyToBodySnippet` is *not* rewritten — child snapshots remain frozen
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
    const isAdmin = isAdminRole(me.role);
    if (!isAuthor && !isAdmin) { reply.code(403); return { error: "not yours" }; }
    if (m.deletedAt) { reply.code(410); return { error: "already removed" }; }

    const now = Date.now();
    const forum = await isForumMessage(db, m.roomId);
    // Single settings read covers both gates (edit window + size cap)
    // so we don't pay two getSettings round-trips per edit.
    const { maxMessageLength, editGraceMs } = await getSettings(db);
    // Admins bypass the grace window entirely (a moderation lever for
    // touch-ups requested by an author after the cap has expired).
    if (!isAdmin && !forum && now - +m.createdAt > editGraceMs) {
      reply.code(403);
      return { error: `Edit window has closed (${Math.round(editGraceMs / 1000)}s after sending).` };
    }

    // Apply the same length cap as fresh messages so editing isn't a back
    // door around maxMessageLength.
    const trimmed = body.body.trim();
    if (!trimmed) { reply.code(400); return { error: "empty" }; }
    if (trimmed.length > maxMessageLength) {
      reply.code(413);
      return { error: `Messages capped at ${maxMessageLength} chars.` };
    }

    // Re-sanitise for kinds whose bodies feed renderers that trust them. We
    // don't currently render body via dangerouslySetInnerHTML on the chat
    // line, but be defensive — sanitiseBio is the same routine used for bio
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
    return { ok: true };
  });

  /**
   * Soft-delete a message. Permitted for:
   *   * the author (within 60s in flat rooms, anytime in forum rooms)
   *   * any moderator or admin (no time gate — moderation action)
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
    const isMod = me.role === "mod" || isAdminRole(me.role);
    if (!isAuthor && !isMod) { reply.code(403); return { error: "not yours" }; }
    if (m.deletedAt) { reply.code(410); return { error: "already removed" }; }

    const now = Date.now();
    const forum = await isForumMessage(db, m.roomId);
    // Mods/admins bypass the grace window entirely; authors only get
    // the bypass in forum rooms (and in flat-chat rooms within the
    // admin-configured grace window).
    const { editGraceMs } = await getSettings(db);
    if (!isMod && !forum && now - +m.createdAt > editGraceMs) {
      reply.code(403);
      return { error: `Delete window has closed (${Math.round(editGraceMs / 1000)}s after sending).` };
    }

    const deletedAt = new Date(now);
    await db
      .update(messages)
      .set({ deletedAt })
      .where(eq(messages.id, m.id));

    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (!updated) { reply.code(404); return { error: "not found" }; }
    // Per-socket emit so site admins (admin / masteradmin) receive the
    // original body alongside the deletion marker — they need to see
    // what got hidden in case the author was burying something. Mods,
    // room-owner mods, and ordinary viewers get the bare wire payload
    // (no `originalBody` field). This means the deleted content never
    // crosses the wire to anyone who shouldn't have it.
    const adminWire = toWire(updated, true);
    const plainWire = toWire(updated, false);
    const roomSockets = await io.in(`room:${m.roomId}`).fetchSockets();
    if (roomSockets.length === 0) return { ok: true };
    // Look the viewer roles up in one batch — typical room has ≤ 50
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
      s.emit("message:update", isAdminRole(role as Role) ? adminWire : plainWire);
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
   * rooms — locking a reply or a flat-chat message is a category error
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
    const isMod = me.role === "mod" || isAdminRole(me.role);
    if (!isAuthor && !isMod) { reply.code(403); return { error: "not yours" }; }

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
   * Mods can lock/delete but NOT pin — pinning is a persistent
   * room-furniture decision reserved for site admins.
   *
   * Same shape as the lock route: forum rooms only, topics only,
   * non-deleted only, `{ sticky: boolean }` body.
   */
  const stickyBody = z.object({ sticky: z.boolean() }).strict();
  app.patch<{ Params: { id: string }; Body: unknown }>("/messages/:id/sticky", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!isAdminRole(me.role)) { reply.code(403); return { error: "admins only" }; }

    let parsed;
    try { parsed = stickyBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m) { reply.code(404); return { error: "not found" }; }
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
}
