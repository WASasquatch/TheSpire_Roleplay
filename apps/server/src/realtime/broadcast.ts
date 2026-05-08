import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Server as IoServer, Socket } from "socket.io";
import type {
  ChatMessage,
  ClientToServerEvents,
  MessageKind,
  RoomOccupant,
  RoomSummary,
  ServerToClientEvents,
} from "@thekeep/shared";
import {
  bans,
  characters,
  ignores,
  messages,
  roomInvites,
  roomMembers,
  rooms,
  users,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import type { CommandContext, SessionUser } from "../commands/types.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>;

/** Send a chat/system message to a room. Persists, then broadcasts. */
export async function addMessage(
  ctx: CommandContext,
  payload: {
    kind: MessageKind;
    body: string;
    toUserId?: string;
    /**
     * Per-call color override. Custom commands pass this when the admin set
     * a fixed color on the command itself. When undefined the sender's
     * chatColor is used (default behavior).
     */
    color?: string | null;
    /** Reply target. Caller is responsible for snapshotting display name + body snippet. */
    replyToId?: string;
    replyToDisplayName?: string;
    replyToBodySnippet?: string;
  },
): Promise<void> {
  const id = nanoid();
  const now = new Date();
  // System messages (server-authored via addSystemMessage) bypass this path,
  // so user-authored kinds inherit the author's snapshotted color unless
  // an explicit override is supplied.
  const baseColor = payload.color !== undefined ? payload.color : ctx.user.chatColor;
  const colorSnapshot = colorForKind(payload.kind, baseColor);
  await ctx.db.insert(messages).values({
    id,
    roomId: ctx.roomId,
    userId: ctx.user.id,
    characterId: ctx.user.activeCharacterId,
    displayName: ctx.user.displayName,
    kind: payload.kind,
    body: payload.body,
    color: colorSnapshot,
    toUserId: payload.toUserId ?? null,
    replyToId: payload.replyToId ?? null,
    replyToDisplayName: payload.replyToDisplayName ?? null,
    replyToBodySnippet: payload.replyToBodySnippet ?? null,
  });
  const out: ChatMessage = {
    id,
    roomId: ctx.roomId,
    userId: ctx.user.id,
    characterId: ctx.user.activeCharacterId,
    displayName: ctx.user.displayName,
    kind: payload.kind,
    body: payload.body,
    color: colorSnapshot,
    createdAt: +now,
    ...(payload.toUserId ? { toUserId: payload.toUserId } : {}),
    ...(payload.replyToId ? { replyToId: payload.replyToId } : {}),
    ...(payload.replyToDisplayName ? { replyToDisplayName: payload.replyToDisplayName } : {}),
    ...(payload.replyToBodySnippet ? { replyToBodySnippet: payload.replyToBodySnippet } : {}),
  };
  await emitFiltered(ctx.io, ctx.db, ctx.roomId, ctx.user.id, out);
}

/**
 * Emit a `message:new` to every socket in the room EXCEPT those whose user
 * has `ignores` row pointing at the sender. Looking up ignorers on each
 * send is fine at our scale - `ignores` is keyed by (userId, ignoredUserId)
 * and the typical block list is small. If this ever becomes hot, cache by
 * senderId with a short TTL.
 *
 * NOTE: System messages still go through `addSystemMessage` which uses a
 * direct `io.to(...).emit` - those should never be filterable by /ignore.
 */
async function emitFiltered(
  io: Io,
  db: Db,
  roomId: string,
  senderUserId: string,
  msg: ChatMessage,
): Promise<void> {
  const ignorerRows = await db
    .select({ userId: ignores.userId })
    .from(ignores)
    .where(eq(ignores.ignoredUserId, senderUserId));
  if (ignorerRows.length === 0) {
    io.to(`room:${roomId}`).emit("message:new", msg);
    return;
  }
  const ignorerSet = new Set(ignorerRows.map((r) => r.userId));
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid && ignorerSet.has(uid)) continue;
    s.emit("message:new", msg);
  }
}

