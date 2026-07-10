import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { messages, perRoomNotifyPrefs, roomReads, rooms, users } from "../db/schema.js";
import { isAdultUser } from "../auth/ageGate.js";
import { pulseRoomUnread } from "../notifications/engine.js";
import { emitToUser } from "../realtime/presence.js";
import { getSessionUser } from "./auth.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** Per-room unread summary for one user (the shape `/me/room-reads` returns). */
export interface RoomUnreadEntry {
  unread: number;
  hasMention: boolean;
  muted: boolean;
}
export type RoomUnreadMap = Record<string, RoomUnreadEntry>;

const readBody = z.object({
  /** Anchor the mark at a specific message; omitted → mark read as of now. */
  messageId: z.string().max(64).optional(),
}).strict();

const muteBody = z.object({
  muted: z.boolean(),
  /** Timed mute (minutes). Omitted with muted:true → indefinite mute. Ignored when unmuting. */
  minutes: z.number().int().positive().max(60 * 24 * 365).optional(),
}).strict();

/**
 * ONE grouped query returning `{ [roomId]: { unread, hasMention, muted } }` for
 * every room the user is a member of (optionally narrowed to a single room).
 * Never N+1 per room: unread + mentions are a single grouped COUNT joined
 * against the user's `room_reads` high-water mark, and mutes are a single
 * indexed select of the user's active prefs.
 *
 * Only rooms with a nonzero unread (or an active mute) appear; the client treats
 * absent rooms as {unread:0, hasMention:false, muted:false}.
 */
export async function computeRoomUnread(db: Db, userId: string, onlyRoomId?: string): Promise<RoomUnreadMap> {
  // The viewer's username (by-name mention approximation) + birthdate (age
  // plan, Phase 2): a minor MEMBER of an effectively-18+ room — membership
  // rows are kept-but-hidden on a flip — gets no unread entry for it,
  // matching the live fanRoomUnreadBump exclusion. The room isn't in their
  // rail, so a badge for it would be a dead signal (and a room-id leak).
  const viewer = (await db
    .select({ username: users.username, birthdate: users.birthdate })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0];
  const uname = viewer?.username ?? "";
  const viewerIsAdult = viewer ? isAdultUser(viewer) : false;

  const roomFilter = onlyRoomId ? sql` AND m.room_id = ${onlyRoomId}` : sql``;
  // Effective rating in SQL: room flag OR its server's (NULL server = the
  // default, SFW by invariant), plus the PER-MESSAGE stamp — rows a minor
  // can never read (18+-era history in a flipped-back room, replies under
  // an NSFW-tagged topic in an all-ages board) must not count into their
  // badge either, matching the live fanRoomUnreadBump skip and the
  // backlog/search stamped-history clause. Adults skip the clause entirely.
  const ageFilter = viewerIsAdult
    ? sql``
    : sql` AND r.is_nsfw = 0 AND COALESCE(s.is_nsfw, 0) = 0 AND m.is_nsfw = 0`;
  const lowerName = `%@${uname.toLowerCase()}%`;
  const mentionJson = `%"userId":"${userId}"%`;

  // Grouped unread + mention counts across every room the user belongs to,
  // measured past their room_reads high-water mark (absent read row → 0, so all
  // eligible messages count). One statement, indexed by room_members(user) and
  // messages(room_id, created_at).
  const rows = await db.all<{ room_id: string; unread: number; mentions: number }>(sql`
    SELECT m.room_id AS room_id,
           COUNT(*) AS unread,
           SUM(
             CASE WHEN (lower(m.body) LIKE ${lowerName} OR m.mentions_json LIKE ${mentionJson})
                  THEN 1 ELSE 0 END
           ) AS mentions
    FROM messages m
    JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = ${userId}
    JOIN rooms r ON r.id = m.room_id
    LEFT JOIN servers s ON s.id = r.server_id
    LEFT JOIN room_reads rr ON rr.room_id = m.room_id AND rr.user_id = ${userId}
    WHERE m.kind != 'whisper'
      AND m.deleted_at IS NULL
      AND m.target_user_id IS NULL
      AND m.user_id != ${userId}
      AND m.created_at > COALESCE(rr.last_read_at, 0)
      ${roomFilter}
      ${ageFilter}
    GROUP BY m.room_id
  `);

  // The user's active mutes (timed mutes that have expired are treated as
  // unmuted; a lazy cleanup can prune them later, we don't write here).
  const now = Date.now();
  const muteRows = await db.all<{ room_id: string; muted: number; muted_until: number | null }>(sql`
    SELECT room_id, muted, muted_until
    FROM per_room_notify_prefs
    WHERE user_id = ${userId} AND muted = 1
      ${onlyRoomId ? sql` AND room_id = ${onlyRoomId}` : sql``}
  `);

  const out: RoomUnreadMap = {};
  for (const r of rows) {
    out[r.room_id] = { unread: r.unread ?? 0, hasMention: (r.mentions ?? 0) > 0, muted: false };
  }
  for (const m of muteRows) {
    const active = !m.muted_until || m.muted_until > now;
    if (!active) continue;
    const e = out[m.room_id] ?? (out[m.room_id] = { unread: 0, hasMention: false, muted: false });
    e.muted = true;
  }
  return out;
}

