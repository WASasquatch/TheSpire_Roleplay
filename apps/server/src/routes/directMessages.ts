import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  ClientToServerEvents,
  DirectConversationSummary,
  DirectMessage,
  DirectMessageHistoryPage,
  ServerToClientEvents,
} from "@thekeep/shared";
import {
  characters,
  directConversationReads,
  directConversations,
  directMessages,
  ignores,
  users,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";
import { pushToUser } from "../push.js";
import { userIsOnline } from "../realtime/broadcast.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/* =========================================================
 *  Constants & schemas
 * ========================================================= */

/** Hard cap on body length. Mirrors the room-message cap. */
const MAX_BODY = 4000;
/** Edit/delete grace window. Mirrors `messages` grace in routes/messages.ts. */
const GRACE_MS = 60_000;
/** Page size for history fetches; capped to keep responses bounded. */
const MAX_PAGE_SIZE = 100;
/** Preview length surfaced on the conversation list. */
const PREVIEW_LEN = 120;

const sendBody = z.object({
  body: z.string().min(1).max(MAX_BODY),
}).strict();

const editBody = z.object({
  body: z.string().min(1).max(MAX_BODY),
}).strict();

const readBody = z.object({
  upTo: z.number().int().nonnegative(),
}).strict();

const prefsBody = z.object({
  dmsEnabled: z.boolean(),
}).strict();

const historyQuery = z.object({
  before: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
}).strict();

/* =========================================================
 *  Helpers
 * ========================================================= */

/**
 * Canonical pair ordering. Conversations store the lexicographically
 * smaller user id in `user_a_id`. The unique index then guarantees
 * one conversation per pair regardless of who initiated.
 */
function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function rowToWire(m: typeof directMessages.$inferSelect): DirectMessage {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderUserId,
    displayName: m.displayName,
    avatarUrl: m.avatarUrl,
    // Soft-deleted: blank the body at the wire layer. The DB still
    // has the row so a moderator response to a report can attach
    // the original body via the snapshot path (Phase 5), but a
    // routine fetch never sees it.
    body: m.deletedAt ? "" : m.body,
    editedAt: m.editedAt ? +m.editedAt : null,
    deletedAt: m.deletedAt ? +m.deletedAt : null,
    createdAt: +m.createdAt,
  };
}

/**
 * Find-or-create the conversation for a given pair. Returns the
 * conversation row id. `INSERT ... ON CONFLICT DO NOTHING` plus a
 * follow-up SELECT keeps the operation single-round-trip on the
 * happy path while staying safe under concurrent first-message
 * races (only one INSERT can win the unique index).
 */
async function ensureConversation(db: Db, me: string, other: string): Promise<string> {
  const [aId, bId] = orderPair(me, other);
  const existing = (await db
    .select({ id: directConversations.id })
    .from(directConversations)
    .where(and(eq(directConversations.userAId, aId), eq(directConversations.userBId, bId)))
    .limit(1))[0];
  if (existing) return existing.id;
  const newId = nanoid();
  await db.insert(directConversations).values({
    id: newId,
    userAId: aId,
    userBId: bId,
  }).onConflictDoNothing();
  // Read back in case a concurrent insert won the race.
  const row = (await db
    .select({ id: directConversations.id })
    .from(directConversations)
    .where(and(eq(directConversations.userAId, aId), eq(directConversations.userBId, bId)))
    .limit(1))[0];
  return row?.id ?? newId;
}

/**
 * Resolve the caller's identity snapshot for an outgoing DM. Mirrors
 * the room-message snapshot logic in addMessage: prefer the active
 * character's name + avatar so a switch later doesn't rewrite the
 * past, fall back to the master.
 */
