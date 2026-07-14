/**
 * Per-role room permissions (room_role_gates, migration 0349) — the
 * usergroup-gated lane next to lib/postMode.ts' staff lane.
 *
 * ACCESS rows: any kind='access' row makes the room ROLE-LOCKED. Non-holders
 * never receive the room (GET /rooms drops it), can't join (the same NO_ROOM
 * refusal a nonexistent room gives — existence never leaks), and its slug
 * 404s. Site staff, server staff (server_members owner/admin/mod; NULL
 * rooms.server_id homes to the default server) and the room owner always
 * pass. The gate COMPOSES with the existing gates (18+, private/password,
 * server moderation): every gate must independently pass.
 *
 * POST rows: with rooms.post_mode='roles', the staff set from postMode.ts
 * plus holders of any kind='post' row may post; everyone else gets the
 * read-only composer. post_mode='staff' ignores role rows entirely.
 *
 * STAFF-ONLY (rooms.staff_only, migration 0363): an adjacent access axis that
 * needs NO gate row — the column alone hides the room from everyone outside
 * the staff set (site staff, server owner/admin/mod, room owner, room mods),
 * INDEPENDENT of usergroups. It rides the SAME deny helpers as a role-locked
 * room (roleAccessDeniedFor/With), lands in roleLockedRoomIdsForServer, and
 * is evicted on flip-ON by evictRoleDeniedFromRoom — so callers get one
 * uniform no-leak "denied" result whichever gate tripped.
 *
 * This module is the single audit point for both reads:
 *   - loadRoleGates      — ONE batched inArray read for a whole room list
 *                          (GET /rooms must never issue per-room queries);
 *   - usergroupIdsFor    — ONE batched read of a viewer's memberships;
 *   - roleAccessDeniedFor — the single-room form for join / by-slug paths.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import { isModeratorRole, type ClientToServerEvents, type Role, type ServerToClientEvents } from "@thekeep/shared";
import { roomMembers, rooms, roomRoleGates, serverMembers, serverUsergroupMembers } from "../db/schema.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import { tFor } from "../i18n.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** The room fields the access gate needs — a full row always satisfies this. */
export interface RoleGateRoom {
  id: string;
  ownerId: string | null;
  serverId: string | null;
  /**
   * Staff-only ACCESS (migration 0363). True ⇒ the room is denied to
   * everyone outside the staff set (site staff, server owner/admin/mod, the
   * room owner, room mods), INDEPENDENT of any `room_role_gates` row — a
   * usergroup can't rescue a non-staff viewer. Optional so a caller passing a
   * partial shape (or an older row) reads as "not staff-only".
   */
  staffOnly?: boolean;
}

export interface RoomRoleGateSets {
  access: Set<string>;
  post: Set<string>;
}

/**
 * All gate rows for a batch of rooms in ONE query. Rooms with no rows are
 * absent from the map (the overwhelmingly common case costs one indexed
 * read and an empty result).
 */
export async function loadRoleGates(
  db: Db,
  roomIds: readonly string[],
): Promise<Map<string, RoomRoleGateSets>> {
  const out = new Map<string, RoomRoleGateSets>();
  if (roomIds.length === 0) return out;
  const rows = await db
    .select()
    .from(roomRoleGates)
    .where(inArray(roomRoleGates.roomId, [...roomIds]));
  for (const r of rows) {
    let sets = out.get(r.roomId);
    if (!sets) {
      sets = { access: new Set(), post: new Set() };
      out.set(r.roomId, sets);
    }
    (r.kind === "access" ? sets.access : sets.post).add(r.usergroupId);
  }
  return out;
}

/** Every usergroup the user holds (any server, auto or manual) — one read. */
export async function usergroupIdsFor(db: Db, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ groupId: serverUsergroupMembers.groupId })
    .from(serverUsergroupMembers)
    .where(eq(serverUsergroupMembers.userId, userId));
  return new Set(rows.map((r) => r.groupId));
}

/** The servers this user staffs (server_members owner/admin/mod) — one read. */
export async function staffServerIdsFor(db: Db, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.userId, userId),
      inArray(serverMembers.role, ["owner", "admin", "mod"]),
    ));
  return new Set(rows.map((r) => r.serverId));
}

/**
 * The room ids from `roomIds` where `userId` is a room owner/mod
 * (room_members.role) — one batched read. The room-mod tier of the staff-only
 * bypass (migration 0363), consumed by GET /rooms' batched filter and the
 * eviction pass so a room's own mods keep seeing/holding a staff-only room.
 */
