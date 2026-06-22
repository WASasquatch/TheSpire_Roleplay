import { eq } from "drizzle-orm";
import { rooms } from "../db/schema.js";
import type { Db } from "../db/index.js";

/** Hard cap on the stored NPC roster so a room can't grow the JSON blob
 *  without bound (one troll spamming `/npc <random> …` shouldn't bloat the
 *  row). Oldest-kept: once full we stop adding new names. */
const MAX_NPCS = 200;

/** Tolerant parse of the `rooms.npc_list` JSON column into a string[]. */
export function parseNpcList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

/**
 * Record an NPC name into a room's persistent cast list (migration 0258).
 * First-seen order is preserved; a name already present (case-insensitive) is
 * a no-op, so the list is the distinct set of NPCs ever voiced here. Survives
 * message truncation + archive/resurrect so the Room Info pullout can list the
 * cast even after the originating messages are swept.
 *
 * Best-effort: any failure is swallowed (a stuck cast list must never roll
 * back the NPC message that was already broadcast).
 */
export async function recordRoomNpc(db: Db, roomId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    const row = (await db
      .select({ npcList: rooms.npcList })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1))[0];
    if (!row) return;
    const list = parseNpcList(row.npcList);
    if (list.length >= MAX_NPCS) return;
    if (list.some((n) => n.toLowerCase() === trimmed.toLowerCase())) return;
    list.push(trimmed);
    await db.update(rooms).set({ npcList: JSON.stringify(list) }).where(eq(rooms.id, roomId));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[room-stats] recordRoomNpc failed", { roomId, name, err });
  }
}