async function resolveSenderSnapshot(
  db: Db,
  userId: string,
): Promise<{ displayName: string; avatarUrl: string | null }> {
  const u = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!u) throw new Error(`user not found: ${userId}`);
  if (!u.activeCharacterId) {
    return { displayName: u.username, avatarUrl: u.avatarUrl };
  }
  const c = (await db
    .select()
    .from(characters)
    .where(eq(characters.id, u.activeCharacterId))
    .limit(1))[0];
  if (!c || c.deletedAt) {
    return { displayName: u.username, avatarUrl: u.avatarUrl };
  }
  return { displayName: c.name, avatarUrl: c.avatarUrl ?? u.avatarUrl };
}

/**
 * Authorize the caller against a conversation. Returns the row when
 * the caller is a participant; null otherwise. Routes turn the null
 * case into a 404 (NOT 403) so non-participants can't even probe
 * conversation existence.
 */
async function loadParticipantConversation(
  db: Db,
  conversationId: string,
  userId: string,
): Promise<typeof directConversations.$inferSelect | null> {
  const c = (await db
    .select()
    .from(directConversations)
    .where(eq(directConversations.id, conversationId))
    .limit(1))[0];
  if (!c) return null;
  if (c.userAId !== userId && c.userBId !== userId) return null;
  return c;
}

/**
 * Fan a DM out to every live socket of every participant. Honors
 * the recipient's ignore list: a DM from a sender the recipient
 * has ignored still lands in the sender's own sockets (so they
 * see what they sent) but is silently dropped to the recipient.
 */
async function emitDmNew(
  io: Io,
  db: Db,
  msg: DirectMessage,
  conversation: typeof directConversations.$inferSelect,
): Promise<void> {
  const otherUserId = conversation.userAId === msg.senderId
    ? conversation.userBId
    : conversation.userAId;
  // Ignore-honor: if the recipient has the sender on their ignore
  // list, drop the deliveries to the recipient's sockets. Same
  // one-sided posture whispers use.
  const blocked = (await db
    .select()
    .from(ignores)
    .where(and(eq(ignores.userId, otherUserId), eq(ignores.ignoredUserId, msg.senderId)))
    .limit(1))[0];
  const sockets = await io.fetchSockets();
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid === msg.senderId) {
      s.emit("dm:new", { message: msg, conversationId: conversation.id });
    } else if (!blocked && uid === otherUserId) {
      s.emit("dm:new", { message: msg, conversationId: conversation.id });
    }
  }
}

/* =========================================================
 *  Route registration
 * ========================================================= */

