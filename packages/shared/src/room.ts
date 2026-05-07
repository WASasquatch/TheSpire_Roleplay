/**
 * "public" - anyone can join.
 * "private" - password required; /invite whitelists specific users so they
 *             skip the password prompt.
 */
export type RoomType = "public" | "private";

export interface RoomSummary {
  id: string;
  name: string;
  type: RoomType;
  topic: string | null;
  ownerId: string | null;
  memberCount: number;
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
  role: "owner" | "mod" | "member";
}
