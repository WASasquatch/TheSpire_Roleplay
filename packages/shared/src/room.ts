/**
 * "public" - anyone can join.
 * "private" - password required; /invite whitelists specific users so they
 *             skip the password prompt.
 */
export type RoomType = "public" | "private";

import type { LinkedWorldRef } from "./world.js";

export interface RoomSummary {
  id: string;
  name: string;
  type: RoomType;
  topic: string | null;
  ownerId: string | null;
  memberCount: number;
  /** When true, /npc is rejected in this room. Owners/mods toggle. Optional for forward-compat. */
  npcDisabled?: boolean;
  /** World linked to this room (one per room). Surfaced as a banner in chat. */
  linkedWorld?: LinkedWorldRef | null;
  /**
   * Per-room message lifetime in minutes. Null/absent = the global
   * retention setting governs. When set, the janitor deletes messages in
   * this room older than this many minutes; the chat surfaces a small
   * "messages auto-expire" hint so participants know.
   */
  messageExpiryMinutes?: number | null;
  /**
   * Chat rendering mode for this room.
   *   "flat"   - chronological, replies appear at the end of the timeline.
   *   "nested" - replies group under their parent in a thread container.
   * Owner/mod toggleable. Optional for forward-compat with older payloads.
   */
  replyMode?: "flat" | "nested";
}

export type Gender = "male" | "female" | "nonbinary" | "other" | "undisclosed";

export interface RoomOccupant {
  userId: string;
  /** display name resolved from active character (or master username) */
  displayName: string;
  characterId: string | null;
  away: boolean;
  awayMessage?: string | null;
  /** Hex chat color (e.g. "#990000") if user has set one */
  chatColor?: string | null;
  /** Resolved gender - character.stats.gender if active, else user.gender */
  gender: Gender;
  /** Per-room role (room_members.role). */
  role: "owner" | "mod" | "member";
  /** Account-level role (users.role). Lets the UI mark site admins regardless of room role. Optional for forward-compat. */
  accountRole?: "user" | "trusted" | "mod" | "admin";
  /** Free-text current mood/expression set via /mood. Null/absent when unset. */
  mood?: string | null;
  /**
   * The user's primary world membership, if any. Drives userlist grouping:
   * occupants with the same primaryWorld.id band together under a section
   * header. Null/absent = unaffiliated.
   */
  primaryWorld?: LinkedWorldRef | null;
}
