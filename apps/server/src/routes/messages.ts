import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Server as IoServer } from "socket.io";
import type {
  ChatMessage,
  ClientToServerEvents,
  ServerToClientEvents,
} from "@thekeep/shared";
import { messages } from "../db/schema.js";
import { sanitizeBio } from "../auth/html.js";
import { getSessionUser } from "./auth.js";
import { getSettings } from "../settings.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/**
 * Edit / delete grace window for the author. After this many ms have passed
 * since the message was created, edits and deletes are rejected. Picked to
 * be long enough for typo fixes and "wait, that wasn't the right window"
 * second thoughts, short enough that long-tail edits can't quietly rewrite
 * established history.
 */
const GRACE_MS = 60_000;

const editBody = z.object({ body: z.string().min(1).max(20_000) }).strict();

function toWire(m: typeof messages.$inferSelect): ChatMessage {
  // Mirrors the row→ChatMessage shape used in broadcast.ts; if either side
  // adds fields, both should be updated. Snapshotted fields stay as-is on
  // edit (mood, npcVoicedBy, replyTo*, etc.) — only `body` and `editedAt`
  // change.
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
    ...(m.editedAt ? { editedAt: +m.editedAt } : {}),
    ...(m.deletedAt ? { deletedAt: +m.deletedAt } : {}),
  };
}

export async function registerMessageRoutes(
  app: FastifyInstance,
  db: Db,
  io: Io,
): Promise<void> {
  /**
   * Edit your own message inside the grace window.
   *
   * Auth: must be the author. Admins are NOT allowed to edit other users'
   * messages here — that's a moderation capability outside this endpoint
   * (intentionally not in scope).
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
    if (m.userId !== me.id) { reply.code(403); return { error: "not yours" }; }
    if (m.deletedAt) { reply.code(410); return { error: "already removed" }; }

    const now = Date.now();
    if (now - +m.createdAt > GRACE_MS) {
      reply.code(403);
      return { error: `Edit window has closed (${Math.round(GRACE_MS / 1000)}s after sending).` };
    }

    // Apply the same length cap as fresh messages so editing isn't a back
    // door around maxMessageLength.
    const { maxMessageLength } = await getSettings(db);
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
   * Soft-delete your own message inside the grace window. Body is stripped
   * server-side from any future emission; the row is retained so reply
   * snapshots and ordering stay coherent.
   */
  app.delete<{ Params: { id: string } }>("/messages/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m) { reply.code(404); return { error: "not found" }; }
    if (m.userId !== me.id) { reply.code(403); return { error: "not yours" }; }
    if (m.deletedAt) { reply.code(410); return { error: "already removed" }; }

    const now = Date.now();
    if (now - +m.createdAt > GRACE_MS) {
      reply.code(403);
      return { error: `Delete window has closed (${Math.round(GRACE_MS / 1000)}s after sending).` };
    }

    const deletedAt = new Date(now);
    // Wipe the body so it never re-emits. The row is kept so reply snippets
    // (which were snapshotted at the moment of the reply) stay coherent
    // and so ordering on backlog is preserved.
    await db
      .update(messages)
      .set({ deletedAt, body: "" })
      .where(eq(messages.id, m.id));

    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (!updated) { reply.code(404); return { error: "not found" }; }
    io.to(`room:${m.roomId}`).emit("message:update", toWire(updated));
    return { ok: true };
  });
}
