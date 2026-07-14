/**
 * Info rooms (read-only posting mode, migration 0345) — the "who may post
 * here" lane.
 *
 * A room with `post_mode = 'staff'` accepts chat posts ONLY from:
 *   - site staff (mod / admin / masteradmin),
 *   - the room owner (`rooms.owner_id`),
 *   - room mods (`room_members.role` owner/mod — per-ACCOUNT authority,
 *     matching every other room-moderation gate),
 *   - the room's server staff (`server_members.role` owner/admin/mod; a
 *     NULL `rooms.server_id` homes to the default server).
 *
 * Everyone else reads only — but reactions stay open (Discord
 * announcement-channel behavior), whispers and non-posting commands are
 * unaffected, and forum boards (`rooms.forum_id` set) are excluded
 * entirely (boards carry their own permission system).
 *
 * `post_mode = 'roles'` (migration 0349) widens the poster set: the staff
 * set above PLUS holders of any usergroup with a kind='post' row in
 * `room_role_gates`. 'staff' mode ignores role rows — staff wins.
 *
 * This module is the single audit point for that rule:
 *   - the qualification check (canPostInStaffRoom), consulted by the chat
 *     dispatch chokepoint BEFORE rate limits;
 *   - the per-socket `postLocked` stamp (stampPostLocked), cached on
 *     socket.data at join time — same posture as `stampPairStaffView` —
 *     so the hot summary paths read it without queries. It is NEVER
 *     computed per presence broadcast.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { isModeratorRole, type Role } from "@thekeep/shared";
import { roomMembers, roomRoleGates, rooms, serverMembers, serverUsergroupMembers } from "../db/schema.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import type { Db } from "../db/index.js";

/** The room fields the gate needs — a full row always satisfies this. */
export interface PostModeRoom {
  id: string;
  ownerId: string | null;
  serverId: string | null;
  postMode: "everyone" | "staff" | "roles";
  forumId: string | null;
}

/**
 * Info room = a read-only chat room (`post_mode = 'staff'`). Forum boards
 * are excluded (their permission system is separate and they never hold
 * sockets). 'roles' rooms are conversation spaces for their role-holders
 * and are NOT info rooms: they keep normal presence. Single predicate so
 * the presence-attribution layer, the rail, and the landing pickers can't
 * drift on what counts as "informational".
 */
export function isInfoRoom(room: Pick<PostModeRoom, "postMode" | "forumId">): boolean {
  return room.postMode === "staff" && !room.forumId;
}

/**
 * "Does ANY info room exist?" flag for the presence attribution pass.
 * currentOccupants runs on every presence broadcast and its reader scan
 * costs a full io.fetchSockets(); an install with zero info rooms must not
 * pay that on the hot path. One indexed read refreshes the flag after the
 * TTL; the post-mode write paths invalidate it so a flip (or an info-room
 * creation) takes effect immediately rather than at TTL expiry. Keyed by
 * the Db handle (a process singleton in production) so independent
 * database instances can never read each other's flag.
 */
const infoRoomsExistCache = new WeakMap<object, { at: number; exists: boolean }>();
const INFO_ROOMS_EXIST_TTL_MS = 15_000;

export function invalidateInfoRoomsExistCache(db: Db): void {
  infoRoomsExistCache.delete(db);
}

export async function anyInfoRoomsExist(db: Db): Promise<boolean> {
  const now = Date.now();
  const hit = infoRoomsExistCache.get(db);
  if (hit && now - hit.at < INFO_ROOMS_EXIST_TTL_MS) return hit.exists;
  const row = (await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.postMode, "staff"), isNull(rooms.forumId)))
    .limit(1))[0];
  infoRoomsExistCache.set(db, { at: now, exists: !!row });
  return !!row;
}

/**
 * Is this specific room id an info room? Short-circuits to false via the
 * anyInfoRoomsExist cache when the install has no info rooms at all, so the
 * common case pays nothing; otherwise one indexed read. Used to keep info
 * rooms CLUTTER-FREE — they carry only the staff-posted announcement content,
 * never system lines (joins/parts/topic/moderation) or announcement fan-out.
 */
export async function isInfoRoomId(db: Db, roomId: string): Promise<boolean> {
  if (!(await anyInfoRoomsExist(db))) return false;
  const row = (await db
    .select({ postMode: rooms.postMode, forumId: rooms.forumId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1))[0];
  return !!row && isInfoRoom(row);
}

/**
 * May `user` post into `room` when its post mode is 'staff'? Cheap
 * in-memory checks first (site staff, room owner), then one indexed read
 * each for the room-mod and server-staff tiers. Callers gate on
 * `room.postMode === "staff"` first so 'everyone' rooms pay nothing.
 */
export async function canPostInStaffRoom(
  db: Db,
  user: { id: string; role: Role },
  room: PostModeRoom,
): Promise<boolean> {
  if (isModeratorRole(user.role)) return true;
  if (room.ownerId === user.id) return true;
  const member = (await db
    .select({ role: roomMembers.role })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, user.id)))
    .limit(1))[0];
  if (member?.role === "owner" || member?.role === "mod") return true;
  const staff = (await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, room.serverId ?? DEFAULT_SERVER_ID),
      eq(serverMembers.userId, user.id),
      inArray(serverMembers.role, ["owner", "admin", "mod"]),
    ))
    .limit(1))[0];
  return !!staff;
}

