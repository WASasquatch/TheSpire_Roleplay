import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Bookmark, BookmarkedMessage } from "@thekeep/shared";
import { bookmarks, messages, roomMembers, rooms } from "../db/schema.js";
import { getSessionUser } from "./auth.js";
import type { Db } from "../db/index.js";

const createBody = z.object({
  messageId: z.string().min(1),
  category: z.string().max(60).optional(),
  note: z.string().max(500).nullable().optional(),
}).strict();

const patchBody = z.object({
  category: z.string().max(60).optional(),
  note: z.string().max(500).nullable().optional(),
}).strict();

/**
 * Validate the caller can see (and therefore bookmark) the message:
 *   - Whispers: caller must be sender or recipient.
 *   - Private rooms: caller must be a member of the room.
 *   - Public rooms: anyone authenticated.
 *
 * Returns the message row on success, null on any failure. Failure cases
 * are merged (404 / 403 indistinguishable to the caller) so we don't
 * leak whether a private-room message exists.
 */
async function canCallerSeeMessage(db: Db, userId: string, messageId: string) {
  const m = (await db.select().from(messages).where(eq(messages.id, messageId)).limit(1))[0];
  if (!m) return null;
  if (m.kind === "whisper" && m.userId !== userId && m.toUserId !== userId) return null;
  const room = (await db.select().from(rooms).where(eq(rooms.id, m.roomId)).limit(1))[0];
  if (!room) return null;
  if (room.type === "private") {
    const member = (await db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, userId)))
      .limit(1))[0];
    if (!member) return null;
  }
  return m;
}

/**
 * Per-user bookmarks. CRUD only — the unique index on (user_id, message_id)
 * makes POST idempotent (re-bookmarking the same message updates the
 * existing row's category/note instead of duplicating).
 *
 * Privacy: every write validates the caller can see the underlying
 * message (same gates as joinRoom backlog + search). Reads return only
 * the caller's own rows. Site admins are NOT bypassed — bookmarks are
 * private user state.
 */
export async function registerBookmarkRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get("/me/bookmarks", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    const rows = await db
      .select()
      .from(bookmarks)
      .where(eq(bookmarks.userId, me.id))
      .orderBy(desc(bookmarks.createdAt));
    if (rows.length === 0) return { bookmarks: [] as Bookmark[] };

    // Batch the message + room joins so a user with hundreds of
    // bookmarks doesn't make hundreds of round-trips.
    const msgIds = rows.map((r) => r.messageId);
    const msgRows = msgIds.length
      ? await db.select().from(messages).where(inArray(messages.id, msgIds))
      : [];
    const msgById = new Map(msgRows.map((m) => [m.id, m]));
    const roomIds = [...new Set(msgRows.map((m) => m.roomId))];
    const roomRows = roomIds.length
      ? await db.select().from(rooms).where(inArray(rooms.id, roomIds))
      : [];
    const roomById = new Map(roomRows.map((r) => [r.id, r]));

    const out: Bookmark[] = [];
    for (const r of rows) {
      const m = msgById.get(r.messageId);
      // FK cascade should have removed orphaned bookmarks already, but a
      // race between hard-delete and the next list call could surface
      // one. Skip rather than 500.
      if (!m) continue;
      const room = roomById.get(m.roomId);
      // Whisper privacy: even your own bookmark of a whisper you were
      // a party to renders. If the row exists at all, by induction the
      // caller was a party at bookmark time, and that's still true now
      // (whispers can't change parties post-send).
      const message: BookmarkedMessage = {
        id: m.id,
        roomId: m.roomId,
        roomName: room?.name ?? "(deleted room)",
        displayName: m.displayName,
        kind: m.kind,
        body: m.deletedAt ? "[message removed]" : m.body,
        createdAt: +m.createdAt,
        replyToId: m.replyToId ?? null,
        // Snapshot color + cmd-css so the bookmark preview paints the
        // same way the row reads in chat. `kind: "cmd"` rows especially
        // depend on this — without the css the bookmarked snippet drops
        // back to plain text and an admin-styled command (italic + a
        // theme color) renders inconsistently between the live chat and
        // the bookmarks viewer.
        ...(m.color ? { color: m.color } : {}),
        ...(m.cmdCss ? { cmdCss: m.cmdCss } : {}),
        ...(m.sceneImageUrl ? { sceneImageUrl: m.sceneImageUrl } : {}),
        ...(m.bodyHtml ? { bodyHtml: m.bodyHtml } : {}),
      };
      out.push({
        id: r.id,
        category: r.category,
        note: r.note,
        createdAt: +r.createdAt,
        message,
      });
    }
    return { bookmarks: out };
  });

  app.post<{ Body: unknown }>("/me/bookmarks", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body;
    try { body = createBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

    const m = await canCallerSeeMessage(db, me.id, body.messageId);
    if (!m) { reply.code(404); return { error: "message not found or not visible" }; }

    const category = (body.category ?? "").trim();
    const note = body.note?.trim() || null;

    // Idempotent upsert on the unique (user, message) index — re-bookmarking
    // updates the category/note instead of duplicating.
    const existing = (await db
      .select()
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, me.id), eq(bookmarks.messageId, body.messageId)))
      .limit(1))[0];
    if (existing) {
      await db.update(bookmarks).set({ category, note }).where(eq(bookmarks.id, existing.id));
      return { id: existing.id };
    }
    const id = nanoid();
    await db.insert(bookmarks).values({
      id,
      userId: me.id,
      messageId: body.messageId,
      category,
      note,
    });
    return { id };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/me/bookmarks/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const row = (await db
      .select()
      .from(bookmarks)
      .where(and(eq(bookmarks.id, req.params.id), eq(bookmarks.userId, me.id)))
      .limit(1))[0];
    if (!row) { reply.code(404); return { error: "not found" }; }

    let body;
    try { body = patchBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

    const update: Partial<typeof bookmarks.$inferInsert> = {};
    if (body.category !== undefined) update.category = body.category.trim();
    if (body.note !== undefined) update.note = body.note?.trim() || null;
    if (Object.keys(update).length === 0) return { ok: true };
    await db.update(bookmarks).set(update).where(eq(bookmarks.id, row.id));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/me/bookmarks/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const row = (await db
      .select()
      .from(bookmarks)
      .where(and(eq(bookmarks.id, req.params.id), eq(bookmarks.userId, me.id)))
      .limit(1))[0];
    if (!row) { reply.code(404); return { error: "not found" }; }
    await db.delete(bookmarks).where(eq(bookmarks.id, row.id));
    return { ok: true };
  });
}
