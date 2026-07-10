/**
 * Per-room 18+ CHANNEL (the user-facing model on top of migration 0343).
 *
 * A room with the 18+ channel enabled presents as ONE room with a SFW/18+
 * toggle; each side is its own chat feed. Internally the 18+ side is a
 * hidden companion room (`<name>_Adult`, rooms.linked_room_id → base):
 * a real room row is what makes everything age-critical work for free —
 * minors never receive it, its history is separate and 18+-stamped, joins
 * are age-gated, exports/notifications/search all follow the existing
 * room partition. Nothing user-facing ever presents it as a second room:
 * the rail hides it behind the base's row, and the admin consoles show a
 * checkbox, not a link workflow.
 *
 * Lifecycle:
 *   enable  — revive this room's previously-disabled channel (history
 *             intact) when one is parked, else create a fresh companion
 *             (owned by the BASE room's owner, mirroring its persistence).
 *   disable — refuse while people are inside the 18+ side, else park the
 *             companion (archived, link KEPT so a later re-enable brings
 *             the same feed back).
 *
 * Callers own permissions (room-edit rights / console manage_rooms),
 * audit rows, and user-facing notices; both operations are idempotent.
 */

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { roomMembers, rooms } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { deriveUniqueRoomSlug } from "./roomSlug.js";
import { findLinkedAnnex } from "./roomLinks.js";

type RoomRow = typeof rooms.$inferSelect;
/** Structural io surface used here (fetchSockets for the occupancy check). */
interface IoLike {
  in(band: string): { fetchSockets(): Promise<unknown[]> };
}

export type AdultChannelError =
  | "ROOM_IS_NSFW"     // the whole room is 18+; a nested 18+ channel is meaningless
  | "FORUM_BOARD"
  | "ARCHIVED"
  | "NOT_PUBLIC"
  | "NAME_TOO_LONG"    // "<name>_Adult" exceeds the 40-char room-name cap
  | "NAME_TAKEN"       // an unrelated room already holds "<name>_Adult"
  | "CHANNEL_OCCUPIED"; // disable refused while people are inside the 18+ side

export type AdultChannelResult =
  | { ok: true; changed: boolean; channelRoomId: string | null }
  | { ok: false; error: AdultChannelError };

/** The parked (archived) companion from a previous enable, if any. */
async function findParkedChannel(db: Db, baseRoomId: string): Promise<RoomRow | null> {
  const row = (await db
    .select()
    .from(rooms)
    .where(eq(rooms.linkedRoomId, baseRoomId))
    .limit(1))[0];
  return row?.archivedAt ? row : null;
}

export async function enableAdultChannel(
  db: Db,
  base: RoomRow,
): Promise<AdultChannelResult> {
  // SYSTEM rooms are deliberately allowed: the seeded core rooms (Bazaar,
  // the landing, …) are exactly where a community most wants an adult side
  // — the channel is a core age-gating surface, not a user-rooms-only perk.
  // The channel row mirrors the base's system-ness below so it inherits the
  // same protections.
  if (base.isNsfw) return { ok: false, error: "ROOM_IS_NSFW" };
  if (base.forumId) return { ok: false, error: "FORUM_BOARD" };
  if (base.archivedAt) return { ok: false, error: "ARCHIVED" };
  if (base.type !== "public") return { ok: false, error: "NOT_PUBLIC" };

  const live = await findLinkedAnnex(db, base.id);
  if (live) return { ok: true, changed: false, channelRoomId: live.id };

  // A previous channel parked by disable keeps its link edge, so the same
  // feed (history intact) comes back rather than a fresh empty one.
  const parked = await findParkedChannel(db, base.id);
  if (parked) {
    await db
      .update(rooms)
      .set({ archivedAt: null, archiveHiddenAt: null, isNsfw: true })
      .where(eq(rooms.id, parked.id));
    return { ok: true, changed: true, channelRoomId: parked.id };
  }

  const name = `${base.name}_Adult`;
  if (name.length > 40) return { ok: false, error: "NAME_TOO_LONG" };
  const collision = (await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.name, name)))
    .limit(1))[0];
  if (collision) return { ok: false, error: "NAME_TAKEN" };

  const id = nanoid();
  // The channel MIRRORS its base: same owner (null for system rooms — it
  // belongs to the ROOM, not to whichever staff member clicked the
  // checkbox), same system-ness (so a system room's adult side gets the
  // same sweep/deletion protections), same persistence (a server channel's
  // 18+ side survives empty moments the way the base does).
  const ownerId = base.ownerId;
  await db.insert(rooms).values({
    id,
    name,
    slug: await deriveUniqueRoomSlug(db, name),
    type: "public",
    serverId: base.serverId,
    ownerId,
    originalOwnerUserId: ownerId,
    lastOwnerUserId: ownerId,
    isSystem: base.isSystem,
    persistent: base.persistent,
    isNsfw: true,
    linkedRoomId: base.id,
  });
  if (ownerId) {
    await db.insert(roomMembers).values({ roomId: id, userId: ownerId, role: "owner" }).onConflictDoNothing();
  }
  return { ok: true, changed: true, channelRoomId: id };
}

export async function disableAdultChannel(
  db: Db,
  io: IoLike,
  base: RoomRow,
): Promise<AdultChannelResult> {
  const channel = await findLinkedAnnex(db, base.id);
  if (!channel) return { ok: true, changed: false, channelRoomId: null };
  // Never yank the feed out from under people mid-scene; the owner can ask
  // them to hop to the SFW side first.
  const occupied = (await io.in(`room:${channel.id}`).fetchSockets()).length > 0;
  if (occupied) return { ok: false, error: "CHANNEL_OCCUPIED" };
  // Park, keeping the link edge: re-enabling brings the same feed back.
  await db.update(rooms).set({ archivedAt: new Date() }).where(eq(rooms.id, channel.id));
  return { ok: true, changed: true, channelRoomId: channel.id };
}
