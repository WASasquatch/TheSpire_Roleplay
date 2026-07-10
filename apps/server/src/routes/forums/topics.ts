/**
 * Notification center + topic watches / reads / permalink resolution.
 *
 *   GET  /forums/notifications             inbox (unread + rows)
 *   POST /forums/notifications/read        mark ids / all read
 *   GET  /forums/topics/:topicId/locate    resolve a permalink's coordinates
 *   PUT  /forums/topics/:topicId/watch     subscribe to a topic
 *   DELETE /forums/topics/:topicId/watch   unsubscribe
 *   POST /forums/topics/:topicId/read      stamp a topic-read marker
 */
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { forums, messages, rooms } from "../../db/schema.js";
import type { Db } from "../../db/index.js";
import { getSessionUser } from "../auth.js";
import { tFor } from "../../i18n.js";

export async function registerForumTopicRoutes(app: FastifyInstance, db: Db): Promise<void> {
  /** Resolve a topic id to a live forum topic (board room + title row).
   *  Used by the watch + read endpoints so they can't mark arbitrary
   *  messages. */
  async function resolveForumTopic(topicId: string) {
    const m = (await db.select().from(messages).where(eq(messages.id, topicId)).limit(1))[0];
    if (!m || m.deletedAt || m.replyToId || !m.title) return null;
    const room = (await db.select().from(rooms).where(eq(rooms.id, m.roomId)).limit(1))[0];
    if (!room || !room.forumId) return null;
    return { topic: m, room };
  }

  app.get<{ Querystring: { limit?: string } }>("/forums/notifications", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
    const { listForumNotifications, unreadForumNotifications } = await import("../../forums/notifications.js");
    // Viewer-aware (age plan, Phase 3): a minor's inbox re-filters rows
    // whose topic is CURRENTLY NSFW-tagged, covering "watched, then tagged".
    const rows = await listForumNotifications(db, me.id, limit, me);
    return {
      unread: await unreadForumNotifications(db, me.id, me),
      notifications: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        forumId: n.forumId,
        boardRoomId: n.boardRoomId,
        topicId: n.topicId,
        messageId: n.messageId,
        actorName: n.actorName,
        topicTitle: n.topicTitle,
        snippet: n.snippet,
        forumName: n.forumName ?? null,
        boardName: n.boardName ?? null,
        createdAt: +n.createdAt,
        read: n.readAt != null,
      })),
    };
  });

  const notifReadBody = z.union([
    z.object({ ids: z.array(z.string()).min(1).max(200) }).strict(),
    z.object({ all: z.literal(true) }).strict(),
  ]);
  app.post<{ Body: unknown }>("/forums/notifications/read", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof notifReadBody>;
    try { body = notifReadBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const { markForumNotificationsRead, unreadForumNotifications } = await import("../../forums/notifications.js");
    await markForumNotificationsRead(db, me.id, "all" in body ? "all" : body.ids);
    return { ok: true, unread: await unreadForumNotifications(db, me.id, me) };
  });

  /**
   * Resolve any message id (topic OR reply) to its forum coordinates —
   * { forumId, forumSlug, boardRoomId, topicId } — for permalink
   * navigation (`/f/<slug>/t/<topicId>#p-<postId>`). Anonymous callers
   * are allowed only when the forum has public browsing on.
   */
  app.get<{ Params: { topicId: string } }>("/forums/topics/:topicId/locate", async (req, reply) => {
    const me = await getSessionUser(req, db).catch(() => null);
    const m = (await db.select().from(messages).where(eq(messages.id, req.params.topicId)).limit(1))[0];
    if (!m || m.deletedAt) { reply.code(404); return { error: "not found" }; }
    const room = (await db.select().from(rooms).where(eq(rooms.id, m.roomId)).limit(1))[0];
    if (!room?.forumId) { reply.code(404); return { error: "not found" }; }
    const forum = (await db.select().from(forums).where(eq(forums.id, room.forumId)).limit(1))[0];
    if (!forum) { reply.code(404); return { error: "not found" }; }
    if (!me && !forum.publicBrowsing) { reply.code(401); return { error: "auth" }; }
    // Don't resolve a permalink into a private board/category for someone who
    // can't read it (migration 0239) — that would leak its existence and let
    // the client try (and fail) to open it. Replies inherit their topic's
    // category, so resolve the category off the TOPIC, not the hit.
    const { forumBoardReadGate } = await import("../../forums/authority.js");
    const readGate = await forumBoardReadGate(db, me, room.id);
    const topicId = m.replyToId ?? m.id;
    const topicRow = m.replyToId
      ? (await db.select({ c: messages.threadCategoryId, isNsfw: messages.isNsfw }).from(messages)
          .where(eq(messages.id, topicId)).limit(1))[0]
      : { c: m.threadCategoryId ?? null, isNsfw: m.isNsfw };
    const topicCatId = topicRow?.c ?? null;
    // HARD age gate (age plan, Phase 3): permalinks into an NSFW-tagged
    // topic, an 18+ board (room/server flag), or any board of an 18+ forum
    // resolve only for adults — the thread route 404s everyone else anyway,
    // so refuse the coordinates here instead of bouncing the client.
    const { boardAgeDenied } = await import("../../forums/nsfw.js");
    if (!me?.isAdult && (!!topicRow?.isNsfw || (await boardAgeDenied(db, me, room)))) {
      reply.code(404); return { error: "not found" };
    }
    if (readGate.boardLocked || (topicCatId && readGate.lockedCatIds.has(topicCatId))) {
      reply.code(403);
      return { error: tFor(me?.locale ?? null, "errors:server.forums.membersOnlySection"), code: "FORUM_BOARD_MEMBERS_ONLY" };
    }
    return {
      forumId: forum.id,
      forumSlug: forum.slug,
      boardRoomId: room.id,
      topicId,
    };
  });

  app.put<{ Params: { topicId: string } }>("/forums/topics/:topicId/watch", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const t = await resolveForumTopic(req.params.topicId);
    if (!t) { reply.code(404); return { error: "no such topic" }; }
    // Minors can't watch an NSFW topic (age plan, Phase 3): they can't read
    // it, and the watch would only sit silent behind the notification
    // write-skip. Same "doesn't exist" posture as the thread route.
    if (t.topic.isNsfw && !me.isAdult) { reply.code(404); return { error: "no such topic" }; }
    const { ensureTopicWatch } = await import("../../forums/notifications.js");
    await ensureTopicWatch(db, me.id, t.topic.id);
    return { ok: true };
  });

  app.delete<{ Params: { topicId: string } }>("/forums/topics/:topicId/watch", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const { forumTopicWatches } = await import("../../db/schema.js");
    await db.delete(forumTopicWatches).where(and(
      eq(forumTopicWatches.userId, me.id),
      eq(forumTopicWatches.topicId, req.params.topicId),
    ));
    return { ok: true };
  });

  /** Stamp "viewer read this topic now" — clears its unread marker.
   *  Fire-and-forget from the catalog when a topic is opened. */
  app.post<{ Params: { topicId: string } }>("/forums/topics/:topicId/read", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const { forumTopicReads } = await import("../../db/schema.js");
    const now = new Date();
    await db.insert(forumTopicReads)
      .values({ userId: me.id, topicId: req.params.topicId, lastReadAt: now })
      .onConflictDoUpdate({
        target: [forumTopicReads.userId, forumTopicReads.topicId],
        set: { lastReadAt: now },
      });
    return { ok: true };
  });
}
