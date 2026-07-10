/**
 * Linked SFW/18+ room pairs (migration 0343).
 *
 * A pair is one SFW "base" room plus one 18+ "annex" room, presented in the
 * room rail as a single row with a SFW/18+ toggle. The DB stores exactly one
 * directed edge: `rooms.linked_room_id` on the ANNEX, pointing at the base.
 *
 * Pure DB helpers, no io/ctx. Permission checks (the caller must be able to
 * edit BOTH rooms) belong to the command layer; this module owns the shape
 * rules so the command and the tests share one source of truth:
 *
 *   - two DIFFERENT rooms on the SAME server,
 *   - both PUBLIC (the rail toggle joins like a row click; a private annex
 *     would dead-end at the password gate mid-toggle),
 *   - neither is a forum board or a system room,
 *   - neither is archived,
 *   - exactly ONE of the two carries the room-level 18+ flag — that one
 *     becomes the annex (flag the room with /nsfw first),
 *   - neither is already part of another pair.
 */

import { and, eq, isNull } from "drizzle-orm";
import { rooms } from "../db/schema.js";
import type { Db } from "../db/index.js";

type RoomRow = typeof rooms.$inferSelect;

export type RoomLinkError =
  | "SELF"
  | "FORUM_BOARD"
  | "SYSTEM"
  | "ARCHIVED"
  | "DIFFERENT_SERVER"
  | "NOT_PUBLIC"
  | "NEED_ONE_NSFW"
  | "ALREADY_LINKED";

export type RoomLinkResult =
  | { ok: true; base: RoomRow; annex: RoomRow }
  | { ok: false; error: RoomLinkError };

/** The non-archived 18+ annex pointing at `baseRoomId`, or null. */
export async function findLinkedAnnex(db: Db, baseRoomId: string): Promise<RoomRow | null> {
  const row = (await db
    .select()
    .from(rooms)
    .where(and(eq(rooms.linkedRoomId, baseRoomId), isNull(rooms.archivedAt)))
    .limit(1))[0];
  return row ?? null;
}

/** True when `room` participates in ANY pair, as annex or as base. */
export async function isInPair(db: Db, room: RoomRow): Promise<boolean> {
  if (room.linkedRoomId) return true;
  const dependant = (await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.linkedRoomId, room.id))
    .limit(1))[0];
  return !!dependant;
}

/**
 * Validate + persist a pair link between two rooms. Decides which side is
 * the annex from the room-level `isNsfw` flags. Returns the resolved pair
 * or the first rule violation found (checked in user-explainable order).
 */
export async function linkRoomPair(db: Db, a: RoomRow, b: RoomRow): Promise<RoomLinkResult> {
  if (a.id === b.id) return { ok: false, error: "SELF" };
  if (a.forumId || b.forumId) return { ok: false, error: "FORUM_BOARD" };
  if (a.isSystem || b.isSystem) return { ok: false, error: "SYSTEM" };
  if (a.archivedAt || b.archivedAt) return { ok: false, error: "ARCHIVED" };
  if ((a.serverId ?? null) !== (b.serverId ?? null)) return { ok: false, error: "DIFFERENT_SERVER" };
  if (a.type !== "public" || b.type !== "public") return { ok: false, error: "NOT_PUBLIC" };
  // Room-level flags on purpose (not the server-effective rating): on an 18+
  // server both rooms are effectively 18+, and the room flag is still what
  // distinguishes the annex from the base.
  if (a.isNsfw === b.isNsfw) return { ok: false, error: "NEED_ONE_NSFW" };
  if ((await isInPair(db, a)) || (await isInPair(db, b))) {
    return { ok: false, error: "ALREADY_LINKED" };
  }
  const base = a.isNsfw ? b : a;
  const annex = a.isNsfw ? a : b;
  await db.update(rooms).set({ linkedRoomId: base.id }).where(eq(rooms.id, annex.id));
  return { ok: true, base, annex };
}

/**
 * Dissolve the pair `room` participates in (from either side). Returns the
 * pair's { baseId, annexId } when a link was actually cleared, else null.
 */
export async function unlinkRoomPair(
  db: Db,
  room: RoomRow,
): Promise<{ baseId: string; annexId: string } | null> {
  if (room.linkedRoomId) {
    await db.update(rooms).set({ linkedRoomId: null }).where(eq(rooms.id, room.id));
    return { baseId: room.linkedRoomId, annexId: room.id };
  }
  // Include an ARCHIVED annex here (unlike findLinkedAnnex): unlinking is
  // cleanup, and a parked annex should be releasable too.
  const annex = (await db
    .select()
    .from(rooms)
    .where(eq(rooms.linkedRoomId, room.id))
    .limit(1))[0];
  if (!annex) return null;
  await db.update(rooms).set({ linkedRoomId: null }).where(eq(rooms.id, annex.id));
  return { baseId: room.id, annexId: annex.id };
}