export async function roomModRoomIdsFor(db: Db, userId: string, roomIds: readonly string[]): Promise<Set<string>> {
  if (roomIds.length === 0) return new Set();
  const rows = await db
    .select({ roomId: roomMembers.roomId })
    .from(roomMembers)
    .where(and(
      eq(roomMembers.userId, userId),
      inArray(roomMembers.roomId, [...roomIds]),
      inArray(roomMembers.role, ["owner", "mod"]),
    ));
  return new Set(rows.map((r) => r.roomId));
}

/**
 * Pure form of the access decision, for callers that already batched the
 * reads (GET /rooms). True = the viewer must NOT receive this room.
 *
 * Two gates share one staff/owner bypass:
 *   - `room.staffOnly` (migration 0363): denies everyone outside the staff
 *     set, INDEPENDENT of usergroup rows — room mods pass (via
 *     `viewerRoomModRoomIds`), no access usergroup rescues anyone else.
 *   - `accessGroupIds` (role-locked room): a held access usergroup admits.
 * A room carrying BOTH is staff-only-dominant — the flag denies a non-staff
 * usergroup holder just the same.
 */
export function roleAccessDeniedWith(
  viewer: { id: string; role: Role } | null | undefined,
  room: RoleGateRoom,
  accessGroupIds: ReadonlySet<string> | undefined,
  viewerGroupIds: ReadonlySet<string>,
  viewerStaffServerIds: ReadonlySet<string>,
  viewerRoomModRoomIds?: ReadonlySet<string>,
): boolean {
  const staffOnly = !!room.staffOnly;
  const hasAccessGate = !!accessGroupIds && accessGroupIds.size > 0;
  // Neither gate → visible to everyone (the overwhelmingly common room).
  if (!staffOnly && !hasAccessGate) return false;
  if (!viewer) return true;
  // Staff / owner bypass — shared by both gates.
  if (isModeratorRole(viewer.role)) return false;
  if (room.ownerId === viewer.id) return false;
  if (viewerStaffServerIds.has(room.serverId ?? DEFAULT_SERVER_ID)) return false;
  // Staff-only wins first: room mods also pass; nothing else does.
  if (staffOnly) return !viewerRoomModRoomIds?.has(room.id);
  // Role-locked: a held access usergroup admits.
  for (const gid of accessGroupIds!) if (viewerGroupIds.has(gid)) return false;
  return true;
}

/**
 * Single-room access decision for the join / by-slug / info paths. Cheap
 * in-memory checks first; each DB read is bounded and only runs while the
 * decision is still open. `viewer` null (anonymous) is denied whenever any
 * access row exists.
 */
export async function roleAccessDeniedFor(
  db: Db,
  viewer: { id: string; role: Role } | null | undefined,
  room: RoleGateRoom,
): Promise<boolean> {
  const staffOnly = !!room.staffOnly;
  // Role-locked rooms carry kind='access' rows; a staff-only room is gated by
  // the column alone. One indexed read serves both — a pure staff-only room
  // just comes back empty.
  const rows = await db
    .select({ usergroupId: roomRoleGates.usergroupId })
    .from(roomRoleGates)
    .where(and(eq(roomRoleGates.roomId, room.id), eq(roomRoleGates.kind, "access")));
  if (!staffOnly && rows.length === 0) return false;
  if (!viewer) return true;
  // Staff / owner bypass — shared by both gates.
  if (isModeratorRole(viewer.role)) return false;
  if (room.ownerId === viewer.id) return false;
  const staff = (await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, room.serverId ?? DEFAULT_SERVER_ID),
      eq(serverMembers.userId, viewer.id),
      inArray(serverMembers.role, ["owner", "admin", "mod"]),
    ))
    .limit(1))[0];
  if (staff) return false;
  // Staff-only (migration 0363): room mods (room_members owner/mod) also pass;
  // no usergroup membership can rescue anyone else, so the access rows above
  // are irrelevant here — the flag denies independently.
  if (staffOnly) {
    const member = (await db
      .select({ role: roomMembers.role })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, viewer.id)))
      .limit(1))[0];
    return !(member?.role === "owner" || member?.role === "mod");
  }
  const held = (await db
    .select({ groupId: serverUsergroupMembers.groupId })
    .from(serverUsergroupMembers)
    .where(and(
      eq(serverUsergroupMembers.userId, viewer.id),
      inArray(serverUsergroupMembers.groupId, rows.map((r) => r.usergroupId)),
    ))
    .limit(1))[0];
  return !held;
}

