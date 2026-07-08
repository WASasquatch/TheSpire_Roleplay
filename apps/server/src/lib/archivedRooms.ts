import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { ArchivedRoomBrief } from "@thekeep/shared";
import { rooms } from "../db/schema.js";
import type { Db } from "../db/index.js";

/**
 * The archived rooms a given user owns, sorted by name.
 *
 * "Owned" means the `ownerId` the room carried when its last occupant left -
 * archiving only stamps `archivedAt`, it never clears ownership, so the row
 * still points at whoever held it. We deliberately match on `ownerId` (the
 * most-recent owner) rather than `originalOwnerUserId`, the list is "rooms
 * you can bring back," and only the current owner resurrects cleanly.
 *
 * Recreating any of these is a plain `/go <name>`: the resurrection path in
 * the room commands keeps the original `type` + `passwordHash`, so a private
 * room returns private with its original password and the owner re-enters
 * without the password prompt. Shared by the `/myrooms` command (renders the
 * list as click-to-fill chat links) and the `GET /rooms/mine/archived` route
 * (feeds the Tools-menu "My Rooms" section's Recreate buttons).
 */
export async function listArchivedOwnedRooms(
  db: Db,
  userId: string,
): Promise<ArchivedRoomBrief[]> {
  const rows = await db
    .select({ id: rooms.id, name: rooms.name, type: rooms.type, topic: rooms.topic })
    .from(rooms)
    .where(and(
      eq(rooms.ownerId, userId),
      isNotNull(rooms.archivedAt),
      // Exclude rooms the owner dismissed from their list via the "X" (0259).
      isNull(rooms.archiveHiddenAt),
    ))
    .orderBy(asc(rooms.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type === "private" ? "private" : "public",
    topic: r.topic ?? null,
  }));
}
