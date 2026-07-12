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

import { and, eq, inArray } from "drizzle-orm";
import { isModeratorRole, type Role } from "@thekeep/shared";
import { roomMembers, roomRoleGates, serverMembers, serverUsergroupMembers } from "../db/schema.js";
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
  const sockets = await io.in(`room:${room.id}`).fetchSockets();
  for (const s of sockets) {
    const su = (s.data as { user?: { id: string; role: Role } }).user;
    if (su) await stampPostLocked(db, s, su, room);
  }
}
