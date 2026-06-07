import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { roomClears } from "../db/schema.js";

/**
 * Per-viewer `/clear` marker helpers. A `/clear` records a `cleared_at`
 * timestamp for (user, room); every backlog source filters to messages
 * newer than it for that viewer, so the clear survives reconnects and
 * backlog resends instead of being purely cosmetic. See the room_clears
 * table comment for the full rationale.
 */

/** The viewer's last `/clear` time for a room, or null if never cleared. */
export async function getClearedAt(db: Db, userId: string, roomId: string): Promise<Date | null> {
  const row = (
    await db
      .select({ clearedAt: roomClears.clearedAt })
      .from(roomClears)
      .where(and(eq(roomClears.userId, userId), eq(roomClears.roomId, roomId)))
      .limit(1)
  )[0];
  return row?.clearedAt ?? null;
}

/** Record (or bump forward) the viewer's `/clear` marker for a room. */
export async function setRoomCleared(db: Db, userId: string, roomId: string, at: Date): Promise<void> {
  await db
    .insert(roomClears)
    .values({ userId, roomId, clearedAt: at })
    .onConflictDoUpdate({ target: [roomClears.userId, roomClears.roomId], set: { clearedAt: at } });
}
