/**
 * Linked-room lookups for the per-room 18+ CHANNEL (migration 0343).
 *
 * A room's 18+ channel is a hidden companion room whose
 * `rooms.linked_room_id` points at its base. These helpers are the shared
 * lookups the wire layer (buildRoomSummary), the archival sweep
 * (expireIfEmpty), and the /nsfw flag lock (setRoomNsfw) read; the channel
 * LIFECYCLE (enable/disable) lives in lib/adultChannel.ts.
 */

import { and, eq, isNull } from "drizzle-orm";
import { rooms } from "../db/schema.js";
import type { Db } from "../db/index.js";

type RoomRow = typeof rooms.$inferSelect;

/** The non-archived 18+ channel pointing at `baseRoomId`, or null. */
export async function findLinkedAnnex(db: Db, baseRoomId: string): Promise<RoomRow | null> {
  const row = (await db
    .select()
    .from(rooms)
    .where(and(eq(rooms.linkedRoomId, baseRoomId), isNull(rooms.archivedAt)))
    .limit(1))[0];
  return row ?? null;
}

/**
 * True when `room` participates in a channel pairing, as the channel or as
 * the base — including a PARKED (archived) channel, whose link edge is
 * deliberately kept so re-enabling restores the same feed. Guards the
 * whole-room 18+ flag flip (the flags are the pairing's structure).
 */
export async function isInPair(db: Db, room: RoomRow): Promise<boolean> {
  if (room.linkedRoomId) return true;
  const dependant = (await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.linkedRoomId, room.id))
    .limit(1))[0];
  return !!dependant;
}