/**
 * The role-LOCKED room ids of one server (any kind='access' row), for
 * viewer-agnostic skips — findServerLanding must never land a member in a
 * room most of the server can't see.
 */
export async function roleLockedRoomIdsForServer(db: Db, roomIds: readonly string[]): Promise<Set<string>> {
  if (roomIds.length === 0) return new Set();
  const rows = await db
    .select({ roomId: roomRoleGates.roomId })
    .from(roomRoleGates)
    .where(and(inArray(roomRoleGates.roomId, [...roomIds]), eq(roomRoleGates.kind, "access")));
  const out = new Set(rows.map((r) => r.roomId));
  // Staff-only rooms (migration 0363) are viewer-agnostically hidden too — a
  // landing must never drop arbitrary members into one either.
  const staffRows = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(inArray(rooms.id, [...roomIds]), eq(rooms.staffOnly, true)));
  for (const r of staffRows) out.add(r.id);
  return out;
}

/**
 * Compute + cache whether this socket's viewer is role-DENIED the 18+ annex
 * of the room they stand in (`socket.data.annexRoleDenied`; the
 * stampPairStaffView posture). The hot summary paths read the flag to null
 * `linkedNsfwRoomId`: GET /rooms scrubs the pointer for role-denied viewers
 * (its roleDropped map), and without this stamp every room:state broadcast
 * would re-deliver the annex id — a recurring existence leak — until the
 * debounced /rooms refetch overwrote it. Errors fail OPEN (pointer kept),
 * matching stampPostLocked: the HTTP route is the authoritative scrub and
 * the annex JOIN is refused regardless.
 */
export async function stampAnnexRoleDenied(
  db: Db,
  socket: { data: unknown },
  user: { id: string; role: Role },
  roomId: string,
): Promise<void> {
  try {
    const { findLinkedAnnex } = await import("./roomLinks.js");
    const annex = await findLinkedAnnex(db, roomId);
    (socket.data as { annexRoleDenied?: boolean }).annexRoleDenied =
      !!annex && (await roleAccessDeniedFor(db, user, annex));
  } catch {
    (socket.data as { annexRoleDenied?: boolean }).annexRoleDenied = false;
  }
}

/* =========================================================
 *  Live enforcement — evictions + composer-lock refresh
 *
 *  Broadcast helpers are imported dynamically inside function bodies (the
 *  lib/nsfwRooms.ts pattern) so this module stays OFF the realtime/broadcast
 *  static graph — presence.ts imports the pure readers above.
 * ========================================================= */

/**
 * Boot every occupant the room's kind='access' gate now denies (mirrors
 * evictMinorsFromRoom): the socket path has no per-message role check, so
 * without this a non-holder keeps receiving (and sending) after the lock —
 * while the HTTP surfaces already 404 them. Called after any write that can
 * NARROW access: the console's accessRoleIds PATCH, roster removals, and
 * group deletion. Rooms with no access rows are a one-read no-op.
 * Relocation + notice follow the minor-eviction posture; membership rows
 * are KEPT (keep-but-hide) so regaining the role restores everything.
 *
 * Also the enforcement point for a staff-only flip-ON (migration 0363): the
 * socket path has no per-message access check, so a room turning staff-only
 * must boot its current non-staff occupants the same way. Room mods pass (the
 * room-mod tier is folded into the per-user decision below).
 */
