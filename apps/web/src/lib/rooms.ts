import type { ArchivedRoomBrief, RoomInfo } from "@thekeep/shared";

/**
 * The caller's archived rooms (rooms they own that auto-parked once everyone
 * left). Powers the Tools-menu "My Rooms" section, whose Recreate buttons
 * fire `/go <name>` to bring each one back. Auth-scoped server-side, so an
 * anonymous session just gets an error the caller can ignore.
 */
export async function fetchArchivedRooms(): Promise<ArchivedRoomBrief[]> {
  const r = await fetch("/rooms/mine/archived", { credentials: "include" });
  if (!r.ok) throw new Error(`Couldn't load your archived rooms (${r.status}).`);
  const j = (await r.json()) as { rooms: ArchivedRoomBrief[] };
  return j.rooms;
}

/**
 * Hide one of your archived rooms from the "My Rooms" list (the "X" button).
 * Non-destructive — the archived room is untouched and can be recreated with
 * `/go <name>`; this just stops it cluttering the list (e.g. a typo room).
 */
export async function hideArchivedRoom(roomId: string): Promise<void> {
  const r = await fetch(`/rooms/${encodeURIComponent(roomId)}/hide-archived`, {
    method: "POST",
    credentials: "include",
  });
  if (!r.ok) throw new Error(`Couldn't hide that room (${r.status}).`);
}

/**
 * Full room dossier for the Room Info bar's expandable pullout (description,
 * NPC roster, metadata). Lazy-fetched only when a viewer expands the bar, so
 * the heavier fields stay off the room broadcast. Throws on non-OK so the bar
 * can show a small error state.
 */
export async function fetchRoomInfo(roomId: string): Promise<RoomInfo> {
  const r = await fetch(`/rooms/${encodeURIComponent(roomId)}/info`, { credentials: "include" });
  if (!r.ok) throw new Error(`Couldn't load room info (${r.status}).`);
  const j = (await r.json()) as { info: RoomInfo };
  return j.info;
}