/**
 * May `user` post into `room` when its post mode restricts posting? The
 * staff set always passes; `post_mode = 'roles'` additionally admits
 * holders of any usergroup with a kind='post' row in `room_role_gates`
 * (migration 0349). `post_mode = 'staff'` ignores role rows — staff wins.
 */
export async function canPostInRestrictedRoom(
  db: Db,
  user: { id: string; role: Role },
  room: PostModeRoom,
): Promise<boolean> {
  if (await canPostInStaffRoom(db, user, room)) return true;
  if (room.postMode !== "roles") return false;
  const gateRows = await db
    .select({ usergroupId: roomRoleGates.usergroupId })
    .from(roomRoleGates)
    .where(and(eq(roomRoleGates.roomId, room.id), eq(roomRoleGates.kind, "post")));
  if (gateRows.length === 0) return false;
  const held = (await db
    .select({ groupId: serverUsergroupMembers.groupId })
    .from(serverUsergroupMembers)
    .where(and(
      eq(serverUsergroupMembers.userId, user.id),
      inArray(serverUsergroupMembers.groupId, gateRows.map((r) => r.usergroupId)),
    ))
    .limit(1))[0];
  return !!held;
}

/**
 * Is this room read-only for this viewer? False for 'everyone' rooms and
 * for forum boards (their own permission system governs posting).
 */
export async function isPostLockedFor(
  db: Db,
  user: { id: string; role: Role } | null | undefined,
  room: PostModeRoom,
): Promise<boolean> {
  if (room.postMode === "everyone" || room.forumId) return false;
  if (!user) return true;
  return !(await canPostInRestrictedRoom(db, user, room));
}

/**
 * Compute + cache this socket's read-only state for THIS room on
 * socket.data, where the hot summary paths (summaryFor / sendRoomStateTo)
 * read it without queries. Called on every join AND on the relocate
 * landings (kick/ban/boot re-send room state without a joinRoom pass), so
 * the stamp always describes the room the socket actually stands in.
 * Errors fail OPEN (unlocked UI) — the dispatch gate is authoritative.
 */
export async function stampPostLocked(
  db: Db,
  socket: { data: unknown },
  user: { id: string; role: Role },
  room: PostModeRoom,
): Promise<void> {
  try {
    (socket.data as { postLocked?: boolean }).postLocked =
      await isPostLockedFor(db, user, room);
  } catch {
    (socket.data as { postLocked?: boolean }).postLocked = false;
  }
}

/** The minimal io surface the re-stamp walk needs (tests hand a stub). */
interface StampIo {
  in(room: string): { fetchSockets(): Promise<Array<{ data: unknown }>> } ;
}

/**
 * Refresh the join-time `postLocked` stamp for every socket standing in
 * `room`. Called by the two post-mode WRITE paths (the /postmode command
 * and the console room PATCH) right before their room:state broadcast, so
 * a live flip repaints every occupant's composer without a rejoin. Still
 * never runs per presence broadcast — only on the mode flip itself.
 */
export async function restampPostLockedForRoom(
  io: StampIo,
  db: Db,
  room: PostModeRoom,
): Promise<void> {
  // A mode flip can create (or retire) the install's only info room; the
  // presence attribution short-circuit must learn that now, not at TTL
  // expiry.
  invalidateInfoRoomsExistCache(db);
  const sockets = await io.in(`room:${room.id}`).fetchSockets();
  for (const s of sockets) {
    const su = (s.data as { user?: { id: string; role: Role } }).user;
    if (su) await stampPostLocked(db, s, su, room);
    // Phantom-presence stamps (info rooms display no readers): a LIVE mode
    // flip must move every occupant between "normal presence" and
    // "attributed to their anchor room" without a rejoin, or the occupant
    // list and the attribution layer would double-count them. Occupants
    // caught by a flip INTO 'staff' have no prior-room anchor; they fall
    // back to the landing room at render time.
    const sd = s.data as { presenceInfoRoomId?: string | null; presenceAnchorRoomId?: string | null };
    if (isInfoRoom(room)) {
      if (sd.presenceInfoRoomId !== room.id) {
        sd.presenceInfoRoomId = room.id;
        sd.presenceAnchorRoomId = sd.presenceAnchorRoomId ?? null;
      }
    } else if (sd.presenceInfoRoomId === room.id) {
      sd.presenceInfoRoomId = null;
      sd.presenceAnchorRoomId = null;
    }
  }
}
