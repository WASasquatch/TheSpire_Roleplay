import type { FastifyInstance, FastifyRequest } from "fastify";
import { isAdminRole } from "@thekeep/shared";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  ChatMessage,
  ClientToServerEvents,
  MessageSearchHit,
  RoomOccupant,
  RoomSummary,
  ServerToClientEvents,
  ThreadCategory,
} from "@thekeep/shared";
import { ignores, messages, roomMembers, roomThreadCategories, rooms } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";
import { buildRoomSummary, currentOccupants } from "../realtime/broadcast.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

interface RoomWithOccupants extends RoomSummary {
  occupants: RoomOccupant[];
}

/**
 * Returns the navigable room tree for the right-rail sidebar:
 *   - every public room (always visible, even empty), each with its
 *     currently-connected occupants
 *   - the caller's current room if it happens to be private (so they can see
 *     the people they're whispering with)
 *
 * Private rooms NEVER appear in this list for callers who aren't in them.
 */
export async function registerRoomsRoutes(
  app: FastifyInstance,
  db: Db,
  io: Io,
): Promise<void> {
  app.get("/rooms", async (req: FastifyRequest) => {
    const me = await getSessionUser(req, db);

    // 1. Pull every public room. Archived rows (auto-parked after the
    //    last occupant left) are excluded so the name appears
    //    available for resurrection on the next create. They still
    //    show up via `findRoomByName` on the create path so a same-
    //    name create reactivates the row instead of erroring on the
    //    unique-name index.
    const publicRows = await db
      .select()
      .from(rooms)
      .where(and(eq(rooms.type, "public"), isNull(rooms.archivedAt)))
      .orderBy(asc(rooms.name));

    // 2. If the caller is logged in, find any private room they're currently
    //    socketed into and include it too. We use the socket-room membership
    //    (not just the DB roomMembers row) so users only see their *active*
    //    private room, not every one they've ever joined.
    let extraPrivate: typeof publicRows = [];
    if (me) {
      const sockets = await io.fetchSockets();
      const privateRoomIds = new Set<string>();
      for (const s of sockets) {
        if ((s.data as { userId?: string }).userId !== me.id) continue;
        for (const r of s.rooms) {
          if (r.startsWith("room:")) privateRoomIds.add(r.slice(5));
        }
      }
      // Subtract public rooms we already have.
      for (const r of publicRows) privateRoomIds.delete(r.id);
      if (privateRoomIds.size) {
        extraPrivate = await db
          .select()
          .from(rooms)
          .where(
            and(eq(rooms.type, "private"), inArray(rooms.id, [...privateRoomIds])),
          );
      }
    }

    const allRooms = [...publicRows, ...extraPrivate];
    if (allRooms.length === 0) return { rooms: [] };

    // Delegate summary + occupant assembly to the shared builders so this
    // route returns the same shape as the websocket `room:state`/
    // `presence:update` events. Without unification, fields like
    // `linkedWorld`/`primaryWorld`/`accountRole`/`mood` were silently
    // missing from /rooms and the rail UI lost half its features.
    const result: RoomWithOccupants[] = await Promise.all(
      allRooms.map(async (r): Promise<RoomWithOccupants> => {
        const summary = await buildRoomSummary(db, r);
        const occupants = (await currentOccupants(io, db, r.id))
          .slice()
          .sort((a, b) => a.displayName.localeCompare(b.displayName));
        return { ...summary, occupants };
      }),
    );

    return { rooms: result };
  });

  /**
   * GET /rooms/:id/messages/search?q=<term>&limit=20
   *
   * Live message search scoped to a single room. Used by the in-rail
   * SearchBar to surface old discussions, especially in nested-mode
   * (forum-style) rooms where conversations persist for days.
   *
   * Privacy gates, in order, fail-closed:
   *   1. Caller must be authenticated.
   *   2. For private rooms: caller must be a member (or owner / site
   *      admin). Non-members get 403 — even seeing whether their query
   *      matches something would be a privacy leak.
   *   3. Whispers are filtered to ones the caller is party to.
   *   4. Soft-deleted messages (`deletedAt` set) are excluded — the
   *      author asked them gone; search shouldn't resurrect.
   *   5. System messages are excluded — they're noise (joins/parts,
   *      "X kicked Y", description blasts) and confuse the result list.
   *
   * Ranking: LIKE-based with a simple frequency score (count of matches
   * in the body) + recency tiebreaker. SQLite FTS5 is a future upgrade
   * once a room outgrows what LIKE handles.
   */
  app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string } }>(
    "/rooms/:id/messages/search",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const q = (req.query.q ?? "").trim();
      if (!q) return { hits: [] as MessageSearchHit[] };
      // Cap limit so an over-aggressive client can't drag back the whole
      // table. 20 is what the UI surfaces; anything more would scroll off
      // the popup anyway.
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? "20", 10) || 20));

      const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
      if (!room) { reply.code(404); return { error: "no room" }; }

      // Private-room membership gate. Site admins are NOT bypassed here
      // — the privacy contract is that admins can't read private room
      // content even via search.
      if (room.type === "private") {
        const member = (await db
          .select()
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, me.id)))
          .limit(1))[0];
        if (!member) { reply.code(403); return { error: "not a member" }; }
      }

      // Build the privacy-filtered candidate set, then rank. The whisper
      // filter is parameterized on the caller's userId so even members
      // of a public room only see their own whisper exchanges.
      const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
      const rows = await db
        .select()
        .from(messages)
        .where(and(
          eq(messages.roomId, room.id),
          isNull(messages.deletedAt),
          sql`${messages.kind} != 'system'`,
          sql`${messages.body} LIKE ${like} ESCAPE '\\'`,
          // Whisper privacy: visible only to sender or recipient.
          or(
            sql`${messages.kind} != 'whisper'`,
            eq(messages.userId, me.id),
            eq(messages.toUserId, me.id),
          ),
        ))
        .orderBy(desc(messages.createdAt))
        .limit(limit * 4); // overfetch so the in-memory rank has options

      // Frequency-based relevance: count occurrences of the query in the
      // body (case-insensitive). Ties broken by recency. The UI displays
      // results in ascending relevance so the most-relevant hit sits
      // closest to the search input — see the SearchBar component.
      const needle = q.toLowerCase();
      const hits = rows.map((m): MessageSearchHit & { _ts: number } => {
        const lc = m.body.toLowerCase();
        let count = 0;
        let idx = 0;
        while ((idx = lc.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
        return {
          id: m.id,
          roomId: m.roomId,
          userId: m.userId,
          displayName: m.displayName,
          kind: m.kind,
          snippet: m.body,
          createdAt: +m.createdAt,
          relevance: count,
          ...(m.replyToId ? { replyToId: m.replyToId } : {}),
          _ts: +m.createdAt,
        };
      });
      hits.sort((a, b) => b.relevance - a.relevance || b._ts - a._ts);
      const trimmed = hits.slice(0, limit).map(({ _ts, ...rest }) => rest);
      return { hits: trimmed };
    },
  );

  /**
   * GET /rooms/:id/messages/around?messageId=<id>&before=20&after=20
   *
   * Returns a window of messages centered on a target so the client can
   * jump from a search hit / bookmark / mention into the middle of room
   * history. Same privacy rules as the search endpoint: room membership,
   * whisper-party filtering, no soft-deleted bodies, no system noise
   * exposed.
   *
   * The shape mirrors `joinRoom`'s `message:bulk` payload so the client
   * can swap its `messagesByRoom[roomId]` buffer wholesale. A "viewing
   * history" indicator is applied client-side based on the request
   * itself, not anything in the response.
   */
  app.get<{
    Params: { id: string };
    Querystring: { messageId?: string; before?: string; after?: string };
  }>("/rooms/:id/messages/around", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const messageId = req.query.messageId;
    if (!messageId) { reply.code(400); return { error: "messageId required" }; }
    const before = Math.min(50, Math.max(0, parseInt(req.query.before ?? "20", 10) || 20));
    const after = Math.min(50, Math.max(0, parseInt(req.query.after ?? "20", 10) || 20));

    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
    if (!room) { reply.code(404); return { error: "no room" }; }
    if (room.type === "private") {
      const member = (await db
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, me.id)))
        .limit(1))[0];
      if (!member) { reply.code(403); return { error: "not a member" }; }
    }

    const target = (await db.select().from(messages).where(eq(messages.id, messageId)).limit(1))[0];
    if (!target || target.roomId !== room.id) {
      reply.code(404);
      return { error: "message not in this room" };
    }
    // If the target itself is whisper-private and the caller isn't a
    // party, we don't surface it (or its context) — same rule the live
    // backlog applies.
    if (target.kind === "whisper" && target.userId !== me.id && target.toUserId !== me.id) {
      reply.code(403);
      return { error: "not your whisper" };
    }

    const whisperFilter = or(
      sql`${messages.kind} != 'whisper'`,
      eq(messages.userId, me.id),
      eq(messages.toUserId, me.id),
    );

    // Pull `before` rows with createdAt <= target (inclusive of target via
    // <= + de-dup below), and `after` rows strictly newer.
    const olderOrEq = await db
      .select()
      .from(messages)
      .where(and(
        eq(messages.roomId, room.id),
        sql`${messages.createdAt} <= ${target.createdAt}`,
        whisperFilter,
      ))
      .orderBy(desc(messages.createdAt))
      .limit(before + 1); // +1 to include the target itself
    const newer = await db
      .select()
      .from(messages)
      .where(and(
        eq(messages.roomId, room.id),
        gt(messages.createdAt, target.createdAt),
        whisperFilter,
      ))
      .orderBy(asc(messages.createdAt))
      .limit(after);

    const window = [...olderOrEq.reverse(), ...newer];

    const wire: ChatMessage[] = window.map((m) => ({
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
    }));
    return { messages: wire };
  });

  /**
   * GET /rooms/:id/messages?before=<createdAt-ms>&limit=<N>
   *
   * Scroll-up pagination for the flat chat history. The initial backlog
   * delivered via `room:join` / `message:bulk` is capped at the most
   * recent 50 lines; this endpoint serves the older window that
   * scrolling past the top edge of the buffer needs. Same privacy /
   * ignore / whisper-party filters as the live backlog so the
   * server-side posture is consistent between "first 50" and "older
   * pages."
   *
   * Returns `{ messages, hasMore }` chronologically oldest → newest
   * within the page so the client can prepend in order. `hasMore` is
   * computed by overfetching one row past the limit so the client
   * doesn't need a separate count round-trip.
   */
  app.get<{
    Params: { id: string };
    Querystring: { before?: string; limit?: string };
  }>("/rooms/:id/messages", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
    if (!room) { reply.code(404); return { error: "no room" }; }
    if (room.type === "private") {
      const member = (await db
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, me.id)))
        .limit(1))[0];
      if (!member) { reply.code(403); return { error: "not a member" }; }
    }
    const before = req.query.before ? parseInt(req.query.before, 10) : NaN;
    if (!Number.isFinite(before) || before <= 0) {
      reply.code(400);
      return { error: "before (ms) required" };
    }
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? "50", 10) || 50));

    // Apply the same ignore filter the live backlog uses so a user
    // they've muted doesn't re-appear when they scroll older.
    const ignoredIds = new Set(
      (await db
        .select({ ignoredUserId: ignores.ignoredUserId })
        .from(ignores)
        .where(eq(ignores.userId, me.id))).map((r) => r.ignoredUserId),
    );
    const whisperFilter = or(
      sql`${messages.kind} != 'whisper'`,
      eq(messages.userId, me.id),
      eq(messages.toUserId, me.id),
    );

    // Overfetch by one to detect hasMore without a separate count.
    const rows = await db
      .select()
      .from(messages)
      .where(and(
        eq(messages.roomId, room.id),
        lt(messages.createdAt, new Date(before)),
        whisperFilter,
      ))
      .orderBy(desc(messages.createdAt))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const window = (hasMore ? rows.slice(0, limit) : rows)
      .filter((m) => !ignoredIds.has(m.userId));
    // The DB pull was DESC for the limit boundary; flip to ASC so the
    // client can prepend in place without re-sorting.
    window.reverse();
    const wire: ChatMessage[] = window.map((m) => ({
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
    }));
    return { messages: wire, hasMore };
  });

  /**
   * GET /rooms/:id/messages/:messageId/thread
   *
   * Resolve any message id (topic OR reply) to the topic it belongs to,
   * and return the topic + its full reply chain. Used by the forum's
   * jump-to-message flow (search hit click, bookmark click, mention
   * click) so the client can open `ThreadModal` centered on the hit
   * without having to know up front whether the id points at a topic
   * or a reply.
   *
   * If the requested id is a top-level topic, `topic = self`. If it
   * points to a reply, the server walks `replyToId` once to find the
   * parent. Forum structure is two-level (topic → flat reply chain),
   * so we never need to recurse further. The returned `replies` array
   * is every non-deleted reply under the topic, chronologically.
   *
   * 404s:
   *   - message not found in this room
   *   - the topic (self or parent) was soft-deleted — forum-deletes
   *     are hidden from end-user surfaces; jumping to a removed topic
   *     should fail closed.
   *
   * Auth: any logged-in user. The same justification as the topics
   * endpoint applies — you can't jump to content in a room you haven't
   * joined, since the search/bookmark/mention surfaces only emit ids
   * for content you can see.
   */
  app.get<{ Params: { id: string; messageId: string } }>(
    "/rooms/:id/messages/:messageId/thread",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }

      const roomId = req.params.id;
      const hit = (await db.select().from(messages).where(eq(messages.id, req.params.messageId)).limit(1))[0];
      if (!hit || hit.roomId !== roomId) {
        reply.code(404);
        return { error: "message not in this room" };
      }

      // Walk to the topic. `replyToId` is null on topics, set on
      // replies. Forum structure is two-level so one lookup max.
      const topicId = hit.replyToId ?? hit.id;
      const topicRow = (await db.select().from(messages).where(eq(messages.id, topicId)).limit(1))[0];
      if (!topicRow || topicRow.roomId !== roomId) {
        reply.code(404);
        return { error: "topic not in this room" };
      }
      if (topicRow.deletedAt) {
        // Topic was soft-deleted — surface a 404 rather than handing
        // back a "[message removed]" shell. The jump-from surfaces
        // (search, bookmarks) already filter deleted rows server-
        // side; this is the belt-and-suspenders for racing deletes.
        reply.code(404);
        return { error: "topic removed" };
      }

      // Full reply chain under this topic, oldest first. Non-deleted
      // replies only — the modal's renderer paints "[message removed]"
      // for deletedAt rows but we don't emit them at all here, since
      // a deleted reply in a thread you're viewing is noise.
      const replyRows = await db
        .select()
        .from(messages)
        .where(and(
          eq(messages.roomId, roomId),
          eq(messages.replyToId, topicId),
          isNull(messages.deletedAt),
        ))
        .orderBy(asc(messages.createdAt));

      function rowToWire(m: typeof messages.$inferSelect): ChatMessage {
        return {
          id: m.id,
          roomId: m.roomId,
          userId: m.userId,
          characterId: m.characterId,
          displayName: m.displayName,
          kind: m.kind,
          body: m.body,
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
        };
      }

      return {
        topic: rowToWire(topicRow),
        replies: replyRows.map(rowToWire),
      };
    },
  );

  /**
   * GET /rooms/:id/topics — paginated list of top-level topics in a
   * forum (nested-mode) room. Filters by category and orders by
   * `last_activity_at` DESC so the most-recently-active threads
   * surface first. Used by the forum view to load topics on room
   * enter, by the per-category "Load older" button, and by the
   * orphan-fetch path when a reply arrives for a topic not yet in
   * the client's buffer.
   *
   * Query params:
   *   - `category`: thread category id, `""` for uncategorized, or
   *      omitted for "all categories". Empty-string matches null
   *      threadCategoryId server-side.
   *   - `before`: cursor — return only topics with
   *      `last_activity_at < before` (epoch ms). Omit for the first
   *      page. The client passes the lastActivityAt of the
   *      oldest-loaded topic on each "Load older" click.
   *   - `limit`: 1..50, default 20.
   *
   * Deleted topics (`deletedAt` set) are excluded entirely — they
   * don't appear in the forum view for anyone (admins review via the
   * audit panel, not via topic listings).
   *
   * Auth: requires a logged-in user. Room membership / password is
   * NOT re-checked here because the user already had to join the
   * room (via `room:join` socket) to see the forum view in the
   * first place; the chat-message backlog (rooms/:id/messages) uses
   * the same model.
   */
  const topicsQuery = z.object({
    category: z.string().optional(),
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  });

  app.get<{ Params: { id: string }; Querystring: unknown }>(
    "/rooms/:id/topics",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }

      let q;
      try { q = topicsQuery.parse(req.query); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid query" }; }

      const limit = q.limit ?? 20;
      const roomId = req.params.id;

      // Build the WHERE clause. We always require:
      //   - same room
      //   - top-level (replyToId IS NULL)
      //   - not deleted
      // The category clause is conditional:
      //   - undefined → no filter (all categories)
      //   - ""        → threadCategoryId IS NULL (uncategorized)
      //   - <id>      → threadCategoryId === id
      // The cursor clause is also conditional:
      //   - undefined → first page
      //   - <ts>      → lastActivityAt < ts (older topics)
      const baseConditions = [
        eq(messages.roomId, roomId),
        isNull(messages.replyToId),
        isNull(messages.deletedAt),
        // Topics are ONLY ever `kind = "say"`. The forum composer
        // creates topics with this kind; replies use it too. Every
        // other top-level row in the messages table — `system`
        // (joins/leaves/watch pings), `announce`, `scene`, `me`,
        // `roll`, `npc`, `whisper`, `ooc` — is a chat-shaped event,
        // not a discussion thread, and must not surface in the forum
        // topics list. Without this filter, historical system rows
        // from before the forum-room suppression landed in
        // `broadcast.ts` show up as "WAS has connected." topics in
        // the Uncategorized bucket.
        eq(messages.kind, "say"),
      ];
      if (q.category !== undefined) {
        if (q.category === "") {
          baseConditions.push(isNull(messages.threadCategoryId));
        } else {
          baseConditions.push(eq(messages.threadCategoryId, q.category));
        }
      }

      // Pagination model for stickies:
      //
      //  - Page 1 (no `before`):
      //      Returns ALL stickies in the category (no limit on those —
      //      they're admin-pinned and should always be visible),
      //      PLUS the first `limit` non-stickies ordered by
      //      `last_activity_at DESC`.
      //  - Page 2+ (with `before`):
      //      Returns ONLY non-stickies older than `before`, ordered by
      //      `last_activity_at DESC`. Stickies are already in the
      //      bucket from page 1, so excluding them here prevents
      //      duplicates.
      //
      // The client appends each page's `topics` directly to its bucket;
      // since stickies always come first in the returned array, the
      // bucket invariant "stickies first, then unstickies by activity
      // DESC" holds automatically.
      let stickies: typeof messages.$inferSelect[] = [];
      if (q.before === undefined) {
        // First page: pull every sticky for this scope. Stickies are
        // admin-set, so there should be few; no LIMIT here.
        stickies = await db
          .select()
          .from(messages)
          .where(and(...baseConditions, eq(messages.isSticky, true)))
          .orderBy(desc(messages.lastActivityAt));
      }

      // Non-sticky page: paginated by lastActivityAt.
      const nonStickyConditions = [...baseConditions, eq(messages.isSticky, false)];
      if (q.before !== undefined) {
        // We compare against last_activity_at, which is non-null for
        // every top-level row (seeded on insert + backfilled in the
        // 0041 migration). The `<` keeps the cursor strict so we don't
        // re-emit the boundary topic.
        nonStickyConditions.push(sql`${messages.lastActivityAt} < ${q.before}`);
      }
      const nonStickyRows = await db
        .select()
        .from(messages)
        .where(and(...nonStickyConditions))
        .orderBy(desc(messages.lastActivityAt))
        .limit(limit + 1);

      const hasMore = nonStickyRows.length > limit;
      const nonStickyPage = hasMore ? nonStickyRows.slice(0, limit) : nonStickyRows;
      const page = [...stickies, ...nonStickyPage];

      const topics: ChatMessage[] = page.map((m) => ({
        id: m.id,
        roomId: m.roomId,
        userId: m.userId,
        characterId: m.characterId,
        displayName: m.displayName,
        kind: m.kind,
        body: m.body,
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
      }));
      return { topics, hasMore };
    },
  );

  /**
   * GET /rooms/:id/thread-categories — list the admin-defined thread
   * buckets for a room. Returned in the same `sortOrder asc, createdAt
   * asc` order the renderer applies, so the client can use the list
   * verbatim without re-sorting. Visible to any logged-in user (the
   * composer's category picker is the primary consumer); a non-member
   * peeking at the categories of a private room won't leak content,
   * since the picker is only meaningful AFTER you've joined.
   */
  app.get<{ Params: { id: string } }>("/rooms/:id/thread-categories", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const cats = await db
      .select()
      .from(roomThreadCategories)
      .where(eq(roomThreadCategories.roomId, req.params.id))
      .orderBy(asc(roomThreadCategories.sortOrder), asc(roomThreadCategories.createdAt));
    const out: ThreadCategory[] = cats.map((c) => ({
      id: c.id,
      roomId: c.roomId,
      name: c.name,
      sortOrder: c.sortOrder,
      createdAt: +c.createdAt,
    }));
    return { categories: out };
  });

  /**
   * Admin: create a thread category. Allowed for site admin or room
   * owner (mirrors the room-edit pattern in admin/routes.ts). Returns
   * 409 on case-insensitive name conflict within the same room.
   */
  const createCategoryBody = z.object({
    name: z.string().min(1).max(40),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  }).strict();

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/admin/rooms/:id/thread-categories",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
      if (!room) { reply.code(404); return { error: "no room" }; }
      const isOwner = room.ownerId === me.id;
      if (!(isAdminRole(me.role) || isOwner)) {
        reply.code(403);
        return { error: "admin or room owner only" };
      }
      let body;
      try { body = createCategoryBody.parse(req.body); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

      const id = nanoid();
      try {
        await db.insert(roomThreadCategories).values({
          id,
          roomId: room.id,
          name: body.name.trim(),
          sortOrder: body.sortOrder ?? 0,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (/UNIQUE/i.test(msg)) {
          reply.code(409);
          return { error: "a category with that name already exists in this room" };
        }
        throw err;
      }
      return { id };
    },
  );

  const patchCategoryBody = z.object({
    name: z.string().min(1).max(40).optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  }).strict();

  app.patch<{ Params: { id: string; catId: string }; Body: unknown }>(
    "/admin/rooms/:id/thread-categories/:catId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
      if (!room) { reply.code(404); return { error: "no room" }; }
      const isOwner = room.ownerId === me.id;
      if (!(isAdminRole(me.role) || isOwner)) {
        reply.code(403);
        return { error: "admin or room owner only" };
      }
      const row = (await db
        .select()
        .from(roomThreadCategories)
        .where(and(
          eq(roomThreadCategories.id, req.params.catId),
          eq(roomThreadCategories.roomId, room.id),
        ))
        .limit(1))[0];
      if (!row) { reply.code(404); return { error: "category not found" }; }

      let body;
      try { body = patchCategoryBody.parse(req.body); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

      const update: Partial<typeof roomThreadCategories.$inferInsert> = {};
      if (body.name !== undefined) update.name = body.name.trim();
      if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
      if (Object.keys(update).length === 0) return { ok: true };
      try {
        await db.update(roomThreadCategories).set(update).where(eq(roomThreadCategories.id, row.id));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (/UNIQUE/i.test(msg)) {
          reply.code(409);
          return { error: "a category with that name already exists in this room" };
        }
        throw err;
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; catId: string } }>(
    "/admin/rooms/:id/thread-categories/:catId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
      if (!room) { reply.code(404); return { error: "no room" }; }
      const isOwner = room.ownerId === me.id;
      if (!(isAdminRole(me.role) || isOwner)) {
        reply.code(403);
        return { error: "admin or room owner only" };
      }
      // FK `ON DELETE SET NULL` on messages.thread_category_id means any
      // existing thread anchored to this bucket falls back to
      // "Uncategorized" — history is preserved.
      await db
        .delete(roomThreadCategories)
        .where(and(
          eq(roomThreadCategories.id, req.params.catId),
          eq(roomThreadCategories.roomId, room.id),
        ));
      return { ok: true };
    },
  );
}
