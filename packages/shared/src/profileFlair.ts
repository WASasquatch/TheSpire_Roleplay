/**
 * Shared types + caps for the two profile-customization Flair
 * features added in migration 0192:
 *
 *   `flair_profile_visitors` — counter widget that surfaces distinct
 *     daily viewer counts split into members + external traffic.
 *
 *   `flair_profile_marquee` — rotating-quote strip between the
 *     profile header and the bio/stats grid. Owner configures up to
 *     {@link PROFILE_MARQUEE_MAX_QUOTES} short bodies, each capped at
 *     {@link PROFILE_MARQUEE_QUOTE_MAX_LEN} chars.
 */

export const FLAIR_PROFILE_VISITORS_KEY = "flair_profile_visitors";
export const FLAIR_PROFILE_MARQUEE_KEY = "flair_profile_marquee";

/** Hard limit on configured quotes — anything beyond reads as a wall
 *  of text and the rotation loses meaning at the marquee's cadence. */
export const PROFILE_MARQUEE_MAX_QUOTES = 10;
/** Per-quote char cap. Short enough to render on one line of a
 *  narrow mobile viewport without wrapping awkwardly; the editor
 *  surfaces a "X / 200" counter so the writer can self-trim. */
export const PROFILE_MARQUEE_QUOTE_MAX_LEN = 200;

/** Distinct-viewer counts the server returns for a profile. */
export interface ProfileVisitorStats {
  /** Distinct member viewers (signed-in, deduped per day) since launch. */
  members: number;
  /** Distinct external viewers (anonymous, ip+UA dedupe) since launch. */
  external: number;
  /** Convenience sum so the client doesn't have to add (and the
   *  server can later swap in a different aggregate without
   *  reshuffling the wire). */
  total: number;
}

/** Owner-only summary returned for the flair editor. Includes the
 *  display toggle so the editor can pre-fill the checkbox without
 *  a second fetch. */
export interface ProfileVisitorOwnerSummary extends ProfileVisitorStats {
  /** Owner's "show on my public profile" toggle. */
  visible: boolean;
  /** Whether the owner currently owns the flair. False means the
   *  toggle is inert (the public render won't surface anyway). */
  ownsFlair: boolean;
}

/** Marquee config returned to the owner for the editor. Quotes are
 *  RAW (markdown / basic HTML the writer typed). The renderer runs
 *  the same sanitizer + chip processor the announcement marquee
 *  uses before painting. */
export interface ProfileMarqueeConfig {
  quotes: string[];
  /** Whether the owner currently owns the flair. False means writes
   *  to this surface fail at the API layer. */
  ownsFlair: boolean;
}

/**
 * Pure parser for the JSON column. Returns an empty array on null /
 * undefined / malformed JSON / wrong shape — the column is admin-
 * settable in theory and we don't want a malformed write to crash
 * every profile render.
 */
export function parseProfileMarqueeQuotes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .slice(0, PROFILE_MARQUEE_MAX_QUOTES);
  } catch {
    return [];
  }
}

/**
 * Reverse — used by the editor save path. Trims, drops empties, caps
 * at {@link PROFILE_MARQUEE_MAX_QUOTES}. Returns null when the
 * resulting array is empty so the storage shape is "explicitly
 * cleared" rather than `"[]"`.
 */
export function serializeProfileMarqueeQuotes(quotes: string[]): string | null {
  const cleaned = quotes
    .map((q) => q.trim())
    .filter((q) => q.length > 0)
    .slice(0, PROFILE_MARQUEE_MAX_QUOTES);
  if (cleaned.length === 0) return null;
  return JSON.stringify(cleaned);
}