/** Whisper / OOC keep their own theming; only say + me carry author color. */
function colorForKind(kind: MessageKind, color: string | null): string | null {
  if (color == null) return null;
  if (kind === "say" || kind === "me") return color;
  return null;
}

/** Server-authored system message (no associated user/character). */
export async function addSystemMessage(
  io: Io,
  db: Db,
  roomId: string,
  body: string,
): Promise<void> {
  const id = nanoid();
  const now = new Date();
  // System messages still need a userId column NOT NULL; we use the room owner
  // or a synthetic system user. For simplicity we attribute to the system
  // sentinel user 'system' which we ensure exists at boot.
  const sysUser = (await db.select().from(users).where(eq(users.username, "system")).limit(1))[0];
  if (!sysUser) return;
  await db.insert(messages).values({
    id,
    roomId,
    userId: sysUser.id,
    characterId: null,
    displayName: "system",
    kind: "system",
    body,
  });
  io.to(`room:${roomId}`).emit("message:new", {
    id,
    roomId,
    userId: sysUser.id,
    characterId: null,
    displayName: "system",
    kind: "system",
    body,
    createdAt: +now,
  });
}

export async function joinRoom(
  io: Io,
  db: Db,
  socket: Sock,
  user: SessionUser,
  roomId: string,
  opts: { passwordOk?: boolean } = {},
): Promise<void> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) {
    socket.emit("error:notice", { code: "NO_ROOM", message: "Room not found." });
    return;
  }

  const banned = (await db
    .select()
    .from(bans)
    .where(and(eq(bans.roomId, roomId), eq(bans.userId, user.id)))
    .limit(1))[0];
  if (banned && (!banned.until || +banned.until > Date.now())) {
    socket.emit("error:notice", { code: "BANNED", message: "You are banished from this room." });
    return;
  }

  // Private rooms: owner always in; otherwise need either a valid password OR
  // an outstanding /invite. /invite acts as a per-user whitelist that lets the
  // user skip the password prompt.
  if (room.type === "private" && room.ownerId !== user.id) {
    const invite = opts.passwordOk
      ? null
      : (await db
          .select()
          .from(roomInvites)
          .where(
            and(eq(roomInvites.roomId, roomId), eq(roomInvites.invitedUserId, user.id)),
          )
          .limit(1))[0];
    const member = (await db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.id)))
      .limit(1))[0];
    const allowed = opts.passwordOk || !!invite || !!member;
    if (!allowed) {
      socket.emit("ui:hint", {
        kind: "prompt-room-password",
        roomId: room.id,
        roomName: room.name,
      });
      return;
    }
  }

  // Upsert membership (best-effort). SQLite/Drizzle: use onConflictDoNothing.
  await db
    .insert(roomMembers)
    .values({ roomId, userId: user.id, role: "member" })
    .onConflictDoNothing();

  // Capture state BEFORE we mutate socket.rooms so we can tell:
  //   1. whether this is a fresh connect (no prior live socket of this user
  //      anywhere) - drives "X has connected" vs "X arrived";
  //   2. which rooms this socket is leaving - drives "X left." in each.
  const userWasOnlineBefore = await userIsOnline(io, user.id, socket.id);
  const priorRooms = [...socket.rooms]
    .filter((r) => r.startsWith("room:") && r !== `room:${roomId}`)
    .map((r) => r.slice(5));

  // Drop the user from any previous room before joining the new one. For each
  // prev room, emit "X left." iff this was their last socket there. Then
  // expire the prev room if it's now empty (and isn't a system room).
  for (const prevId of priorRooms) {
    socket.leave(`room:${prevId}`);
    const expired = await expireIfEmpty(io, db, prevId);
    if (expired) continue;
    const stillThere = await userHasSocketInRoom(io, user.id, prevId);
    if (!stillThere) {
      await addSystemMessage(io, db, prevId, `${user.displayName} left.`);
    }
    await broadcastPresence(io, db, prevId);
  }

  socket.join(`room:${roomId}`);

  socket.data.roomId = roomId;
  await broadcastRoomState(io, db, roomId);
  await broadcastPresence(io, db, roomId);

  // Send recent backlog to just this socket - minus history from anyone
  // they have on /ignore. We filter at the DB level (NOT IN subquery) so a
  // user with a long backlog of ignored authors doesn't pay for it client-side.
  //
  // PRIVACY: whispers are persisted in the room they were sent from (so
  // users can scroll back through their own DMs), but they must NEVER leak
  // to a third party. We exclude all whispers except those where this user
  // is the sender or the recipient. Admins are NOT exempt - even moderation
  // tooling never reads private content.
  //
  // The arrival announcement is emitted AFTER the backlog so the joining
  // socket doesn't see it twice (once in backlog, once via room broadcast).
  const ignoredIds = new Set(
    (await db
      .select({ ignoredUserId: ignores.ignoredUserId })
      .from(ignores)
      .where(eq(ignores.userId, user.id))).map((r) => r.ignoredUserId),
  );
  const recent = await db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .orderBy(desc(messages.createdAt))
    .limit(50);
  const backlog: ChatMessage[] = recent
    .filter((m) => !ignoredIds.has(m.userId))
    .filter((m) => {
      if (m.kind !== "whisper") return true;
      // Whispers: only sender + recipient see them. Everyone else is excluded.
      return m.userId === user.id || m.toUserId === user.id;
    })
    .reverse()
    .map((m) => ({
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
    }));
  socket.emit("message:bulk", backlog);

  // If the room has a /describe set, deliver it to JUST this socket as a
  // one-shot system message - not persisted, not broadcast. New visitors get
  // the world/setting description; ongoing chat stays clean. The
  // `[Description]:` prefix on its own line distinguishes the world prose
  // from regular system events (joins, kicks, mutes) at a glance.
  if (room.description) {
    socket.emit("message:new", {
      id: `desc-${nanoid()}`,
      roomId,
      userId: "system",
      characterId: null,
      displayName: "system",
      kind: "system",
      body: `[Description]:\n${room.description}`,
      color: null,
      createdAt: Date.now(),
    });
  }

  // Announce arrival only if this is the user's first socket in this room
  // (multi-tab users don't spam "arrived" each time they switch tabs). The
  // wording distinguishes a fresh connect from a room switch.
  const otherSocketHere = await userHasSocketInRoom(io, user.id, roomId, socket.id);
  if (!otherSocketHere) {
    const body = userWasOnlineBefore
      ? `${user.displayName} arrived.`
      : `${user.displayName} has connected.`;
    await addSystemMessage(io, db, roomId, body);
  }
}

