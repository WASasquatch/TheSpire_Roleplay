import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import {
  auditLog,
  characters,
  customCommandAliases,
  customCommands,
  messages,
  mutualTitles,
  reports,
  roomMembers,
  rooms,
  sessions,
  titleKinds,
  users,
  worlds,
} from "../db/schema.js";
import { COLOR_TOKEN_OR_HEX_RE, type AuditEntry, type Role } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import type { CommandRegistry } from "../commands/registry.js";
import {
  broadcastRoomState,
  findCanonicalLanding,
  sendRoomBacklogTo,
} from "../realtime/broadcast.js";
import { getSettings, updateSettings } from "../settings.js";
import { recordAudit } from "../audit.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

interface SessionUserCtx {
  id: string;
  role: Role;
}

/**
 * Admin HTTP routes.
 *
 * Privacy contract: even admins cannot read messages from password-protected
 * or private rooms. They CAN see that those rooms exist, who is in them, and
 * the room metadata (name, owner, topic, member count).
 *
 * Public-room messages ARE inspectable for moderation purposes.
 */
export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: {
    db: Db;
    io: Io;
    registry: CommandRegistry;
    /** Returns the current authenticated session user (or null if unauthenticated). */
    getSessionUser: (req: FastifyRequest) => Promise<SessionUserCtx | null>;
  },
): Promise<void> {
  const { db, io, registry, getSessionUser } = deps;

  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/admin")) return;
    const user = await getSessionUser(req);
    if (!user || user.role !== "admin") {
      reply.code(403);
      throw new Error("admin only");
    }
    (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser = user;
  });

  /* ---------- site overview (admin dashboard) ----------
   *
   * Rich admin-only dashboard counters. Distinct from the public /stats
   * endpoint, which intentionally exposes only the splash-page subset (no
   * audit / report / DAU figures, no per-day login or registration series).
   *
   * Login series caveat: `sessions` rows are purged on expiry, so the
   * loginsPerDay buckets only stay accurate while the configured session
   * TTL is at least the chart's lookback (7d here, 30d for MAU). Past that
   * the older days will undercount — fine for a dashboard, called out so
   * future-us doesn't chase a phantom bug.
   */
  app.get("/admin/overview", async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const since24h = new Date(now - dayMs);
    const since7d = new Date(now - 7 * dayMs);
    const since30d = new Date(now - 30 * dayMs);

    // Currently-connected users — dedupe by userId across sockets.
    const sockets = await io.fetchSockets();
    const onlineUsers = new Set<string>();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid) onlineUsers.add(uid);
    }

    // Registered users exclude the "system" sentinel (owner of server-authored
    // system messages); counting it as a user inflates the figure misleadingly.
    const notSystem = ne(users.username, "system");
    const [usersTotalRow] = await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(notSystem);
    const [users7dRow] = await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(and(notSystem, gte(users.createdAt, since7d)));
    const [users30dRow] = await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(and(notSystem, gte(users.createdAt, since30d)));

    // DAU/WAU/MAU derived from sessions.createdAt — every login mints a row,
    // so distinct user IDs in each window approximate active-user counts.
    const [dauRow] = await db
      .select({ n: sql<number>`count(distinct ${sessions.userId})` })
      .from(sessions)
      .where(gte(sessions.createdAt, since24h));
    const [wauRow] = await db
      .select({ n: sql<number>`count(distinct ${sessions.userId})` })
      .from(sessions)
      .where(gte(sessions.createdAt, since7d));
    const [mauRow] = await db
      .select({ n: sql<number>`count(distinct ${sessions.userId})` })
      .from(sessions)
      .where(gte(sessions.createdAt, since30d));

    // Rooms by type (public/private). The public /stats endpoint uses the
    // same shape — kept consistent so cards look the same across both views.
    const roomCounts = await db
      .select({ type: rooms.type, n: sql<number>`count(*)` })
      .from(rooms)
      .groupBy(rooms.type);
    const roomsByType: Record<string, number> = { public: 0, private: 0 };
    for (const r of roomCounts) roomsByType[r.type] = r.n;

    // Real chat = excludes the system kind (presence/join chatter that
    // would otherwise dominate the message-volume figures) and soft-deleted
    // rows.
    const realChat = sql`${messages.kind} != 'system' and ${messages.deletedAt} is null`;

    // Topic / reply detection mirrors the canonical filter used by
    // `/rooms/:id/topics` (routes/rooms.ts): scoped to nested-mode rooms,
    // kind="say" only (the forum composer's wire format), not deleted.
    // Detecting topics via `title IS NOT NULL` would miss legacy topics
    // created before the title column was added in migration 0039 —
    // they're still real topics, the renderer falls back to a body
    // excerpt for the header.
    const nestedRooms = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.replyMode, "nested"));
    const nestedRoomIds = nestedRooms.map((r) => r.id);
    // When no forum rooms exist yet, all forum metrics collapse to zero —
    // `inArray` on an empty list would otherwise produce invalid SQL.
    const inForum = nestedRoomIds.length > 0
      ? inArray(messages.roomId, nestedRoomIds)
      : sql`1 = 0`;
    const isTopic = and(
      inForum,
      sql`${messages.replyToId} is null`,
      eq(messages.kind, "say"),
      sql`${messages.deletedAt} is null`,
    );
    const isReply = and(
      inForum,
      sql`${messages.replyToId} is not null`,
      eq(messages.kind, "say"),
      sql`${messages.deletedAt} is null`,
    );

    const [msg24Row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(realChat, gte(messages.createdAt, since24h)));
    const [msg7Row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(realChat, gte(messages.createdAt, since7d)));
    const [msg30Row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(realChat, gte(messages.createdAt, since30d)));

    const [topicsTotalRow] = await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(isTopic);
    const [repliesTotalRow] = await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(isReply);
    const [topics7Row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(isTopic, gte(messages.createdAt, since7d)));
    const [replies7Row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(isReply, gte(messages.createdAt, since7d)));

    const [charactersRow] = await db.select({ n: sql<number>`count(*)` }).from(characters);
    const [worldsRow] = await db.select({ n: sql<number>`count(*)` }).from(worlds);

    const [reports7Row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(reports)
      .where(gte(reports.createdAt, since7d));
    const [audit7Row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(auditLog)
      .where(gte(auditLog.createdAt, since7d));

    // 7-day daily series. UTC day buckets (matches the public /stats shape so
    // the client day-formatter stays single-sourced). Missing days fill as 0.
    const dayExpr = (col: typeof messages.createdAt | typeof sessions.createdAt | typeof users.createdAt) =>
      sql<string>`strftime('%Y-%m-%d', ${col} / 1000, 'unixepoch')`.as("day");

    const messageFreq = await db
      .select({ day: dayExpr(messages.createdAt), n: sql<number>`count(*)` })
      .from(messages)
      .where(and(realChat, gte(messages.createdAt, since7d)))
      .groupBy(sql`day`);
    const topicFreq = await db
      .select({ day: dayExpr(messages.createdAt), n: sql<number>`count(*)` })
      .from(messages)
      .where(and(isTopic, gte(messages.createdAt, since7d)))
      .groupBy(sql`day`);
    const loginFreq = await db
      .select({
        day: dayExpr(sessions.createdAt),
        n: sql<number>`count(distinct ${sessions.userId})`,
      })
      .from(sessions)
      .where(gte(sessions.createdAt, since7d))
      .groupBy(sql`day`);
    const regFreq = await db
      .select({ day: dayExpr(users.createdAt), n: sql<number>`count(*)` })
      .from(users)
      .where(and(notSystem, gte(users.createdAt, since7d)))
      .groupBy(sql`day`);

    const dayKeys: string[] = [];
    for (let i = 6; i >= 0; i--) {
      dayKeys.push(new Date(now - i * dayMs).toISOString().slice(0, 10));
    }
    const fill = (rows: { day: string; n: number }[]) => {
      const map = new Map(rows.map((r) => [r.day, r.n]));
      return dayKeys.map((d) => ({ day: d, count: map.get(d) ?? 0 }));
    };

    return {
      online: onlineUsers.size,
      users: {
        total: usersTotalRow?.n ?? 0,
        newLast7d: users7dRow?.n ?? 0,
        newLast30d: users30dRow?.n ?? 0,
        dau: dauRow?.n ?? 0,
        wau: wauRow?.n ?? 0,
        mau: mauRow?.n ?? 0,
      },
      rooms: {
        public: roomsByType.public ?? 0,
        private: roomsByType.private ?? 0,
        total: roomCounts.reduce((s, r) => s + r.n, 0),
      },
      messages: {
        last24h: msg24Row?.n ?? 0,
        last7d: msg7Row?.n ?? 0,
        last30d: msg30Row?.n ?? 0,
      },
      forum: {
        topics: topicsTotalRow?.n ?? 0,
        replies: repliesTotalRow?.n ?? 0,
        topicsLast7d: topics7Row?.n ?? 0,
        repliesLast7d: replies7Row?.n ?? 0,
      },
      content: {
        characters: charactersRow?.n ?? 0,
        worlds: worldsRow?.n ?? 0,
      },
      moderation: {
        reportsLast7d: reports7Row?.n ?? 0,
        auditLast7d: audit7Row?.n ?? 0,
      },
      series: {
        messages: fill(messageFreq),
        topics: fill(topicFreq),
        logins: fill(loginFreq),
        registrations: fill(regFreq),
      },
    };
  });

  /* ---------- room overview ---------- */
  app.get("/admin/rooms", async () => {
    const allRooms = await db.select().from(rooms).orderBy(asc(rooms.name));
    const counts = await db
      .select({ roomId: roomMembers.roomId, n: sql<number>`count(*)` })
      .from(roomMembers)
      .groupBy(roomMembers.roomId);
    const countByRoom = new Map(counts.map((r) => [r.roomId, r.n]));

    return {
      rooms: allRooms.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        topic: r.topic,
        description: r.description,
        ownerId: r.ownerId,
        isSystem: r.isSystem,
        isDefault: r.isDefault,
        replyMode: r.replyMode,
        // hasPassword tells the editor whether to show "(replace password)"
        // vs "(set password)" - the hash itself is never exposed.
        hasPassword: r.passwordHash != null,
        memberCount: countByRoom.get(r.id) ?? 0,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/admin/rooms/:id/occupants", async (req) => {
    const { id } = req.params;
    const occupants = await db
      .select({
        userId: roomMembers.userId,
        role: roomMembers.role,
        joinedAt: roomMembers.joinedAt,
        username: users.username,
      })
      .from(roomMembers)
      .innerJoin(users, eq(users.id, roomMembers.userId))
      .where(eq(roomMembers.roomId, id))
      .orderBy(asc(users.username));
    return { occupants };
  });

  /**
   * Messages endpoint - explicitly REFUSES to return:
   *   - any messages from private/password-protected rooms (whole-room privacy)
   *   - whispers from any room (per-pair privacy - even public rooms persist
   *     whispers there for sender/recipient scrollback, but those exchanges
   *     are NOT moderation-visible content)
   *
   * Privacy promise: admins never read user-to-user private content. They
   * see what was said in the open, full stop. If a user is being abused
   * via whispers, they screenshot and report - the server doesn't act as
   * a backdoor.
   */
  app.get<{ Params: { id: string } }>("/admin/rooms/:id/messages", async (req, reply) => {
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
    if (!room) {
      reply.code(404);
      return { error: "room not found" };
    }
    if (room.type !== "public") {
      reply.code(403);
      return {
        error: "private",
        message: "Private rooms are not viewable, even by administrators.",
      };
    }
    const rows = await db
      .select()
      .from(messages)
      .where(and(
        eq(messages.roomId, room.id),
        sql`${messages.kind} != 'whisper'`,
      ))
      .orderBy(desc(messages.createdAt))
      .limit(200);
    return { messages: rows.reverse() };
  });

  /* ---------- admin room create / edit ----------
   *
   * Admins can mint system rooms (permanent, exempt from auto-expire) with
   * a name, type, optional topic + description, and an optional password
   * for private rooms. Editing covers the same surface plus an `isSystem`
   * toggle so a room can be promoted to permanent (or vice-versa) after
   * the fact.
   */
  const ROOM_NAME_RX = /^[\p{L}\p{N}_\-' ]{1,40}$/u;
  const adminRoomCreateBody = z.object({
    name: z.string().min(1).max(40).regex(ROOM_NAME_RX, "name: letters, numbers, spaces, _ - '"),
    type: z.enum(["public", "private"]),
    /** Required when type=private. */
    password: z.string().min(1).max(100).optional(),
    topic: z.string().max(200).nullable().optional(),
    description: z.string().max(5000).nullable().optional(),
    /** Defaults to true - admin-created rooms are permanent unless explicitly opted out. */
    isSystem: z.boolean().optional(),
    /** When true, this room becomes the default landing — any existing default is automatically cleared first. */
    isDefault: z.boolean().optional(),
    /** "flat" = chronological chat; "nested" = forum-style threads with persistent top-level posts and grouped replies. Enables thread-category management. */
    replyMode: z.enum(["flat", "nested"]).optional(),
  });
  const adminRoomPatchBody = z.object({
    name: z.string().min(1).max(40).regex(ROOM_NAME_RX).optional(),
    /** Pass null in topic/description to clear; omit to leave unchanged. */
    topic: z.string().max(200).nullable().optional(),
    description: z.string().max(5000).nullable().optional(),
    isSystem: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    /** Same semantics as create: "flat" or "nested". Same in-chat command (/replymode) toggles this too. */
    replyMode: z.enum(["flat", "nested"]).optional(),
    type: z.enum(["public", "private"]).optional(),
    /** Required if type changes to private and the room currently has no password. */
    password: z.string().min(1).max(100).nullable().optional(),
  });

  app.post<{ Body: unknown }>("/admin/rooms", async (req, reply) => {
    const body = adminRoomCreateBody.parse(req.body);
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    if (body.type === "private" && !body.password) {
      reply.code(400);
      return { error: "private rooms require a password" };
    }
    // Name uniqueness (case-insensitive). Mirrors the user-facing /go and
    // /private guards.
    const dup = (await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(sql`lower(${rooms.name}) = ${body.name.toLowerCase()}`)
      .limit(1))[0];
    if (dup) {
      reply.code(409);
      return { error: `a room named "${body.name}" already exists` };
    }
    const argon2 = (await import("argon2")).default;
    const id = nanoid();
    // Single-default invariant: if this room is being flagged the default,
    // clear it off whichever room currently carries it first. The partial
    // unique index would reject the insert otherwise.
    if (body.isDefault) {
      await db.update(rooms).set({ isDefault: false }).where(eq(rooms.isDefault, true));
    }
    await db.insert(rooms).values({
      id,
      name: body.name,
      type: body.type,
      passwordHash: body.type === "private" && body.password
        ? await argon2.hash(body.password)
        : null,
      topic: body.topic ?? null,
      description: body.description ?? null,
      // Owner is the creating admin. Cascade `set null` on user delete keeps
      // the room around even if the admin is later removed.
      ownerId: sessionUser.id,
      isSystem: body.isSystem ?? true,
      isDefault: body.isDefault ?? false,
      replyMode: body.replyMode ?? "flat",
    });
    // The creating admin gets an owner row in case they want to /topic etc
    // from inside the chat without elevating to site-admin every time.
    await db.insert(roomMembers).values({
      roomId: id,
      userId: sessionUser.id,
      role: "owner",
    }).onConflictDoNothing();
    return { id, name: body.name, type: body.type };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/rooms/:id", async (req, reply) => {
    const body = adminRoomPatchBody.parse(req.body);
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
    if (!room) { reply.code(404); return { error: "not found" }; }

    // Name conflict (case-insensitive, ignoring this room).
    if (body.name && body.name.toLowerCase() !== room.name.toLowerCase()) {
      const dup = (await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(and(
          sql`lower(${rooms.name}) = ${body.name.toLowerCase()}`,
          sql`${rooms.id} != ${room.id}`,
        ))
        .limit(1))[0];
      if (dup) { reply.code(409); return { error: "a room with that name already exists" }; }
    }

    // Type/password handling: switching to private requires a password
    // (either supplied here or already on the row); switching to public
    // clears the password.
    const update: Partial<typeof rooms.$inferInsert> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.topic !== undefined) update.topic = body.topic;
    if (body.description !== undefined) update.description = body.description;
    if (body.isSystem !== undefined) update.isSystem = body.isSystem;
    if (body.isDefault !== undefined) update.isDefault = body.isDefault;
    if (body.replyMode !== undefined) update.replyMode = body.replyMode;

    // Single-default invariant: flagging this room as the default first
    // clears whichever room currently carries the flag. Skipped when the
    // target is already the default (no-op) and when we're un-flagging
    // (the user is explicitly clearing, not stealing).
    if (body.isDefault === true && !room.isDefault) {
      await db.update(rooms).set({ isDefault: false }).where(eq(rooms.isDefault, true));
    }

    if (body.type !== undefined && body.type !== room.type) {
      update.type = body.type;
      const argon2 = (await import("argon2")).default;
      if (body.type === "private") {
        if (body.password) {
          update.passwordHash = await argon2.hash(body.password);
        } else if (!room.passwordHash) {
          reply.code(400);
          return { error: "switching to private requires a password" };
        }
      } else {
        // public: drop any stored password
        update.passwordHash = null;
      }
    } else if (body.password !== undefined) {
      // Same-type update: rotate or clear password explicitly. Clearing on a
      // private room is a no-op (login still requires it via /invite or
      // membership); we treat it as "remove the password but keep the room
      // private" - admins can clear and set again to rotate.
      if (body.password === null) {
        update.passwordHash = null;
      } else {
        const argon2 = (await import("argon2")).default;
        update.passwordHash = await argon2.hash(body.password);
      }
    }

    await db.update(rooms).set(update).where(eq(rooms.id, room.id));

    // If the metadata changed, refresh anyone currently in the room so they
    // see the new name/topic/replyMode without manually /refresh-ing.
    // replyMode in particular flips the MessageList renderer (flat ↔
    // nested) and gates the thread-category picker in the composer.
    if (
      update.name !== undefined ||
      update.topic !== undefined ||
      update.type !== undefined ||
      update.replyMode !== undefined
    ) {
      await broadcastRoomState(io, db, room.id);
    }

    return { ok: true };
  });

  /**
   * DELETE /admin/rooms/:id - moderator hatchet. Refuses system rooms.
   *
   * Currently-online occupants are relocated to the canonical landing room
   * and shown a notice; cascade FKs (room_members, messages, bans,
   * invites) clean up. Even private/password rooms can be deleted (admin
   * moderation overrides the privacy contract because messages are still
   * never read — only removed wholesale).
   */
  app.delete<{ Params: { id: string } }>("/admin/rooms/:id", async (req, reply) => {
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.id)).limit(1))[0];
    if (!room) {
      reply.code(404);
      return { error: "not found" };
    }
    if (room.isSystem) {
      reply.code(400);
      return { error: "system rooms cannot be deleted" };
    }

    const landing = await findCanonicalLanding(db);
    const remoteSockets = await io.in(`room:${room.id}`).fetchSockets();

    for (const s of remoteSockets) {
      s.leave(`room:${room.id}`);
      s.emit("error:notice", {
        code: "ROOM_DELETED",
        message: `Room "${room.name}" was removed by an administrator.`,
      });
      if (landing) {
        s.join(`room:${landing.id}`);
        (s.data as { roomId?: string }).roomId = landing.id;
        const userId = (s.data as { userId?: string }).userId;
        if (userId) await sendRoomBacklogTo(s, db, landing.id, userId);
      }
    }

    await db.delete(rooms).where(eq(rooms.id, room.id));
    const actor = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser;
    if (actor) {
      await recordAudit(db, {
        actorUserId: actor.id,
        action: "room_delete",
        // The room is gone so the FK would set null anyway; we keep the
        // metadata for queryability instead.
        metadata: { roomId: room.id, roomName: room.name, type: room.type, isSystem: room.isSystem },
      });
    }

    if (landing && remoteSockets.length > 0) {
      await broadcastRoomState(io, db, landing.id);
    }

    return { ok: true, deleted: room.id, name: room.name };
  });

  /* ---------- site settings ---------- */
  const HEX_RX = /^#[0-9a-fA-F]{6}$/;
  const themeSchema = z.object({
    bg: z.string().regex(HEX_RX),
    panel: z.string().regex(HEX_RX),
    border: z.string().regex(HEX_RX),
    text: z.string().regex(HEX_RX),
    muted: z.string().regex(HEX_RX),
    action: z.string().regex(HEX_RX),
    accent: z.string().regex(HEX_RX),
    system: z.string().regex(HEX_RX),
  }).strict();
  const settingsBody = z.object({
    /** ms; 0 = retain forever. Capped at ~10 years to refuse pathological values. */
    messageRetentionMs: z.number().int().min(0).max(10 * 365 * 24 * 60 * 60 * 1000).optional(),
    /** ms; min 5 minutes (don't lock users out instantly), max 10 years. */
    sessionTtlMs: z.number().int().min(5 * 60 * 1000).max(10 * 365 * 24 * 60 * 60 * 1000).optional(),
    /** Pass null to clear; pass a Theme to set. */
    defaultTheme: themeSchema.nullable().optional(),
    /** Public site name. Empty becomes "The Spire". */
    siteName: z.string().min(0).max(60).optional(),
    /**
     * CSS background shorthand applied to the banner. Pass null to clear.
     * Sanity-capped at 1KB; admins can use url(), gradient(), or solid color.
     */
    bannerCoverCss: z.string().max(1000).nullable().optional(),
    /** Pass null to clear; pass a #rrggbb hex to override the logo color. */
    logoColor: z.string().regex(HEX_RX).nullable().optional(),
    /** Pass null to clear; pass a CSS font-family stack. */
    logoFont: z.string().max(200).nullable().optional(),
    /* ----- Limits / capacity controls ----- */
    /** 1..1000. */
    maxCharactersPerUser: z.number().int().min(1).max(1000).optional(),
    /** 1..50 - admins can lift the email-uniqueness cap for shared accounts. */
    maxAccountsPerEmail: z.number().int().min(1).max(50).optional(),
    /** 0..1000. 0 = no user-created rooms (public sites that only want admin rooms). */
    maxRoomsPerOwner: z.number().int().min(0).max(1000).optional(),
    /** 100..50000 chars per chat message. */
    maxMessageLength: z.number().int().min(100).max(50_000).optional(),
    /**
     * Author-edit / author-delete grace window in ms for chat + DM
     * messages. 0..7 days. Mods and admins bypass the gate. Forum
     * rooms ignore it (indefinite edits with an (edited) badge).
     */
    editGraceMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000).optional(),
    /** 1000..200000 chars per bio HTML. */
    maxBioLength: z.number().int().min(1000).max(200_000).optional(),
    /** Master switch for /auth/register. */
    registrationOpen: z.boolean().optional(),
    /** HTML rendered above the splash login form. Sanitized on save. 50KB cap. */
    welcomeHtml: z.string().max(50_000).optional(),
    /** HTML body of the Rules modal. Sanitized on save. 50KB cap. */
    rulesHtml: z.string().max(50_000).optional(),
    /** HTML body of the privacy/safety notice in the Rules modal. Sanitized on save. 10KB cap. */
    securityNoticeHtml: z.string().max(10_000).optional(),
    /** HTML body of the registration disclaimer. Sanitized on save. 20KB cap. */
    registerDisclaimerHtml: z.string().max(20_000).optional(),
    /** Plain-text SEO description (meta description, OG, Twitter card). 500-char cap. */
    metaDescription: z.string().max(500).optional(),
    /**
     * Raw HTML injected into <head> for analytics scripts. NOT sanitized -
     * admins paste from their provider's dashboard. 20KB cap as a sanity
     * check; the UI warns the field is admin-trusted raw HTML.
     */
    customHeadHtml: z.string().max(20_000).optional(),
    /** Surfaces live community activity counters on the splash + future feed rails. Off during cold-start. */
    activityFeedsEnabled: z.boolean().optional(),
    /** Splash page featured-worlds carousel toggle. */
    featuredWorldsEnabled: z.boolean().optional(),
    /** Sanitized HTML for the post-login welcome modal. Empty string clears the welcome. Same 50KB cap as other rich-text settings. */
    newUserWelcomeHtml: z.string().max(50_000).optional(),
    /**
     * Default theme STYLE key — 'medieval', 'modern', or 'scifi'. Users
     * who haven't picked an override inherit this. Stored verbatim — the
     * client validates against its registered style catalog and falls
     * back to 'medieval' if the value is unknown.
     */
    defaultStyleKey: z.string().min(1).max(64).optional(),
  });

  function settingsResponse(s: Awaited<ReturnType<typeof getSettings>>) {
    return {
      messageRetentionMs: s.messageRetentionMs,
      sessionTtlMs: s.sessionTtlMs,
      defaultThemeJson: s.defaultThemeJson,
      defaultTheme: s.defaultTheme,
      siteName: s.siteName,
      bannerCoverCss: s.bannerCoverCss,
      logoColor: s.logoColor,
      logoFont: s.logoFont,
      maxCharactersPerUser: s.maxCharactersPerUser,
      maxAccountsPerEmail: s.maxAccountsPerEmail,
      maxRoomsPerOwner: s.maxRoomsPerOwner,
      maxMessageLength: s.maxMessageLength,
      editGraceMs: s.editGraceMs,
      maxBioLength: s.maxBioLength,
      registrationOpen: s.registrationOpen,
      welcomeHtml: s.welcomeHtml,
      rulesHtml: s.rulesHtml,
      securityNoticeHtml: s.securityNoticeHtml,
      registerDisclaimerHtml: s.registerDisclaimerHtml,
      metaDescription: s.metaDescription,
      customHeadHtml: s.customHeadHtml,
      activityFeedsEnabled: s.activityFeedsEnabled,
      featuredWorldsEnabled: s.featuredWorldsEnabled,
      newUserWelcomeHtml: s.newUserWelcomeHtml,
      defaultStyleKey: s.defaultStyleKey,
      updatedAt: s.updatedAt,
    };
  }

  app.get("/admin/settings", async () => settingsResponse(await getSettings(db)));

  app.put<{ Body: unknown }>("/admin/settings", async (req) => {
    const body = settingsBody.parse(req.body);
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    // Drop undefined keys - exactOptionalPropertyTypes refuses `{ x: undefined }`
    // even on optional properties; we want true omission.
    const patch: Parameters<typeof updateSettings>[1] = {};
    if (body.messageRetentionMs !== undefined) patch.messageRetentionMs = body.messageRetentionMs;
    if (body.sessionTtlMs !== undefined) patch.sessionTtlMs = body.sessionTtlMs;
    if (body.defaultTheme !== undefined) patch.defaultTheme = body.defaultTheme;
    if (body.siteName !== undefined) patch.siteName = body.siteName;
    if (body.bannerCoverCss !== undefined) patch.bannerCoverCss = body.bannerCoverCss;
    if (body.logoColor !== undefined) patch.logoColor = body.logoColor;
    if (body.logoFont !== undefined) patch.logoFont = body.logoFont;
    if (body.maxCharactersPerUser !== undefined) patch.maxCharactersPerUser = body.maxCharactersPerUser;
    if (body.maxAccountsPerEmail !== undefined) patch.maxAccountsPerEmail = body.maxAccountsPerEmail;
    if (body.maxRoomsPerOwner !== undefined) patch.maxRoomsPerOwner = body.maxRoomsPerOwner;
    if (body.maxMessageLength !== undefined) patch.maxMessageLength = body.maxMessageLength;
    if (body.editGraceMs !== undefined) patch.editGraceMs = body.editGraceMs;
    if (body.maxBioLength !== undefined) patch.maxBioLength = body.maxBioLength;
    if (body.registrationOpen !== undefined) patch.registrationOpen = body.registrationOpen;
    if (body.welcomeHtml !== undefined) {
      // Sanitize on save (same allow-list as bios) - never trust admin HTML input.
      const { sanitizeBio } = await import("../auth/html.js");
      patch.welcomeHtml = sanitizeBio(body.welcomeHtml);
    }
    if (body.rulesHtml !== undefined) {
      const { sanitizeBio } = await import("../auth/html.js");
      patch.rulesHtml = sanitizeBio(body.rulesHtml);
    }
    if (body.securityNoticeHtml !== undefined) {
      const { sanitizeBio } = await import("../auth/html.js");
      patch.securityNoticeHtml = sanitizeBio(body.securityNoticeHtml);
    }
    if (body.registerDisclaimerHtml !== undefined) {
      const { sanitizeBio } = await import("../auth/html.js");
      patch.registerDisclaimerHtml = sanitizeBio(body.registerDisclaimerHtml);
    }
    // metaDescription is plain text - just trim. Newlines collapse to spaces
    // since meta descriptions are single-line.
    if (body.metaDescription !== undefined) {
      patch.metaDescription = body.metaDescription.replace(/\s+/g, " ").trim();
    }
    // customHeadHtml is verbatim raw HTML - DO NOT sanitize. Admins paste
    // analytics scripts here and sanitization would strip <script>. The
    // 20KB cap on the input schema is the only guard.
    if (body.customHeadHtml !== undefined) {
      patch.customHeadHtml = body.customHeadHtml;
    }
    if (body.activityFeedsEnabled !== undefined) {
      patch.activityFeedsEnabled = body.activityFeedsEnabled;
    }
    if (body.featuredWorldsEnabled !== undefined) {
      patch.featuredWorldsEnabled = body.featuredWorldsEnabled;
    }
    if (body.newUserWelcomeHtml !== undefined) {
      // Sanitize via the bio allow-list (same trust posture as welcomeHtml /
      // rulesHtml). Empty string passes through and represents "no welcome
      // to show".
      const { sanitizeBio } = await import("../auth/html.js");
      patch.newUserWelcomeHtml = sanitizeBio(body.newUserWelcomeHtml);
    }
    if (body.defaultStyleKey !== undefined) patch.defaultStyleKey = body.defaultStyleKey;
    const result = settingsResponse(await updateSettings(db, patch, sessionUser.id));
    await recordAudit(db, {
      actorUserId: sessionUser.id,
      action: "settings_update",
      // Record which fields were touched so the audit reads as "changed
      // welcomeHtml + maxMessageLength" rather than dumping a 50KB HTML diff.
      metadata: { keys: Object.keys(patch) },
    });
    return result;
  });

  /* ---------- custom commands ---------- */
  const customCommandBody = z.object({
    name: z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/i, "command name must start with a letter"),
    kind: z.enum(["action", "say"]),
    template: z.string().min(1).max(2000),
    description: z.string().max(200).optional(),
    aliases: z.array(z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/i)).max(20).optional(),
    enabled: z.boolean().optional(),
    /**
     * Pass null to clear; pass a hex like `#990000` to fix a literal
     * color; or pass `theme:<slot>` (slot ∈ system / action / accent /
     * muted / text) to follow the viewer's theme palette. Theme tokens
     * mean an "alert" command keeps the right visual identity for
     * every reader regardless of which palette they've chosen.
     */
    color: z
      .string()
      .regex(COLOR_TOKEN_OR_HEX_RE, "color must be a 6-digit hex like #990000 or a theme:<slot> token")
      .nullable()
      .optional(),
  });

  app.get("/admin/custom-commands", async () => {
    const cmds = await db.select().from(customCommands).orderBy(asc(customCommands.name));
    const aliases = await db.select().from(customCommandAliases);
    const aliasesByCmd = new Map<string, string[]>();
    for (const a of aliases) {
      const list = aliasesByCmd.get(a.commandId) ?? [];
      list.push(a.alias);
      aliasesByCmd.set(a.commandId, list);
    }
    return {
      commands: cmds.map((c) => ({ ...c, aliases: aliasesByCmd.get(c.id) ?? [] })),
    };
  });

  app.post<{ Body: unknown }>("/admin/custom-commands", async (req, reply) => {
    const body = customCommandBody.parse(req.body);
    const conflict = registry.resolve(body.name);
    if (conflict) {
      reply.code(409);
      return { error: "name conflicts with an existing command", existing: conflict.name };
    }
    for (const a of body.aliases ?? []) {
      if (registry.resolve(a)) {
        reply.code(409);
        return { error: `alias "${a}" conflicts with an existing command` };
      }
    }
    const id = nanoid();
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    await db.insert(customCommands).values({
      id,
      name: body.name.toLowerCase(),
      kind: body.kind,
      template: body.template,
      description: body.description ?? null,
      enabled: body.enabled ?? true,
      color: body.color ?? null,
      createdById: sessionUser.id,
    });
    if (body.aliases?.length) {
      await db.insert(customCommandAliases).values(
        body.aliases.map((a) => ({ alias: a.toLowerCase(), commandId: id })),
      );
    }
    await registry.reloadCustom(db);
    // Hot-reload every connected client's autocomplete + help cache —
    // otherwise a brand-new command stays invisible until each user
    // refreshes their tab.
    io.emit("commands:updated");
    await recordAudit(db, {
      actorUserId: sessionUser.id,
      action: "custom_command_create",
      metadata: { id, name: body.name.toLowerCase(), kind: body.kind },
    });
    return { id };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/admin/custom-commands/:id",
    async (req, reply) => {
      const body = customCommandBody.partial().parse(req.body);
      const existing = (await db
        .select()
        .from(customCommands)
        .where(eq(customCommands.id, req.params.id))
        .limit(1))[0];
      if (!existing) {
        reply.code(404);
        return { error: "not found" };
      }
      await db
        .update(customCommands)
        .set({
          ...(body.name !== undefined ? { name: body.name.toLowerCase() } : {}),
          ...(body.kind !== undefined ? { kind: body.kind } : {}),
          ...(body.template !== undefined ? { template: body.template } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.color !== undefined ? { color: body.color } : {}),
          updatedAt: new Date(),
        })
        .where(eq(customCommands.id, req.params.id));

      if (body.aliases !== undefined) {
        await db.delete(customCommandAliases).where(eq(customCommandAliases.commandId, req.params.id));
        if (body.aliases.length) {
          await db.insert(customCommandAliases).values(
            body.aliases.map((a) => ({ alias: a.toLowerCase(), commandId: req.params.id })),
          );
        }
      }
      await registry.reloadCustom(db);
      io.emit("commands:updated");
      const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
      await recordAudit(db, {
        actorUserId: sessionUser.id,
        action: "custom_command_update",
        metadata: { id: req.params.id, keys: Object.keys(body) },
      });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/admin/custom-commands/:id", async (req) => {
    const existing = (await db.select().from(customCommands).where(eq(customCommands.id, req.params.id)).limit(1))[0];
    await db.delete(customCommands).where(eq(customCommands.id, req.params.id));
    await registry.reloadCustom(db);
    io.emit("commands:updated");
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    await recordAudit(db, {
      actorUserId: sessionUser.id,
      action: "custom_command_delete",
      metadata: { id: req.params.id, ...(existing ? { name: existing.name } : {}) },
    });
    return { ok: true };
  });

  /* ---------- title kinds (mutual-title catalog) ----------
   * CRUD over the title_kinds table. Slug is the user-facing keyword for
   * /request <slug> <user>; format strings use {target} as the substitution
   * point for the other party's display name. Deleting a kind cascades to
   * any in-flight or accepted titles of that kind, so we surface a count
   * in the GET response so admins can preview the impact.
   */
  app.get("/admin/title-kinds", async () => {
    const kinds = await db.select().from(titleKinds).orderBy(asc(titleKinds.slug));
    const counts = await db
      .select({ kindId: mutualTitles.kindId, n: sql<number>`count(*)` })
      .from(mutualTitles)
      .groupBy(mutualTitles.kindId);
    const byId = new Map(counts.map((r) => [r.kindId, r.n]));
    return {
      kinds: kinds.map((k) => ({
        id: k.id,
        slug: k.slug,
        label: k.label,
        symmetric: k.symmetric,
        formatA: k.formatA,
        formatB: k.formatB,
        exclusive: k.exclusive,
        enabled: k.enabled,
        usageCount: byId.get(k.id) ?? 0,
        updatedAt: +k.updatedAt,
      })),
    };
  });

  // Slug rule: lowercase letters, digits, hyphen, underscore. Matches the
  // shape used in slash-command keywords elsewhere in the app.
  const SLUG_RX = /^[a-z0-9_-]{1,32}$/;
  const titleKindBody = z.object({
    slug: z.string().min(1).max(32).regex(SLUG_RX, "slug must be lowercase a-z/0-9/_/- only"),
    label: z.string().min(1).max(80),
    symmetric: z.boolean(),
    formatA: z.string().min(1).max(120),
    formatB: z.string().min(1).max(120),
    exclusive: z.boolean(),
    enabled: z.boolean(),
  });

  app.post<{ Body: unknown }>("/admin/title-kinds", async (req, reply) => {
    const parsed = titleKindBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid", details: parsed.error.flatten() };
    }
    const { slug, label, symmetric, formatA, formatB, exclusive, enabled } = parsed.data;
    const dup = (await db
      .select({ id: titleKinds.id })
      .from(titleKinds)
      .where(sql`lower(${titleKinds.slug}) = ${slug.toLowerCase()}`)
      .limit(1))[0];
    if (dup) {
      reply.code(409);
      return { error: "slug already exists" };
    }
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    const id = nanoid();
    await db.insert(titleKinds).values({
      id,
      slug,
      label,
      symmetric,
      // For symmetric kinds we still store both columns so the listTitles
      // query doesn't need to special-case; we just write formatA into both.
      formatA,
      formatB: symmetric ? formatA : formatB,
      exclusive,
      enabled,
      createdById: sessionUser.id,
    });
    return { ok: true, id };
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/admin/title-kinds/:id", async (req, reply) => {
    const parsed = titleKindBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid", details: parsed.error.flatten() };
    }
    const { slug, label, symmetric, formatA, formatB, exclusive, enabled } = parsed.data;
    const existing = (await db.select().from(titleKinds).where(eq(titleKinds.id, req.params.id)).limit(1))[0];
    if (!existing) {
      reply.code(404);
      return { error: "not found" };
    }
    // Slug uniqueness check excluding this row.
    if (slug.toLowerCase() !== existing.slug.toLowerCase()) {
      const dup = (await db
        .select({ id: titleKinds.id })
        .from(titleKinds)
        .where(sql`lower(${titleKinds.slug}) = ${slug.toLowerCase()}`)
        .limit(1))[0];
      if (dup) {
        reply.code(409);
        return { error: "slug already exists" };
      }
    }
    await db
      .update(titleKinds)
      .set({
        slug,
        label,
        symmetric,
        formatA,
        formatB: symmetric ? formatA : formatB,
        exclusive,
        enabled,
        updatedAt: new Date(),
      })
      .where(eq(titleKinds.id, req.params.id));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/admin/title-kinds/:id", async (req) => {
    // Cascade by FK: deletes all mutual_titles rows of this kind too.
    await db.delete(titleKinds).where(eq(titleKinds.id, req.params.id));
    return { ok: true };
  });

  /* ---------- audit log ---------- */
  /**
   * Hydrated audit feed. Resolves actor + target user/room display names so
   * the panel renders legibly without N+1 client requests. Optional filters:
   *
   *   ?action=ban         → exact match
   *   ?actor=<userId>     → by actor
   *   ?target=<userId>    → by target user
   *   ?room=<roomId>      → by target room
   *   ?limit=200          → cap rows (default 200, max 500)
   */
  app.get<{ Querystring: Record<string, string | undefined> }>("/admin/audit", async (req) => {
    const limit = Math.min(500, parseInt(req.query.limit ?? "200", 10) || 200);
    const conditions = [] as ReturnType<typeof eq>[];
    if (req.query.action) conditions.push(eq(auditLog.action, req.query.action));
    if (req.query.actor) conditions.push(eq(auditLog.actorUserId, req.query.actor));
    if (req.query.target) conditions.push(eq(auditLog.targetUserId, req.query.target));
    if (req.query.room) conditions.push(eq(auditLog.targetRoomId, req.query.room));

    const rows = conditions.length === 0
      ? await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit)
      : await db.select().from(auditLog).where(and(...conditions)).orderBy(desc(auditLog.createdAt)).limit(limit);

    if (rows.length === 0) return { entries: [] };

    // Hydrate referenced users/rooms in a single batched fetch.
    const userIds = new Set<string>();
    const roomIds = new Set<string>();
    for (const r of rows) {
      userIds.add(r.actorUserId);
      if (r.targetUserId) userIds.add(r.targetUserId);
      if (r.targetRoomId) roomIds.add(r.targetRoomId);
    }
    const [userRows, roomRows] = await Promise.all([
      userIds.size > 0
        ? db.select().from(users).where(sql`${users.id} IN (${sql.join([...userIds].map((u) => sql`${u}`), sql`, `)})`)
        : Promise.resolve([] as { id: string; username: string }[]),
      roomIds.size > 0
        ? db.select().from(rooms).where(sql`${rooms.id} IN (${sql.join([...roomIds].map((r) => sql`${r}`), sql`, `)})`)
        : Promise.resolve([] as { id: string; name: string }[]),
    ]);
    const userById = new Map(userRows.map((u) => [u.id, u]));
    const roomById = new Map(roomRows.map((r) => [r.id, r]));

    const entries: AuditEntry[] = rows.map((r) => {
      const actor = userById.get(r.actorUserId);
      const target = r.targetUserId ? userById.get(r.targetUserId) : null;
      const room = r.targetRoomId ? roomById.get(r.targetRoomId) : null;
      let metadata: Record<string, unknown> | null = null;
      if (r.metadataJson) {
        try { metadata = JSON.parse(r.metadataJson) as Record<string, unknown>; }
        catch { metadata = null; }
      }
      return {
        id: r.id,
        actorUserId: r.actorUserId,
        actorDisplayName: actor?.username ?? "(deleted user)",
        action: r.action as AuditEntry["action"],
        targetUserId: r.targetUserId,
        targetDisplayName: target?.username ?? null,
        targetRoomId: r.targetRoomId,
        targetRoomName: room?.name ?? null,
        targetMessageId: r.targetMessageId,
        reason: r.reason,
        metadata,
        createdAt: +r.createdAt,
      };
    });
    return { entries };
  });
}