/**
 * Upsert the caller's `room_reads` high-water mark for a room and pulse a
 * `room:unread {unread:0}` to their sockets. `messageId` anchors the mark at an
 * exact row (its createdAt becomes the watermark); omitted → now. Shared by the
 * HTTP read route and the socket join path so entering a room clears its unread
 * everywhere the user is looking.
 */
export async function markRoomRead(
  io: Io,
  db: Db,
  userId: string,
  roomId: string,
  messageId: string | null,
): Promise<void> {
  let watermark = Date.now();
  if (messageId) {
    const row = (await db
      .select({ createdAt: messages.createdAt, roomId: messages.roomId })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1))[0];
    // Only trust the anchor if it belongs to this room; otherwise fall back to
    // "now" so a stale/foreign id can't rewind or over-advance the mark.
    if (row && row.roomId === roomId) watermark = +row.createdAt;
  }
  await db
    .insert(roomReads)
    .values({ userId, roomId, lastReadAt: watermark, lastReadMessageId: messageId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [roomReads.userId, roomReads.roomId],
      // Monotonic: never rewind the watermark (a late read of older backlog
      // shouldn't un-read newer messages).
      set: {
        lastReadAt: sql`MAX(${roomReads.lastReadAt}, ${watermark})`,
        lastReadMessageId: messageId,
        updatedAt: new Date(),
      },
    });

  const serverId = (await db
    .select({ serverId: rooms.serverId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1))[0]?.serverId ?? null;
  await pulseRoomUnread(io, db, userId, { roomId, serverId, unread: 0, hasMention: false });
}

/**
 * Per-channel read/mute routes (migration 0318). The client boots its unread
 * maps from `GET /me/room-reads` (ONE grouped query — never N+1 per room),
 * clears a room's unread with `POST /me/rooms/:id/read` on open, and toggles a
 * per-room mute with `PUT /me/rooms/:id/mute`. Live deltas ride the
 * `room:unread` socket event (see notifications/engine.ts pulseRoomUnread and
 * realtime/broadcast.ts addMessage/joinRoomBody). Registered from index.ts via
 * `registerRoomReadsRoutes(app, db, io)`.
 */
export async function registerRoomReadsRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /**
   * Boot/poll fetch: the caller's per-room unread state in ONE grouped query,
   * shaped `{ [roomId]: { unread, hasMention, muted } }`. Rate-limited like
   * `/me/notifications/unread` (60/min) since it's a poll-shaped endpoint a
   * reconnect loop can hammer.
   */
  app.get("/me/room-reads", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    return computeRoomUnread(db, me.id);
  });

  /**
   * Mark a room read up to `messageId` (or now). Upserts `room_reads` and emits
   * a `room:unread {unread:0}` to the caller's sockets so every tab clears the
   * badge instantly.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/me/rooms/:id/read", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof readBody>;
    try { body = readBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const roomId = req.params.id;
    const room = (await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
    if (!room) { reply.code(404); return { error: "no room" }; }
    await markRoomRead(io, db, me.id, roomId, body.messageId ?? null);
    return { ok: true };
  });

  /**
   * Set the caller's per-room mute. `muted:true` with `minutes` is a timed mute
   * (lazily expired on read); `muted:true` without minutes is indefinite.
   * `muted:false` clears both. Re-emits `room:unread` so the client repaints the
   * muted glyph and re-suppresses/re-shows the badge.
   */
  app.put<{ Params: { id: string }; Body: unknown }>("/me/rooms/:id/mute", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof muteBody>;
    try { body = muteBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const roomId = req.params.id;
    const room = (await db.select({ id: rooms.id, serverId: rooms.serverId }).from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
    if (!room) { reply.code(404); return { error: "no room" }; }

    const mutedUntil = body.muted && body.minutes
      ? new Date(Date.now() + body.minutes * 60_000)
      : null;
    await db
      .insert(perRoomNotifyPrefs)
      .values({ userId: me.id, roomId, muted: body.muted, mutedUntil })
      .onConflictDoUpdate({
        target: [perRoomNotifyPrefs.userId, perRoomNotifyPrefs.roomId],
        set: { muted: body.muted, mutedUntil },
      });

    // Fan the new mute flag to EVERY live socket the caller owns so a sibling
    // tab flips its glyph immediately (the acting tab already toggled its own
    // state optimistically). Same per-user delivery path as pulseRoomUnread:
    // one fetchSockets(), filter by socket.data.userId, emit. Best-effort — a
    // socket hiccup must not fail the mute write that already committed.
    try {
      await emitToUser(io, me.id, "room:muted", { roomId, muted: body.muted });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[roomReads] room:muted fan-out failed", err);
    }

    // Re-pulse so every tab repaints the mute glyph and (un)suppresses the
    // badge. A freshly-muted room still reports its live unread; the client
    // hides the badge because `muted` is now true.
    const cur = await computeRoomUnread(db, me.id, roomId);
    const entry = cur[roomId] ?? { unread: 0, hasMention: false, muted: body.muted };
    await pulseRoomUnread(io, db, me.id, {
      roomId,
      serverId: room.serverId ?? null,
      unread: entry.unread,
      hasMention: entry.hasMention,
    });
    return { ok: true, muted: body.muted, mutedUntil: mutedUntil ? +mutedUntil : null };
  });
}
