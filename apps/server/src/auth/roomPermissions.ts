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