/**
 * True iff the user has at least one live socket in the given room.
 * `excludeSocketId` skips the named socket - used at join time so the
 * caller's freshly-joined socket doesn't count as a "prior" presence.
 */
export async function userHasSocketInRoom(
  io: Io,
  userId: string,
  roomId: string,
  excludeSocketId?: string,
): Promise<boolean> {
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  for (const s of sockets) {
    if (excludeSocketId && s.id === excludeSocketId) continue;
    if ((s.data as { userId?: string }).userId === userId) return true;
  }
  return false;
}

/**
 * True iff the user has at least one live socket anywhere on the io server.
 * Used to distinguish "first connect" from "another tab" when announcing
 * arrivals.
 */
export async function userIsOnline(
  io: Io,
  userId: string,
  excludeSocketId?: string,
): Promise<boolean> {
  const sockets = await io.fetchSockets();
  for (const s of sockets) {
    if (excludeSocketId && s.id === excludeSocketId) continue;
    if ((s.data as { userId?: string }).userId === userId) return true;
  }
  return false;
}

export async function broadcastRoomState(
  io: Io,
  db: Db,
  roomId: string,
): Promise<void> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) return;
  const memberCountRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId));
  const summary: RoomSummary = {
    id: room.id,
    name: room.name,
    type: room.type,
    topic: room.topic,
    ownerId: room.ownerId,
    memberCount: memberCountRows[0]?.n ?? 0,
  };
  const occupants = await currentOccupants(io, db, roomId);
  io.to(`room:${roomId}`).emit("room:state", { room: summary, occupants });
}

