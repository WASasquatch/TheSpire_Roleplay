/**
 * Discovery tags — shared, identical for chat servers AND forums.
 *
 * Owners attach a handful of genre/category tags ("high fantasy", "18+",
 * "sci-fi", "slice of life") to their server/forum. Tags are searched alongside
 * the name in the discover modal's search mode, so a seeker can find a community
 * by genre even when it isn't in the name or description.
 *
 * Storage: a `tags_json` TEXT column (JSON string[]); NULL when empty. Always
 * round-trip through {@link normalizeTags} on write so stored tags are clean,
 * lowercased, deduped, and bounded — never trust raw client input.
 */

/** Hard cap on tags per server/forum. Keeps cards tidy and search cheap. */
export const MAX_TAGS_PER_ENTITY = 8;
/** A normalized tag shorter than this is dropped (a stray character). */
export const TAG_MIN_LEN = 2;
/** A normalized tag is truncated/rejected past this. Keeps chips one line. */
export const TAG_MAX_LEN = 24;

/**
 * Normalize ONE raw tag for storage/compare: lowercase, collapse whitespace,
 * and strip anything outside [a-z 0-9 space hyphen plus ampersand] (so "18+"
 * and "sci-fi & fantasy" survive). Returns "" when it normalizes to nothing or
 * falls outside the length bounds — callers drop empties.
 */
export function normalizeTag(raw: string): string {
  const cleaned = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s+&-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < TAG_MIN_LEN || cleaned.length > TAG_MAX_LEN) return "";
  return cleaned;
}

/**
 * Normalize a list for storage: map {@link normalizeTag}, drop empties, dedupe
 * (case-insensitive — already lowercased), preserve first-seen order, clamp to
 * {@link MAX_TAGS_PER_ENTITY}. This is the single sanitizer for any tag write.
 */
export function normalizeTags(raw: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (typeof r !== "string") continue;
    const t = normalizeTag(r);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TAGS_PER_ENTITY) break;
  }
  return out;
}

/** Parse a `tags_json` column value into a clean string[] (bad JSON → []). */
export function parseTagsJson(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return normalizeTags(Array.isArray(v) ? (v as string[]) : []);
  } catch {
    return [];
  }
}

/** Serialize tags for the `tags_json` column. Empty list → NULL (no row noise). */
export function serializeTags(tags: readonly string[]): string | null {
  const norm = normalizeTags(tags);
  return norm.length ? JSON.stringify(norm) : null;
}

/** Exact (case-insensitive) tag membership — drives the tag-chip filter. */
export function hasTag(tags: readonly string[], tag: string): boolean {
  const needle = normalizeTag(tag);
  return needle ? tags.includes(needle) : false;
}

/** Free-text tag match for the search box: does the query appear in any tag? */
export function tagsMatchQuery(tags: readonly string[], q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return false;
  return tags.some((t) => t.includes(needle));
}