export async function evictRoleDeniedFromRoom(
  io: Io,
  db: Db,
  room: RoleGateRoom & { serverId: string | null },
): Promise<number> {
  const staffOnly = !!room.staffOnly;
  const gateRows = await db
    .select({ usergroupId: roomRoleGates.usergroupId })
    .from(roomRoleGates)
    .where(and(eq(roomRoleGates.roomId, room.id), eq(roomRoleGates.kind, "access")));
  // Nothing to enforce: no access gate AND not staff-only.
  if (gateRows.length === 0 && !staffOnly) return 0;
  const access = new Set(gateRows.map((r) => r.usergroupId));
  const socks = await io.in(`room:${room.id}`).fetchSockets();
  if (socks.length === 0) return 0;
  const { broadcastPresence, broadcastRoomState, sendRoomBacklogTo, findCanonicalLanding, findServerLanding } =
    await import("../realtime/broadcast.js");
  // findServerLanding already skips role-locked rooms, so the relocation
  // target can never itself deny the evictee on the access tier.
  let landing = room.serverId && room.serverId !== DEFAULT_SERVER_ID
    ? await findServerLanding(db, room.serverId)
    : await findCanonicalLanding(db);
  if (landing && landing.id === room.id) landing = null;
  // Per-USER denial, cached across a user's sockets (two bounded reads each).
  const denialByUser = new Map<string, boolean>();
  let booted = 0;
  for (const s of socks) {
    const su = (s.data as { user?: { id: string; role: Role; locale?: string | null } }).user;
    if (!su) continue;
    let denied = denialByUser.get(su.id);
    if (denied === undefined) {
      const isSite = isModeratorRole(su.role);
      denied = roleAccessDeniedWith(
        su,
        room,
        access,
        access.size > 0 ? await usergroupIdsFor(db, su.id) : new Set<string>(),
        isSite ? new Set<string>() : await staffServerIdsFor(db, su.id),
        // The room-mod tier only matters for a staff-only room; skip the read
        // otherwise (a role-locked room never bypasses on room-mod).
        staffOnly && !isSite ? await roomModRoomIdsFor(db, su.id, [room.id]) : new Set<string>(),
      );
      denialByUser.set(su.id, denied);
    }
    if (!denied) continue;
    s.leave(`room:${room.id}`);
    s.emit("error:notice", { code: "NO_ROOM", message: tFor(su.locale, "errors:server.rooms.roleAccessChanged") });
    const uid = (s.data as { userId?: string }).userId;
    if (landing) {
      s.join(`room:${landing.id}`);
      (s.data as { roomId?: string }).roomId = landing.id;
      (s.data as { serverId?: string }).serverId = landing.serverId ?? DEFAULT_SERVER_ID;
      if (uid) await sendRoomBacklogTo(s, db, landing.id, uid);
    }
    booted++;
  }
  if (booted > 0) {
    await broadcastPresence(io, db, room.id);
    if (landing) await broadcastRoomState(io, db, landing.id);
  }
  return booted;
}

/**
 * Re-evaluate the role-gate consequences for specific users' LIVE sockets
 * after a usergroup-MEMBERSHIP write (self-roles join/leave, console roster
 * add/remove, onboarding grants, auto-group grants). Two effects per socket
 * standing in a room of `serverId`:
 *   - access now denied  → room-wide eviction pass (evictRoleDeniedFromRoom);
 *   - restricted-post room → refresh the join-time `postLocked` stamp and
 *     re-broadcast room state so the composer lock strip tracks the role
 *     change without a rejoin (the stamp is otherwise only recomputed on
 *     join / relocate / post-mode flips).
 * Bounded: the affected users' sockets only; room rows cached per call.
 */
export async function refreshRoleGatesForUsers(
  io: Io,
  db: Db,
  serverId: string,
  userIds: readonly string[],
): Promise<void> {
  const want = new Set(userIds);
  if (want.size === 0) return;
  const allSockets = await io.fetchSockets();
  const mine = allSockets.filter((s) => {
    const d = s.data as { userId?: string; roomId?: string };
    return !!d.userId && want.has(d.userId) && !!d.roomId;
  });
  if (mine.length === 0) return;
  const { stampPostLocked } = await import("./postMode.js");
  const roomCache = new Map<string, typeof rooms.$inferSelect | null>();
  const evictRooms = new Map<string, typeof rooms.$inferSelect>();
  const restampRooms = new Map<string, typeof rooms.$inferSelect>();
  for (const s of mine) {
    const rid = (s.data as { roomId?: string }).roomId!;
    let room = roomCache.get(rid);
    if (room === undefined) {
      room = (await db.select().from(rooms).where(eq(rooms.id, rid)).limit(1))[0] ?? null;
      roomCache.set(rid, room);
    }
    if (!room) continue;
    if ((room.serverId ?? DEFAULT_SERVER_ID) !== serverId) continue;
    const su = (s.data as { user?: { id: string; role: Role } }).user;
    if (!su) continue;
    if (await roleAccessDeniedFor(db, su, room)) {
      evictRooms.set(room.id, room);
    } else if (room.postMode !== "everyone" && !room.forumId) {
      await stampPostLocked(db, s, su, room);
      restampRooms.set(room.id, room);
    }
  }
  for (const room of evictRooms.values()) {
    await evictRoleDeniedFromRoom(io, db, room);
  }
  if (restampRooms.size > 0) {
    const { broadcastRoomState } = await import("../realtime/broadcast.js");
    for (const room of restampRooms.values()) {
      await broadcastRoomState(io, db, room.id);
    }
  }
}
