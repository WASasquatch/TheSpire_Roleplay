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
import { extractMentions } from "@thekeep/shared";
import {
  bans,
  characters,
  ignores,
  messages,
  roomInvites,
  roomMembers,
  roomWorldLinks,
  rooms,
  users,
  watches,
  worldMembers,
  worlds,
} from "../db/schema.js";
import type { LinkedWorldRef } from "@thekeep/shared";
import { pushToUser } from "../push.js";
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
    /** Override the displayed name (used by /npc to inject the NPC's name in place of the author's). */
    displayNameOverride?: string;
    /** For /npc: the master username of the user who voiced this NPC. Rendered as a "voiced by" tag on the line. */
    npcVoicedBy?: string;
    /**
     * Thread-category bucket for top-level messages in nested-mode rooms.
     * Caller (`dispatchChatInput`) validates the id belongs to the room
     * and only forwards it for non-reply, plain sends — replies inherit
     * their parent's category implicitly through the thread relation.
     */
    threadCategoryId?: string | null;
    /**
     * Forum topic title. Set on new top-level posts in nested-mode
     * rooms (the master thread the replies live under). Caller is
     * responsible for trimming and length-capping; we just persist it.
     */
    title?: string | null;
  },
): Promise<void> {
  const id = nanoid();
  const now = new Date();
  // System messages (server-authored via addSystemMessage) bypass this path,
  // so user-authored kinds inherit the author's snapshotted color unless
  // an explicit override is supplied.
  const baseColor = payload.color !== undefined ? payload.color : ctx.user.chatColor;
  const colorSnapshot = colorForKind(payload.kind, baseColor);
  const displayName = payload.displayNameOverride ?? ctx.user.displayName;
  // Mood snapshots only on actually-spoken kinds, never on /npc lines (the
  // NPC isn't the user — applying their mood would be misleading).
  const moodSnapshot = payload.kind === "npc" ? null : ctx.user.currentMood ?? null;
  // Avatar snapshot. Prefer the active character's avatar so a forum
  // post stays visually attached to the character it was authored as
  // even if the user later switches characters or that character is
  // deleted. Fall back to the master account's avatar for OOC posts.
  let avatarSnapshot: string | null = null;
  if (ctx.user.activeCharacterId) {
    const c = (await ctx.db
      .select({ avatarUrl: characters.avatarUrl })
      .from(characters)
      .where(eq(characters.id, ctx.user.activeCharacterId))
      .limit(1))[0];
    if (c?.avatarUrl) avatarSnapshot = c.avatarUrl;
  }
  if (!avatarSnapshot) {
    const u = (await ctx.db
      .select({ avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1))[0];
    if (u?.avatarUrl) avatarSnapshot = u.avatarUrl;
  }
  await ctx.db.insert(messages).values({
    id,
    roomId: ctx.roomId,
    userId: ctx.user.id,
    characterId: ctx.user.activeCharacterId,
    displayName,
    kind: payload.kind,
    body: payload.body,
    color: colorSnapshot,
    toUserId: payload.toUserId ?? null,
    replyToId: payload.replyToId ?? null,
    replyToDisplayName: payload.replyToDisplayName ?? null,
    replyToBodySnippet: payload.replyToBodySnippet ?? null,
    moodSnapshot,
    npcVoicedBy: payload.npcVoicedBy ?? null,
    threadCategoryId: payload.threadCategoryId ?? null,
    title: payload.title ?? null,
    avatarUrl: avatarSnapshot,
    // last_activity_at on insert:
    //   - top-level row (topic, or any flat-chat message): its own
    //     createdAt — for forum topics this seeds the ordering before
    //     any replies arrive; for flat messages it's unused.
    //   - reply: null on the reply itself (the column is only read on
    //     topics), and the parent topic gets a separate UPDATE below.
    lastActivityAt: payload.replyToId ? null : now,
  });
  // For replies, bump the parent topic's last_activity_at so the forum
  // pagination's DESC order surfaces this thread to the top on the
  // next refresh. We do this best-effort: if the parent has been
  // deleted or paged out the UPDATE just affects 0 rows. Skip for
  // non-reply rows (already covered by the insert above).
  if (payload.replyToId) {
    await ctx.db
      .update(messages)
      .set({ lastActivityAt: now })
      .where(eq(messages.id, payload.replyToId));
  }
  const out: ChatMessage = {
    id,
    roomId: ctx.roomId,
    userId: ctx.user.id,
    characterId: ctx.user.activeCharacterId,
    displayName,
    kind: payload.kind,
    body: payload.body,
    color: colorSnapshot,
    createdAt: +now,
    ...(payload.toUserId ? { toUserId: payload.toUserId } : {}),
    ...(payload.replyToId ? { replyToId: payload.replyToId } : {}),
    ...(payload.replyToDisplayName ? { replyToDisplayName: payload.replyToDisplayName } : {}),
    ...(payload.replyToBodySnippet ? { replyToBodySnippet: payload.replyToBodySnippet } : {}),
    ...(moodSnapshot ? { moodSnapshot } : {}),
    ...(payload.npcVoicedBy ? { npcVoicedBy: payload.npcVoicedBy } : {}),
    ...(payload.threadCategoryId ? { threadCategoryId: payload.threadCategoryId } : {}),
    ...(payload.title ? { title: payload.title } : {}),
    ...(avatarSnapshot ? { avatarUrl: avatarSnapshot } : {}),
    // Top-level messages carry their seeded lastActivityAt; replies
    // don't (the column is unused on reply rows, and the parent's
    // separate UPDATE above is what the client listens for).
    ...(payload.replyToId ? {} : { lastActivityAt: +now }),
  };
  await emitFiltered(ctx.io, ctx.db, ctx.roomId, ctx.user.id, out);

  // Belt-and-suspenders: emit directly to the sender's socket too. The
  // room broadcast above only reaches sockets currently subscribed to
  // `room:${roomId}`, and a race between a fast room-switch and a send
  // (or a transient socket.io reconnect) can leave the sender's socket
  // unsubscribed at the moment of broadcast — they'd miss their own
  // message and not see it again until a page refetch pulled it from
  // history. The client-side `appendMessage` dedupes by id, so this
  // duplicate-on-the-wire is invisible in the typical happy path
  // (socket is in the room → first delivery wins, second is dropped).
  ctx.socket.emit("message:new", out);

  // Fire-and-forget push triggers for offline recipients. Privacy contract:
  // payloads carry only the *kind* of event ("whisper" / "mention") and the
  // author's display name - never the body. The user has to come back to
  // the chat to read what was said.
  void pushTriggers(ctx.io, ctx.db, out, ctx.user, payload.kind);
}

/**
 * Push to anyone who would otherwise miss this message because they're not
 * connected. Currently fires for whispers (always to the recipient) and
 * @mentions (to each mentioned user who has at least one push subscription
 * and no live socket). Always best-effort - failures are logged inside
 * pushToUser, never thrown.
 *
 * Exported so the whisper handler can fire push directly — whispers don't
 * route through `addMessage` (which would broadcast to the whole room),
 * so without an explicit call here offline-recipient push notifications
 * never fire.
 */
export async function pushTriggers(
  io: Io,
  db: Db,
  msg: ChatMessage,
  sender: SessionUser,
  kind: MessageKind,
): Promise<void> {
  try {
    if (kind === "whisper" && msg.toUserId) {
      const targetOnline = await userIsOnline(io, msg.toUserId);
      if (!targetOnline) {
        await pushToUser(db, msg.toUserId, {
          title: `${sender.displayName} whispers`,
          body: "You have a whisper waiting.",
          tag: `whisper-${sender.id}`,
        });
      }
      return;
    }
    // Mention path - skip for system / scene / npc kinds (system has no
    // human author; scene/npc bodies aren't typically directed at anyone).
    if (kind !== "say" && kind !== "me" && kind !== "ooc" && kind !== "announce") return;

    const names = extractMentions(msg.body);
    if (names.length === 0) return;

    // Resolve mention names to user ids. Mentions can match either a master
    // username OR an active character name; the userlist resolver path
    // already handles both. Cheap to do per-name since most messages have
    // zero or one mention.
    const seen = new Set<string>();
    for (const name of names) {
      if (name === sender.username.toLowerCase()) continue;
      const lower = name.toLowerCase();
      // Master username first (globally unique).
      let target = (await db
        .select()
        .from(users)
        .where(sql`lower(${users.username}) = ${lower}`)
        .limit(1))[0];
      if (!target) {
        // Active character name lookup.
        const c = (await db
          .select()
          .from(characters)
          .where(sql`lower(${characters.name}) = ${lower}`)
          .limit(1))[0];
        if (c && !c.deletedAt) {
          const owner = (await db.select().from(users).where(eq(users.id, c.userId)).limit(1))[0];
          if (owner && owner.activeCharacterId === c.id) target = owner;
        }
      }
      if (!target || target.disabledAt || target.id === sender.id) continue;
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      const targetOnline = await userIsOnline(io, target.id);
      if (targetOnline) continue;
      await pushToUser(db, target.id, {
        title: `Mention from ${sender.displayName}`,
        body: "You were mentioned in chat.",
        tag: `mention-${sender.id}`,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[push] trigger failed", { err });
  }
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

/**
 * Reconnect grace period for "has connected" / "has disconnected".
 *
 * Socket-level lifecycles don't map cleanly to user-level lifecycles. A user
 * sitting in a room can have their socket transiently drop and reconnect for
 * many reasons that have nothing to do with them logging in or out:
 * background-throttled tabs, brief network blips, server reload in dev, even
 * the socket.io heartbeat misfiring once. With no grace, every blip emits
 * "X has disconnected" + "X has connected" + a description re-broadcast,
 * which is misleading both to the affected user and to everyone else in the
 * room (it looks like they came and went, when actually they were here the
 * whole time).
 *
 * The mechanism: when a user's last socket disconnects, we don't announce it
 * immediately - we schedule the announcement (and the userlist re-broadcast)
 * for PRESENCE_GRACE_MS in the future. If the user reconnects inside that
 * window, joinRoom() consumes the pending entry, the timer is canceled, and
 * we skip the "has connected" message + the room description re-emit. The
 * net effect: a transient reconnect leaves no visible artifact in the chat
 * log or the userlist. A genuine disconnect (browser closed, user went away)
 * still surfaces - just delayed by the grace window.
 *
 * Map size is bounded by the number of users currently in their grace
 * window. Entries self-clear via the timer or via consumePendingDisconnect.
 */
const PRESENCE_GRACE_MS = 20_000;
type PendingDisconnect = { timer: NodeJS.Timeout };
const pendingDisconnects = new Map<string, PendingDisconnect>();

/**
 * Server-boot quiet window. The pendingDisconnects map above only survives
 * inside a single process lifetime - any restart (tsx-watch reload in dev,
 * a real Fly deploy in prod) wipes it. Without a boot-grace, every client
 * that reconnects after the restart shows up looking like a fresh connect
 * and we paint a "has connected" line for each one - which is wrong both
 * semantically (they never left, the SERVER left) and visually (a single
 * dev-loop edit can spam dozens of these into the chat).
 *
 * So: for the first BOOT_GRACE_MS after this process starts, we suppress
 * "has connected" announcements entirely. Real fresh connects after the
 * window starts behaving normally. The trade-off in prod is that the very
 * first cohort of reconnects after a deploy aren't announced - which is
 * the desired behavior anyway, since those users were already in the room
 * before the deploy.
 */
const BOOT_GRACE_MS = 30_000;
const BOOT_TIME_MS = Date.now();
function isInBootGrace(): boolean {
  return Date.now() - BOOT_TIME_MS < BOOT_GRACE_MS;
}

/**
 * Cancel a pending disconnect for this user, if any. Returns true when one
 * was canceled - meaning this connect is a reconnect inside the grace window
 * and the caller should suppress the "has connected" announcement.
 */
export function consumePendingDisconnect(userId: string): boolean {
  const pd = pendingDisconnects.get(userId);
  if (!pd) return false;
  clearTimeout(pd.timer);
  pendingDisconnects.delete(userId);
  return true;
}

/**
 * Defer the user's "has disconnected" work by PRESENCE_GRACE_MS. The caller
 * provides a `fire` function that emits the per-room system messages and
 * broadcasts presence. If the user reconnects in the meantime,
 * consumePendingDisconnect cancels the timer and `fire` never runs.
 */
export function schedulePendingDisconnect(
  userId: string,
  fire: () => Promise<void> | void,
): void {
  // Replace any existing entry. With single-presence this rarely matters,
  // but it's the safe behavior under racing disconnects.
  const existing = pendingDisconnects.get(userId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingDisconnects.delete(userId);
    Promise.resolve(fire()).catch(() => {});
  }, PRESENCE_GRACE_MS);
  pendingDisconnects.set(userId, { timer });
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

/**
 * Resolve the canonical landing room. Used by every "where do we put this
 * user" path: cold-connect with no sibling tab and no last-room memory,
 * kick / ban relocation, and admin room-delete.
 *
 * Resolution order:
 *   1. The admin-flagged default room (rooms.is_default = 1). Exactly one
 *      row carries the flag thanks to the partial unique index. This is
 *      the source of truth on any post-migration install.
 *   2. Legacy fallback by name (`The_Spire`) for installs that haven't
 *      yet flipped the flag — the seed migrates them on next boot, but
 *      this guards the gap.
 *   3. The alphabetically-first system room as a last resort so a
 *      malformed install (no default, no Spire) still lands users
 *      somewhere deterministic instead of SQLite's natural row order.
 */
export async function findCanonicalLanding(db: Db): Promise<typeof rooms.$inferSelect | null> {
  const defaulted = (await db.select().from(rooms).where(eq(rooms.isDefault, true)).limit(1))[0];
  if (defaulted) return defaulted;
  const named = (await db.select().from(rooms).where(eq(rooms.name, "The_Spire")).limit(1))[0];
  if (named) return named;
  const fallback = (await db
    .select()
    .from(rooms)
    .where(eq(rooms.isSystem, true))
    .orderBy(asc(rooms.name))
    .limit(1))[0];
  return fallback ?? null;
}

/**
 * Send the per-viewer-filtered recent backlog for `roomId` to a single
 * socket. Mirrors the slice joinRoom assembles on a fresh join: ignored
 * authors are dropped, whispers are visible only to sender/recipient,
 * deleted bodies are blanked. Extracted so the moderation-relocate path
 * (kick / ban / admin room-delete) can land the booted socket on a
 * properly-populated chat log instead of leaving it stuck on the room
 * they were just removed from.
 *
 * Accepts a structural type so it works with both `Socket` (from event
 * handlers) and `RemoteSocket` (from `io.fetchSockets()`).
 */
export async function sendRoomBacklogTo(
  socket: { emit(event: "message:bulk", payload: ChatMessage[]): unknown },
  db: Db,
  roomId: string,
  viewerUserId: string,
): Promise<void> {
  const ignoredIds = new Set(
    (await db
      .select({ ignoredUserId: ignores.ignoredUserId })
      .from(ignores)
      .where(eq(ignores.userId, viewerUserId))).map((r) => r.ignoredUserId),
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
      return m.userId === viewerUserId || m.toUserId === viewerUserId;
    })
    .reverse()
    .map((m) => ({
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
  socket.emit("message:bulk", backlog);
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
  // Reconnect detection: if a "has disconnected" was scheduled for this user
  // and hasn't fired yet, this connect is a reconnect inside the grace window.
  // Cancel the pending disconnect; further down we use this flag to suppress
  // the "has connected" message + the room description re-emit so the chat
  // log shows nothing happened.
  const isReconnect = consumePendingDisconnect(user.id);
  const priorRooms = [...socket.rooms]
    .filter((r) => r.startsWith("room:") && r !== `room:${roomId}`)
    .map((r) => r.slice(5));

  // Drop the user from any previous room before joining the new one. For each
  // prev room, emit "X left." iff this was their last socket there. Then
  // expire the prev room if it's now empty (and isn't a system room).
  //
  // Forum rooms (replyMode = nested) suppress the "X left." line — the
  // posting model there is forum-style, not chat, and join/leave noise
  // would just clutter the topic list.
  for (const prevId of priorRooms) {
    socket.leave(`room:${prevId}`);
    const expired = await expireIfEmpty(io, db, prevId);
    if (expired) continue;
    const stillThere = await userHasSocketInRoom(io, user.id, prevId);
    if (!stillThere) {
      const prevRoom = (await db.select().from(rooms).where(eq(rooms.id, prevId)).limit(1))[0];
      if (prevRoom?.replyMode !== "nested") {
        await addSystemMessage(io, db, prevId, `${user.displayName} left.`);
      }
    }
    await broadcastPresence(io, db, prevId);
  }

  socket.join(`room:${roomId}`);

  socket.data.roomId = roomId;
  await broadcastRoomState(io, db, roomId);
  await broadcastPresence(io, db, roomId);

  // Send recent backlog to just this socket. Whisper privacy + ignore
  // filtering + soft-delete blanking all live in sendRoomBacklogTo so the
  // moderation-relocate path uses the same logic.
  //
  // The arrival announcement is emitted AFTER the backlog so the joining
  // socket doesn't see it twice (once in backlog, once via room broadcast).
  await sendRoomBacklogTo(socket, db, roomId, user.id);

  // If the room has a /describe set, deliver it to JUST this socket as a
  // one-shot system message - not persisted, not broadcast. New visitors get
  // the world/setting description; ongoing chat stays clean. The
  // `[Description]:` prefix runs inline with the prose so the line reads
  // like the other system events (joins, kicks, mutes) at a glance.
  //
  // Suppressed on reconnect: the user just saw it before the blip, no point
  // showing it again. (If a reconnect lands them in a different room than
  // they were in, they don't get the description there either - acceptable
  // edge case; description is a lightweight nice-to-have, not load-bearing.)
  //
  // Also suppressed in forum (nested) rooms — the description is a
  // chat-flavored welcome and would clutter the topic feed there.
  // The room banner / metadata surfaces the description via other UI
  // affordances in those rooms.
  if (room.description && !isReconnect && room.replyMode !== "nested") {
    socket.emit("message:new", {
      id: `desc-${nanoid()}`,
      roomId,
      userId: "system",
      characterId: null,
      displayName: "system",
      kind: "system",
      body: `[Description]: ${room.description}`,
      color: null,
      createdAt: Date.now(),
    });
  }

  // Announce arrival only if this is the user's first socket in this room
  // (multi-tab users don't spam "arrived" each time they switch tabs). The
  // wording distinguishes a fresh connect from a room switch.
  //
  // Three suppression cases:
  //   - inside the per-user grace window after a recent disconnect (covers
  //     transient blips during steady-state operation);
  //   - inside the server-boot quiet window (covers reconnect cohorts after
  //     a process restart, which would otherwise spam "has connected" once
  //     per client that returns);
  //   - room-switches: the user already had a socket here ("arrived") goes
  //     through, but only when they were online before this socket existed.
  const otherSocketHere = await userHasSocketInRoom(io, user.id, roomId, socket.id);
  const suppressed = isReconnect || (!userWasOnlineBefore && isInBootGrace());
  // Forum rooms suppress arrival lines — the topic feed is not a chat
  // log. Watcher pings still fire (those are private DMs to the
  // watcher, not in-room noise).
  const isForumRoom = room.replyMode === "nested";
  if (!otherSocketHere && !suppressed && !isForumRoom) {
    const body = userWasOnlineBefore
      ? `${user.displayName} arrived.`
      : `${user.displayName} has connected.`;
    await addSystemMessage(io, db, roomId, body);
  }
  if (!otherSocketHere && !suppressed && !userWasOnlineBefore) {
    // Watcher pings: still relevant in forum rooms — they're per-user
    // notifications, not room broadcasts. Fire whenever this is a
    // true online transition regardless of room type.
    await pingWatchers(io, db, user);
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

/**
 * Single source of truth for the wire-shape of a room. Used by every
 * surface that emits a RoomSummary (the websocket broadcasts AND the
 * `GET /rooms` HTTP route) so the optional `linkedWorld`/`npcDisabled`/
 * `messageExpiryMinutes`/`replyMode` fields always land populated. When
 * /rooms used to construct its own summary inline, those fields were
 * silently undefined, which broke the rail's primary-world grouping.
 */
export async function buildRoomSummary(
  db: Db,
  room: typeof rooms.$inferSelect,
): Promise<RoomSummary> {
  const memberCountRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, room.id));
  return {
    id: room.id,
    name: room.name,
    type: room.type,
    topic: room.topic,
    ownerId: room.ownerId,
    memberCount: memberCountRows[0]?.n ?? 0,
    npcDisabled: room.npcDisabled,
    linkedWorld: await loadLinkedWorld(db, room.id),
    messageExpiryMinutes: room.messageExpiryMinutes,
    replyMode: room.replyMode,
  };
}

export async function broadcastRoomState(
  io: Io,
  db: Db,
  roomId: string,
): Promise<void> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) return;
  const summary = await buildRoomSummary(db, room);
  const occupants = await currentOccupants(io, db, roomId);
  io.to(`room:${roomId}`).emit("room:state", { room: summary, occupants });
}

export async function broadcastPresence(io: Io, db: Db, roomId: string): Promise<void> {
  const occupants = await currentOccupants(io, db, roomId);
  io.to(`room:${roomId}`).emit("presence:update", { roomId, occupants });
}

/**
 * Resolve the world linked to a room, if any. Returns the brief identity
 * record the client uses to render the chat banner. Cheap join (no page
 * data; the viewer modal fetches that on demand).
 */
async function loadLinkedWorld(db: Db, roomId: string): Promise<LinkedWorldRef | null> {
  const link = (await db.select().from(roomWorldLinks).where(eq(roomWorldLinks.roomId, roomId)).limit(1))[0];
  if (!link) return null;
  const w = (await db.select().from(worlds).where(eq(worlds.id, link.worldId)).limit(1))[0];
  if (!w) return null;
  const owner = (await db.select({ username: users.username }).from(users).where(eq(users.id, w.ownerUserId)).limit(1))[0];
  return {
    id: w.id,
    slug: w.slug,
    name: w.name,
    ownerUsername: owner?.username ?? "(deleted user)",
  };
}

/**
 * Fan out a `watch:online` push to every live socket of every user who
 * watches the user that just came online. Quiet failures are logged via the
 * caller (we don't want one stale watcher's socket failure to block the
 * connect path).
 */
async function pingWatchers(io: Io, db: Db, user: SessionUser): Promise<void> {
  const watchers = await db
    .select({ watcherUserId: watches.watcherUserId })
    .from(watches)
    .where(eq(watches.watchedUserId, user.id));
  if (watchers.length === 0) return;
  const watcherSet = new Set(watchers.map((w) => w.watcherUserId));
  const sockets = await io.fetchSockets();
  const payload = {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
  };
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid && watcherSet.has(uid)) {
      s.emit("watch:online", payload);
    }
  }
}

/**
 * If a user-created room has no live sockets in it, delete it. System rooms
 * (those with isSystem=true, e.g. The_Spire) are exempt so users always
 * have a default landing place. Cascade FKs clean up room_members,
 * messages, bans, invites. Returns true if the room was actually removed.
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
  const summary = await buildRoomSummary(db, room);
  const occupants = await currentOccupants(io, db, roomId);
  socket.emit("room:state", { room: summary, occupants });
  socket.emit("presence:update", { roomId, occupants });
}

export async function currentOccupants(io: Io, db: Db, roomId: string): Promise<RoomOccupant[]> {
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

  // Primary-world lookup for the userlist's grouping. One query joining
  // world_members → worlds, filtered to is_primary = 1 + the active users.
  // The map keys on userId so the render loop can attach a LinkedWorldRef
  // (or leave it null for unaffiliated users).
  const primaryWorldRows = await db
    .select({
      userId: worldMembers.userId,
      worldId: worlds.id,
      slug: worlds.slug,
      name: worlds.name,
      ownerUserId: worlds.ownerUserId,
    })
    .from(worldMembers)
    .innerJoin(worlds, eq(worlds.id, worldMembers.worldId))
    .where(and(
      eq(worldMembers.isPrimary, 1),
      sql`${worldMembers.userId} IN (${sql.join(userIds.map((u) => sql`${u}`), sql`, `)})`,
    ));
  // Owner-username lookup for primary worlds (so the userlist banner can
  // show "by <owner>"). Resolved once per distinct owner across the batch.
  const ownerIds = [...new Set(primaryWorldRows.map((r) => r.ownerUserId))];
  const ownerUsernameById = new Map<string, string>();
  if (ownerIds.length) {
    const ownerRows = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(sql`${users.id} IN (${sql.join(ownerIds.map((u) => sql`${u}`), sql`, `)})`);
    for (const o of ownerRows) ownerUsernameById.set(o.id, o.username);
  }
  const primaryWorldByUser = new Map<string, LinkedWorldRef>(
    primaryWorldRows.map((r) => [
      r.userId,
      {
        id: r.worldId,
        slug: r.slug,
        name: r.name,
        ownerUsername: ownerUsernameById.get(r.ownerUserId) ?? "(deleted user)",
      },
    ]),
  );

  return userRows
    // Privacy: a user whose master profile is marked private
    // (`users.isPublic = false`) only surfaces in the userlist while
    // *actively using* a character. In OOC mode (no active character)
    // they're filtered out entirely — the (ooc) badge would otherwise
    // expose the master username they specifically opted out of
    // publishing. Active-character rows still appear (and only the
    // character name is shown; the master link is independently gated
    // on the profile endpoint). Side-effect: the room's occupant
    // count reflects what's visible, not raw socket presence — fine,
    // since invisible users are by definition not "in" the room from
    // a viewer's perspective.
    .filter((u) => u.isPublic || !!u.activeCharacterId)
    .map<RoomOccupant>((u) => {
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
        accountRole: u.role,
        mood: u.currentMood,
        primaryWorld: primaryWorldByUser.get(u.id) ?? null,
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
