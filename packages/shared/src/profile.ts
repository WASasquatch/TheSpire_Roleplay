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

/**
 * A reference to a "title-bound identity" - either a master account
 * (characterId=null) or a specific character. Used to link a rendered
 * mutual title to the other party's profile so the client can route a
 * click to /whois <name>.
 */
export interface IdentityRef {
  userId: string;
  /** null = master account; non-null = character */
  characterId: string | null;
  /** The display name to show + use for /whois lookup. */
  displayName: string;
}

/**
 * One mutual title rendered on a profile - e.g. "Married to Kaal",
 * "Kaal's Partner", "Mentor of Kaal". The `text` is pre-rendered server-
 * side from the kind's format string with `{target}` replaced by
 * `other.displayName`.
 */
export interface ProfileTitle {
  /** mutual_titles.id - opaque to the client, useful for dissolve flows. */
  id: string;
  /** title_kinds.slug - used by /dissolve to identify the title kind. */
  kindSlug: string;
  /** Pre-formatted display string (e.g. "Married to Kaal"). */
  text: string;
  /** Other party's identity, so the client can link the rendered title. */
  other: IdentityRef;
}

export interface CharacterPortrait {
  id: string;
  url: string;
  label: string | null;
  /** Owner-set NSFW flag. When true, viewers see the tile blurred until they click to reveal. */
  nsfw: boolean;
}

/**
 * A solo writing entry attached to a character — backstory fragment,
 * in-world diary, world notes. Public entries are visible on the
 * character's profile to anyone; private entries are only included in
 * the response when the viewer owns the character.
 */
export interface CharacterJournalEntry {
  id: string;
  /** Optional title; null/empty means "untitled". */
  title: string | null;
  /** Sanitized HTML body. Rendered via the prose styles, never raw. */
  bodyHtml: string;
  privacy: "public" | "private";
  createdAt: number;
  updatedAt: number;
}

/**
 * A player-set link rendered as a styled chip on a profile. Capped at 6 per
 * profile server-side. Colors are optional hex (#rrggbb); null falls back to
 * theme-default styling on the client.
 */
export interface ProfileLink {
  id: string;
  title: string;
  url: string;
  borderColor: string | null;
  bgColor: string | null;
  textColor: string | null;
}

export interface CharacterProfile {
  id: string;
  userId: string;
  name: string;
  /** sanitized HTML body */
  bioHtml: string;
  stats: CharacterStats;
  avatarUrl: string | null;
  /** Additional portraits beyond the primary avatarUrl, in the order the owner set. */
  portraits: CharacterPortrait[];
  /** Owner-set external links (other profiles, world docs, refs). */
  links: ProfileLink[];
  /** Public-visibility journal entries in chronological order (oldest first). Private entries are NEVER included in this array - they only surface in the owner's editor. */
  journalEntries: CharacterJournalEntry[];
  /** Owner's chosen UI theme - applied to the profile modal when others view it. */
  theme: Theme;
  /** Mutual titles (marriages, partnerships, etc.) bound to this character. */
  titles: ProfileTitle[];
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
  /** Owner's chosen UI theme - applied to the profile modal when others view it. */
  theme: Theme;
  /** Mutual titles bound to this master account (separate from any character titles). */
  titles: ProfileTitle[];
  /** Owner-set external links (other profiles, OOC docs, refs). */
  links: ProfileLink[];
  /** Account-level role. Surfaced on the modal so site admins/mods are visibly marked. */
  role: "user" | "trusted" | "mod" | "admin";
  createdAt: number;
}

/** What `/profile` returns: either the master, or the active character. */
export type ProfileView =
  | { kind: "master"; profile: MasterProfile }
  | { kind: "character"; profile: CharacterProfile };
