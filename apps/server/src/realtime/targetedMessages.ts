/**
 * Per-user-targeted system messages.
 *
 * Most system lines (presence, /announce, game results) are written by
 * `addSystemMessage` with a NULL `targetUserId`, so they persist and show
 * to EVERYONE in the room. A few notifications, though, are meant for one
 * recipient: "a watched friend came online", "you have a friend request",
 * "a story you follow published", and the per-room "[Description]:" line.
 * Those used to be synthesized client-side (or emitted to a single socket)
 * and never stored, so they vanished the moment the room buffer was
 * replaced by a refetch (a reconnect / room re-join). This module persists
 * them, scoped to the recipient via `messages.targetUserId`, so they
 * survive — while `roomVisibilityWhere` keeps every backlog read from
 * leaking one user's targeted line to anyone else.
 *
 * We deliberately do NOT emit these live: the client still shows the
 * instant copy from the existing `watch:online` / `friend:request` /
 * `story:chapter-published` events and the join-time description emit (so
 * older cached bundles keep working), and because a room (re)join replaces
 * the buffer wholesale (`setMessages`), the stored copy slots into the
 * synthesized one's place on the next load — no double render.
 */
import { and, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { messages, rooms, users } from "../db/schema.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

const SYSTEM_USERNAME = "system";

/**
 * WHERE fragment shared by every room-backlog read (live join bulk,
 * scroll-up, jump-window, export). Three visibility classes:
 *   1. public room rows — non-whisper, no per-user target
 *   2. whispers the viewer is a party to (overlaid across rooms)
 *   3. targeted system rows in THIS room, only for their recipient
 * This is the single source of truth; callers must not hand-roll the union
 * or the classes drift out of sync (the bug this replaced).
 *
 * `targetServerId` (the loaded room's server, NULL→default) scopes whispers to
 * the same server, so a whisper sent in one server no longer overlays into
 * another server's room backlog/export. Callers pass `room.serverId ??
 * DEFAULT_SERVER_ID` (they already hold the room row). With the servers flag
 * off every room resolves to the default server, so the predicate matches all
 * whispers — byte-identical to before. Omitting it (legacy) skips the scope.
 *
 * `viewerCanSeeNsfw` (age-restriction plan, Phase 2) filters rows STAMPED
 * `is_nsfw` at write time (server OR room was 18+ when the line was sent).
 * Chat surfaces pass the HARD tier (`viewer.isAdult` — the adult hide
 * preference does NOT hide chat history); softer surfaces may pass
 * `canSeeNsfw(viewer)`. For a room that is CURRENTLY 18+ this is
 * belt-and-braces (minors can't enter at all); it is what keeps a
 * flipped-back room's 18+-era history — and, in Phase 3, NSFW forum
 * topics — hidden from minors. Required so no call site can forget it.
 */
export function roomVisibilityWhere(
  // A single room, or BOTH rooms of an 18+ channel pair for the staff
  // merged-oversight view (lib/pairStaffView.ts) — callers must qualify
  // the viewer via canSeePairFeeds before passing two ids.
  roomId: string | readonly string[],
  viewerUserId: string,
  targetServerId: string | undefined,
  viewerCanSeeNsfw: boolean,
) {
  const roomMatch = Array.isArray(roomId)
    ? inArray(messages.roomId, roomId as string[])
    : eq(messages.roomId, roomId as string);
  return or(
    // 1. Ordinary public rows in this room. `targetUserId IS NULL` excludes
    //    the per-user notifications so they never show to the whole room.
    //    Rows stamped 18+ at write time are withheld from viewers who can't
    //    see NSFW (whispers and targeted rows are never stamped — whispers
    //    are participant-scoped and minors can't be party to 18+-room ones).
    and(
      sql`${messages.kind} != 'whisper'`,
      roomMatch,
      isNull(messages.targetUserId),
      ...(viewerCanSeeNsfw ? [] : [eq(messages.isNsfw, false)]),
    ),
    // 2. Whispers the viewer sent or received — overlaid across this server's
    //    rooms only. The same-server predicate compares the whisper's ORIGIN
    //    room server to the loaded room's server (NULL→default on both sides).
    and(
      sql`${messages.kind} = 'whisper'`,
      or(eq(messages.userId, viewerUserId), eq(messages.toUserId, viewerUserId)),
      ...(targetServerId
        ? [sql`COALESCE((SELECT r.server_id FROM rooms r WHERE r.id = ${messages.roomId}), ${DEFAULT_SERVER_ID}) = ${targetServerId}`]
        : []),
    ),
    // 3. Targeted system notifications: this room, recipient only.
    and(
      roomMatch,
      isNotNull(messages.targetUserId),
      eq(messages.targetUserId, viewerUserId),
    ),
  );
}

async function systemUserId(db: Db): Promise<string | null> {
  const row = (await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, SYSTEM_USERNAME))
    .limit(1))[0];
  return row?.id ?? null;
}

