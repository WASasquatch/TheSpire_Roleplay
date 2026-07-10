/**
 * Forum-level 18+ helpers (age-restriction plan, Phase 3).
 *
 * A whole forum can be marked 18+ (`forums.is_nsfw`, migration 0336), and
 * every board inherits it: the EFFECTIVE rating of a board is the room's own
 * effective state (room flag OR its server's, `lib/nsfwRooms.ts`) OR the
 * parent forum's flag. Board content is deliberately NOT re-stamped when the
 * forum flips — the read routes consult these helpers instead, the same way
 * server-level ratings gate rooms without rewriting message rows. (The
 * per-TOPIC tag is a different mechanism: that one lives on the message row
 * itself, `messages.is_nsfw`, and replies inherit it at insert.)
 */
import { eq } from "drizzle-orm";
import { forums } from "../db/schema.js";
import { effectiveRoomNsfw, type RoomRatingSlice } from "../lib/nsfwRooms.js";
import type { Db } from "../db/index.js";

/** The room-row slice board-level rating checks need: the room rating slice
 *  plus the parent-forum pointer (null = not a board → forum tier is moot). */
export interface BoardRatingSlice extends RoomRatingSlice {
  forumId: string | null;
}

/** Whole-forum 18+ flag for one forum id (null / missing forum → false). */
export async function forumIsNsfw(db: Db, forumId: string | null): Promise<boolean> {
  if (!forumId) return false;
  const f = (await db
    .select({ isNsfw: forums.isNsfw })
    .from(forums)
    .where(eq(forums.id, forumId))
    .limit(1))[0];
  return !!f?.isNsfw;
}

/**
 * The set of 18+ forum ids — one query, for callers that vet MANY rooms at
 * once (the /rooms rail, the server-wide search's room universe). A board is
 * forum-gated when `room.forumId` is in the set; non-board rooms never are.
 */
export async function nsfwForumIds(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ id: forums.id })
    .from(forums)
    .where(eq(forums.isNsfw, true));
  return new Set(rows.map((r) => r.id));
}

/**
 * EFFECTIVE 18+ rating for a board room: the room's own effective state
 * (its flag OR its server's) OR its parent forum's whole-forum flag. For a
 * non-board room (`forumId` null) this is exactly {@link effectiveRoomNsfw}.
 */
export async function effectiveBoardNsfw(db: Db, room: BoardRatingSlice): Promise<boolean> {
  if (await effectiveRoomNsfw(db, room)) return true;
  return forumIsNsfw(db, room.forumId);
}

/**
 * HARD age denial for HTTP read routes — the ONE entry point (there is
 * deliberately no room-only variant in lib/nsfwRooms.ts, which would skip
 * the whole-forum tier for board rooms): 404 the content for minors and
 * anonymous viewers when the room, its server, OR its parent forum is 18+.
 * Adults always pass, hide preference or not. Non-board rooms pass
 * `forumId: null` and get exactly the room/server tiers.
 */
export async function boardAgeDenied(
  db: Db,
  viewer: { isAdult: boolean } | null | undefined,
  room: BoardRatingSlice,
): Promise<boolean> {
  if (viewer?.isAdult) return false;
  return effectiveBoardNsfw(db, room);
}
