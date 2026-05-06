/** Structured stat fields surfaced as labeled rows in the profile editor. */
export interface CharacterStats {
  age?: string;
  race?: string;
  gender?: string;
  height?: string;
  weight?: string;
  alignment?: string;
  occupation?: string;
  /** Free-form key/value extras, max 20 entries, each value <= 200 chars (validated server-side). */
  custom?: Record<string, string>;
}

import type { Theme } from "./theme.js";

export interface CharacterProfile {
  id: string;
  userId: string;
  name: string;
  /** sanitized HTML body */
  bioHtml: string;
  stats: CharacterStats;
  avatarUrl: string | null;
  /** Owner's chosen UI theme — applied to the profile modal when others view it. */
  theme: Theme;
  createdAt: number;
  updatedAt: number;
}

export interface MasterProfile {
  userId: string;
  username: string;
  bioHtml: string;
  avatarUrl: string | null;
  /** OOC gender, surfaced as the icon next to the username when no character is active. */
  gender: "male" | "female" | "nonbinary" | "other" | "undisclosed";
  /** Owner's chosen UI theme — applied to the profile modal when others view it. */
  theme: Theme;
  createdAt: number;
}

/** What `/profile` returns: either the master, or the active character. */
export type ProfileView =
  | { kind: "master"; profile: MasterProfile }
  | { kind: "character"; profile: CharacterProfile };