export async function registerDirectMessageRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /* ---------- List conversations ---------- */
  app.get("/me/dms", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    // Pull every conversation where the caller is on either side,
    // ordered by recency. The join climb to users / characters and
    // the per-conversation unread tally is done in TS so we keep
    // the SQL straightforward and portable.
    const rows = await db
      .select()
      .from(directConversations)
      .where(sql`${directConversations.userAId} = ${me.id} OR ${directConversations.userBId} = ${me.id}`)
      .orderBy(desc(directConversations.lastMessageAt));

    if (rows.length === 0) return { conversations: [] };

    // Resolve every other-party identity in one batched user/char
    // lookup. Same pattern as currentOccupants in broadcast.ts.
    const otherIds = rows.map((r) => (r.userAId === me.id ? r.userBId : r.userAId));
    const uniqueOtherIds = [...new Set(otherIds)];
    const userRows = await db
      .select()
      .from(users)
      .where(sql`${users.id} IN (${sql.join(uniqueOtherIds.map((u) => sql`${u}`), sql`, `)})`);
    const charIds = userRows.map((u) => u.activeCharacterId).filter((v): v is string => !!v);
    const charRows = charIds.length
      ? await db
          .select()
          .from(characters)
          .where(sql`${characters.id} IN (${sql.join(charIds.map((c) => sql`${c}`), sql`, `)})`)
      : [];
    const userById = new Map(userRows.map((u) => [u.id, u]));
    const charById = new Map(charRows.map((c) => [c.id, c]));

    // Per-conversation last preview + unread count. Two narrow
    // queries scoped by ids instead of N round-trips.
    const convIds = rows.map((r) => r.id);
    const lastRows = convIds.length
      ? await db
          .select({
            conversationId: directMessages.conversationId,
            body: directMessages.body,
            deletedAt: directMessages.deletedAt,
            createdAt: directMessages.createdAt,
          })
          .from(directMessages)
          .where(sql`${directMessages.conversationId} IN (${sql.join(convIds.map((c) => sql`${c}`), sql`, `)})`)
          .orderBy(desc(directMessages.createdAt))
      : [];
    const lastByConv = new Map<string, { body: string; deletedAt: Date | null; createdAt: Date }>();
    for (const r of lastRows) {
      // The first row per conversation in this DESC list is the
      // most recent one; .has() skips overwrites.
      if (lastByConv.has(r.conversationId)) continue;
      lastByConv.set(r.conversationId, {
        body: r.body,
        deletedAt: r.deletedAt,
        createdAt: r.createdAt,
      });
    }
    const readRows = await db
      .select()
      .from(directConversationReads)
      .where(eq(directConversationReads.userId, me.id));
    const lastReadByConv = new Map<string, number>();
    for (const r of readRows) {
      lastReadByConv.set(r.conversationId, +r.lastReadAt);
    }
    // Unread = messages in this conversation, from the OTHER party,
    // with created_at > my last_read_at. One scan keyed on the same
    // shape the index covers.
    const unreadByConv = new Map<string, number>();
    for (const conv of rows) {
      const otherId = conv.userAId === me.id ? conv.userBId : conv.userAId;
      const since = lastReadByConv.get(conv.id) ?? 0;
      const sinceDate = new Date(since);
      const r = (await db
        .select({ n: sql<number>`count(*)` })
        .from(directMessages)
        .where(and(
          eq(directMessages.conversationId, conv.id),
          eq(directMessages.senderUserId, otherId),
          gt(directMessages.createdAt, sinceDate),
        )))[0];
      unreadByConv.set(conv.id, r?.n ?? 0);
    }

    // Online state — one socket-list scan, build a Set of online
    // user ids, look up per row.
    const allSockets = await io.fetchSockets();
    const online = new Set<string>();
    for (const s of allSockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid) online.add(uid);
    }

    const summaries: DirectConversationSummary[] = rows.map((r) => {
      const otherId = r.userAId === me.id ? r.userBId : r.userAId;
      const u = userById.get(otherId)!;
      const c = u.activeCharacterId ? charById.get(u.activeCharacterId) : undefined;
      const usingChar = !!(c && !c.deletedAt);
      const last = lastByConv.get(r.id);
      let preview: string | null = null;
      if (last) {
        if (last.deletedAt) {
          preview = "[message removed]";
        } else {
          const body = last.body.replace(/\s+/g, " ").trim();
          preview = body.length > PREVIEW_LEN ? body.slice(0, PREVIEW_LEN - 1) + "…" : body;
        }
      }
      return {
        id: r.id,
        otherUserId: otherId,
        otherUsername: u.username,
        otherDisplayName: usingChar ? c!.name : u.username,
        otherAvatarUrl: usingChar ? (c!.avatarUrl ?? u.avatarUrl ?? null) : (u.avatarUrl ?? null),
        otherOnline: online.has(otherId),
        lastMessageAt: +r.lastMessageAt,
        lastMessagePreview: preview,
        unreadCount: unreadByConv.get(r.id) ?? 0,
      };
    });

    return { conversations: summaries };
  });

  /* ---------- Read history ---------- */
  app.get<{ Params: { conversationId: string }; Querystring: Record<string, string> }>(
    "/me/dms/:conversationId/messages",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const conv = await loadParticipantConversation(db, req.params.conversationId, me.id);
      if (!conv) { reply.code(404); return { error: "not found" }; }
      const q = historyQuery.safeParse(req.query);
      const before = q.success ? q.data.before : undefined;
      const limit = (q.success ? q.data.limit : undefined) ?? 50;
      // `before` filters strictly less than the provided ms timestamp
      // so the client can paginate older windows by passing the
      // oldest currentAt it's already seen. Overfetch by one to
      // detect hasMore without a separate count query.
      const conds = [eq(directMessages.conversationId, conv.id)];
      if (before !== undefined) conds.push(lt(directMessages.createdAt, new Date(before)));
      const rows = await db
        .select()
        .from(directMessages)
        .where(and(...conds))
        .orderBy(desc(directMessages.createdAt))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const window = hasMore ? rows.slice(0, limit) : rows;
      // Reverse so the client gets oldest → newest within the page.
      const messages = window.reverse().map(rowToWire);
      const payload: DirectMessageHistoryPage = { messages, hasMore };
      return payload;
    },
  );

  /* ---------- Send to a specific user ---------- */
  app.post<{ Params: { targetUserId: string }; Body: unknown }>(
    "/me/dms/with/:targetUserId/messages",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      if (req.params.targetUserId === me.id) {
        reply.code(400);
        return { error: "cannot dm yourself" };
      }
      let body;
      try { body = sendBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      // Target gates: must exist, not be disabled, must have DMs
      // enabled. The "dms_disabled" code is what the client uses
      // to decide whether to render a friendly "this user has
      // DMs turned off" hint vs a generic error.
      const target = (await db.select().from(users).where(eq(users.id, req.params.targetUserId)).limit(1))[0];
      if (!target || target.disabledAt) { reply.code(404); return { error: "no user" }; }
      if (!target.dmsEnabled) { reply.code(403); return { error: "dms_disabled" }; }
      // Disallow if SENDER has the target on their ignore list — you
      // can't DM someone you've explicitly ignored.
      const senderIgnores = (await db
        .select()
        .from(ignores)
        .where(and(eq(ignores.userId, me.id), eq(ignores.ignoredUserId, target.id)))
        .limit(1))[0];
      if (senderIgnores) { reply.code(403); return { error: "ignored_by_sender" }; }

      const conversationId = await ensureConversation(db, me.id, target.id);
      const snapshot = await resolveSenderSnapshot(db, me.id);
      const newId = nanoid();
      const now = new Date();
      await db.insert(directMessages).values({
        id: newId,
        conversationId,
        senderUserId: me.id,
        displayName: snapshot.displayName,
        avatarUrl: snapshot.avatarUrl,
        body: body.body,
      });
      await db
        .update(directConversations)
        .set({ lastMessageAt: now })
        .where(eq(directConversations.id, conversationId));

      const row = (await db.select().from(directMessages).where(eq(directMessages.id, newId)).limit(1))[0]!;
      const wire = rowToWire(row);
      const conv = (await db.select().from(directConversations).where(eq(directConversations.id, conversationId)).limit(1))[0]!;
      await emitDmNew(io, db, wire, conv);
      // Offline-recipient push. Privacy contract: generic copy only.
      try {
        const recipientOnline = await userIsOnline(io, target.id);
        if (!recipientOnline) {
          await pushToUser(db, target.id, {
            title: `Direct message from ${snapshot.displayName}`,
            body: "You have a new direct message.",
            tag: `dm-${me.id}`,
          });
        }
      } catch { /* push is best-effort */ }

      reply.code(201);
      return { message: wire, conversationId };
    },
  );

  /* ---------- Edit own message (grace window) ---------- */
  app.patch<{ Params: { messageId: string }; Body: unknown }>(
    "/me/dms/messages/:messageId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      let body;
      try { body = editBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const msg = (await db.select().from(directMessages).where(eq(directMessages.id, req.params.messageId)).limit(1))[0];
      if (!msg) { reply.code(404); return { error: "not found" }; }
      if (msg.senderUserId !== me.id) { reply.code(403); return { error: "not yours" }; }
      if (msg.deletedAt) { reply.code(410); return { error: "deleted" }; }
      if (Date.now() - +msg.createdAt > GRACE_MS) {
        reply.code(409);
        return { error: "edit window expired" };
      }
      await db
        .update(directMessages)
        .set({ body: body.body, editedAt: new Date() })
        .where(eq(directMessages.id, msg.id));
      const updated = (await db.select().from(directMessages).where(eq(directMessages.id, msg.id)).limit(1))[0]!;
      const wire = rowToWire(updated);
      const conv = (await db.select().from(directConversations).where(eq(directConversations.id, msg.conversationId)).limit(1))[0]!;
      // dm:update fan-out: same recipients as dm:new (both
      // participants' live sockets). Ignore filter doesn't apply on
      // updates — if the recipient is ignored they wouldn't have
      // seen the original either, so the update is harmless.
      const sockets = await io.fetchSockets();
      for (const s of sockets) {
        const uid = (s.data as { userId?: string }).userId;
        if (uid === conv.userAId || uid === conv.userBId) {
          s.emit("dm:update", { message: wire, conversationId: conv.id });
        }
      }
      return { message: wire };
    },
  );

  /* ---------- Soft-delete own message ---------- */
  app.delete<{ Params: { messageId: string } }>(
    "/me/dms/messages/:messageId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const msg = (await db.select().from(directMessages).where(eq(directMessages.id, req.params.messageId)).limit(1))[0];
      if (!msg) { reply.code(404); return { error: "not found" }; }
      if (msg.senderUserId !== me.id) { reply.code(403); return { error: "not yours" }; }
      if (Date.now() - +msg.createdAt > GRACE_MS) {
        reply.code(409);
        return { error: "delete window expired" };
      }
      await db
        .update(directMessages)
        .set({ deletedAt: new Date() })
        .where(eq(directMessages.id, msg.id));
      const updated = (await db.select().from(directMessages).where(eq(directMessages.id, msg.id)).limit(1))[0]!;
      const wire = rowToWire(updated);
      const conv = (await db.select().from(directConversations).where(eq(directConversations.id, msg.conversationId)).limit(1))[0]!;
      const sockets = await io.fetchSockets();
      for (const s of sockets) {
        const uid = (s.data as { userId?: string }).userId;
        if (uid === conv.userAId || uid === conv.userBId) {
          s.emit("dm:update", { message: wire, conversationId: conv.id });
        }
      }
      return { ok: true };
    },
  );

  /* ---------- Mark conversation read up to a point ---------- */
  app.post<{ Params: { conversationId: string }; Body: unknown }>(
    "/me/dms/:conversationId/read",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const conv = await loadParticipantConversation(db, req.params.conversationId, me.id);
      if (!conv) { reply.code(404); return { error: "not found" }; }
      let body;
      try { body = readBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const readAt = new Date(body.upTo);
      // Upsert: SQLite supports ON CONFLICT for primary keys.
      await db
        .insert(directConversationReads)
        .values({ conversationId: conv.id, userId: me.id, lastReadAt: readAt })
        .onConflictDoUpdate({
          target: [directConversationReads.conversationId, directConversationReads.userId],
          set: { lastReadAt: readAt },
        });
      // Tell the OTHER party's sockets the seen-marker advanced so
      // their UI can render "seen" indicators without polling.
      const otherUserId = conv.userAId === me.id ? conv.userBId : conv.userAId;
      const sockets = await io.fetchSockets();
      for (const s of sockets) {
        const uid = (s.data as { userId?: string }).userId;
        if (uid === otherUserId) {
          s.emit("dm:read", {
            conversationId: conv.id,
            readerUserId: me.id,
            lastReadAt: body.upTo,
          });
        }
      }
      return { ok: true };
    },
  );

  /* ---------- DM preference toggle ---------- */
  app.put<{ Body: unknown }>("/me/dm-preferences", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body;
    try { body = prefsBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    await db.update(users).set({ dmsEnabled: body.dmsEnabled }).where(eq(users.id, me.id));
    return { ok: true, dmsEnabled: body.dmsEnabled };
  });
}
