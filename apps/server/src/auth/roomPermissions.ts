import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { roomMembers, rooms } from "../db/schema.js";
import { hasPermission } from "./permissions.js";

/**
 * Can this user edit a room's metadata/config (topic, reply mode,
 * expiry, theater settings, ...)? True when:
 *   - they hold the site-wide `edit_any_room_metadata` grant, OR
 *   - they own the room (`rooms.owner_id`), OR
 *   - they are an owner/mod member of the room (`room_members.role`).
 *
 * Extracted from `commands/builtins/room_modes.ts` so the same gate
 * guards both the slash commands AND the realtime theater-control
 * socket handler (which has no CommandContext). Takes the raw pieces
 * rather than a ctx so either caller can use it.
 */
export async function callerCanEditRoom(
  db: Db,
  user: { id: string; role: import("@thekeep/shared").Role },
  roomId: string,
): Promise<boolean> {
  if (await hasPermission(user, "edit_any_room_metadata", db)) return true;
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) return false;
  if (room.ownerId === user.id) return true;
  const m = (
    await db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.id)))
      .limit(1)
  )[0];
  return m?.role === "owner" || m?.role === "mod";
}

/**
 * Is any controller-capable user (per `callerCanEditRoom`) connected to the
 * room right now, other than `excludeUserId`?
 *
 * Drives the passive theater `ended`/`error` gate: while an owner/mod is
 * connected their OWN player is the authoritative end-of-source reporter, so
 * a plain viewer's report is ignored — a crafted one was the only way a
 * non-controller could still skip/restart the video for the whole room. With
 * no controller connected, viewer reports keep the playlist advancing (and
 * dead sources skipping) unattended.
 *
 * Typed structurally against the one Socket.IO surface it touches so tests
 * can hand it a plain fake; reads the `socket.data.user` handshake snapshot,
 * same as the rest of the realtime layer (a socket without one is skipped —
 * it shouldn't be in a room at all).
 */
export async function anyConnectedRoomController(
  io: { in(room: string): { fetchSockets(): Promise<Array<{ data: unknown }>> } },
  db: Db,
  roomId: string,
  excludeUserId?: string,
): Promise<boolean> {
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  const checked = new Set<string>(excludeUserId ? [excludeUserId] : []);
  for (const s of sockets) {
    const su = (s.data as { user?: { id: string; role: import("@thekeep/shared").Role } }).user;
    if (!su || checked.has(su.id)) continue;
    checked.add(su.id);
    if (await callerCanEditRoom(db, su, roomId)) return true;
  }
  return false;
}