export async function broadcastPresence(io: Io, db: Db, roomId: string): Promise<void> {
  const occupants = await currentOccupants(io, db, roomId);
  io.to(`room:${roomId}`).emit("presence:update", { roomId, occupants });
}

/**
 * If a user-created room has no live sockets in it, delete it. System rooms
 * (MainHall and friends with isSystem=true) are exempt so users always have
 * a default landing place. Cascade FKs clean up room_members, messages,
 * bans, invites. Returns true if the room was actually removed.
 */
export async function expireIfEmpty(io: Io, db: Db, roomId: string): Promise<boolean> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) return false;
  if (room.isSystem) return false;
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  if (sockets.length > 0) return false;
  await db.delete(rooms).where(eq(rooms.id, roomId));
  return true;
}

/**
 * Send room state + presence to a single socket without disturbing others in
 * the room. Used by /refresh and its auto-refresh interval - broadcasting to
 * the whole room every N seconds would create noise for users who didn't
 * opt in.
 */
export async function sendRoomStateTo(
  socket: Sock,
  io: Io,
  db: Db,
  roomId: string,
): Promise<void> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) return;
  const memberCountRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId));
  const summary: RoomSummary = {
    id: room.id,
    name: room.name,
    type: room.type,
    topic: room.topic,
    ownerId: room.ownerId,
    memberCount: memberCountRows[0]?.n ?? 0,
  };
  const occupants = await currentOccupants(io, db, roomId);
  socket.emit("room:state", { room: summary, occupants });
  socket.emit("presence:update", { roomId, occupants });
}

async function currentOccupants(io: Io, db: Db, roomId: string): Promise<RoomOccupant[]> {
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  const userIds = [...new Set(sockets.map((s) => (s.data as { userId?: string }).userId).filter(Boolean) as string[])];
  if (!userIds.length) return [];

  const userRows = await db
    .select()
    .from(users)
    .where(sql`${users.id} IN (${sql.join(userIds.map((u) => sql`${u}`), sql`, `)})`);

  const charIds = userRows
    .map((u) => u.activeCharacterId)
    .filter((v): v is string => !!v);
  const charRows = charIds.length
    ? await db
        .select()
        .from(characters)
        .where(sql`${characters.id} IN (${sql.join(charIds.map((c) => sql`${c}`), sql`, `)}) AND ${isNull(characters.deletedAt)}`)
    : [];
  const charById = new Map(charRows.map((c) => [c.id, c]));

  const memberRows = await db
    .select()
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, roomId),
        sql`${roomMembers.userId} IN (${sql.join(userIds.map((u) => sql`${u}`), sql`, `)})`,
      ),
    );
  const roleByUser = new Map(memberRows.map((m) => [m.userId, m.role]));

  return userRows.map<RoomOccupant>((u) => {
    const c = u.activeCharacterId ? charById.get(u.activeCharacterId) : undefined;
    return {
      userId: u.id,
      displayName: c ? c.name : u.username,
      characterId: c?.id ?? null,
      away: u.awayMessage != null,
      awayMessage: u.awayMessage,
      chatColor: u.chatColor,
      gender: resolveGender(u.gender, c?.statsJson),
      role: roleByUser.get(u.id) ?? "member",
    };
  });
}

/** When a character is active, prefer its stats.gender; else the user's OOC gender. */
function resolveGender(
  userGender: "male" | "female" | "nonbinary" | "other" | "undisclosed",
  characterStatsJson?: string | null,
): "male" | "female" | "nonbinary" | "other" | "undisclosed" {
  if (!characterStatsJson) return userGender;
  try {
    const parsed = JSON.parse(characterStatsJson) as { gender?: string };
    const g = parsed.gender?.toLowerCase();
    if (g === "male" || g === "female" || g === "nonbinary" || g === "other") return g;
  } catch { /* fall through */ }
  return userGender;
}