/**
 * Persist one targeted system line into a room for a single recipient.
 * Not emitted live (see module header). No-op if the system sentinel user
 * is missing (boot ensures it exists).
 */
export async function persistTargetedSystemMessage(
  db: Db,
  targetUserId: string,
  roomId: string,
  body: string,
): Promise<void> {
  const sysId = await systemUserId(db);
  if (!sysId) return;
  await db.insert(messages).values({
    id: nanoid(),
    roomId,
    userId: sysId,
    characterId: null,
    displayName: SYSTEM_USERNAME,
    kind: "system",
    body,
    targetUserId,
  });
}

/**
 * Persist a targeted system line into every NON-FORUM room each recipient
 * currently occupies (one row per distinct room), matching where the client
 * synthesizes the live copy. One `fetchSockets` + one room lookup + one
 * batch insert regardless of how many recipients. No-op for anyone who is
 * offline or only present in forum/nested rooms (whose feed is a topic
 * list, not a flat chat log, so a system line has no home there).
 */
export async function persistTargetedSystemMessageToActiveRooms(
  io: Io,
  db: Db,
  targetUserIds: string | Iterable<string>,
  body: string,
  // emitLive: ALSO deliver the persisted rows to the recipients' open
  // sockets as live system lines. Default OFF — the legacy callers
  // (friend requests etc.) pair this with a client-synthesized live copy
  // for old-bundle compat, and emitting here too would double the line.
  // New notification kinds with NO client synthesis (room invites) pass
  // true so the line lands in-chat immediately, not only after a refetch.
  opts: { emitLive?: boolean } = {},
): Promise<void> {
  const targets = new Set(typeof targetUserIds === "string" ? [targetUserIds] : targetUserIds);
  if (targets.size === 0) return;

  const sockets = await io.fetchSockets();
  // recipient userId -> set of rooms they currently have a socket in
  const roomsByUser = new Map<string, Set<string>>();
  const allRooms = new Set<string>();
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (!uid || !targets.has(uid)) continue;
    const r = (s.data as { roomId?: string }).roomId;
    if (typeof r !== "string" || !r) continue;
    let set = roomsByUser.get(uid);
    if (!set) { set = new Set(); roomsByUser.set(uid, set); }
    set.add(r);
    allRooms.add(r);
  }
  if (allRooms.size === 0) return;

  const roomRows = await db
    .select({ id: rooms.id, replyMode: rooms.replyMode })
    .from(rooms)
    .where(inArray(rooms.id, [...allRooms]));
  const nested = new Set(roomRows.filter((r) => r.replyMode === "nested").map((r) => r.id));

  const sysId = await systemUserId(db);
  if (!sysId) return;

  const rows = [];
  for (const [uid, rset] of roomsByUser) {
    for (const roomId of rset) {
      if (nested.has(roomId)) continue;
      rows.push({
        id: nanoid(),
        roomId,
        userId: sysId,
        characterId: null,
        displayName: SYSTEM_USERNAME,
        kind: "system" as const,
        body,
        targetUserId: uid,
      });
    }
  }
  if (rows.length > 0) {
    await db.insert(messages).values(rows);
    if (opts.emitLive) {
      const now = Date.now();
      for (const row of rows) {
        for (const s of sockets) {
          const uid = (s.data as { userId?: string }).userId;
          if (uid !== row.targetUserId) continue;
          if ((s.data as { roomId?: string }).roomId !== row.roomId) continue;
          s.emit("message:new", {
            id: row.id,
            roomId: row.roomId,
            userId: row.userId,
            characterId: null,
            displayName: row.displayName,
            kind: "system",
            body: row.body,
            color: null,
            createdAt: now,
          });
        }
      }
    }
  }
}

/**
 * Persist the per-room "[Description]:" line for a user, exactly once ever
 * per (user, room). Returns true iff a row was newly written (i.e. this is
 * a genuinely first-time view), false if one already existed. The join path
 * uses that to decide whether to ALSO emit the live copy: on a process
 * restart the in-memory "seen description" set resets, but a persisted copy
 * already rides the backlog, so re-emitting live would double it — gating
 * the emit on this return value avoids that.
 */
export async function persistRoomDescriptionOnce(
  db: Db,
  targetUserId: string,
  roomId: string,
  body: string,
): Promise<boolean> {
  const existing = (await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(
      eq(messages.roomId, roomId),
      eq(messages.targetUserId, targetUserId),
      like(messages.body, "[Description]:%"),
    ))
    .limit(1))[0];
  if (existing) return false;
  await persistTargetedSystemMessage(db, targetUserId, roomId, body);
  return true;
}
