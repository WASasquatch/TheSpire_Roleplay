import { sql, type SQL, type AnyColumn } from "drizzle-orm";
import { canonicalizeNameForLookup } from "@thekeep/shared";

/**
 * Space-insensitive, case-insensitive name matching helpers.
 *
 * Master usernames store NBSP (U+00A0) as the "fake space" separator
 * (see `MASTER_USERNAME_RX` in routes/auth.ts), regular spaces never
 * appear in the username column. Character names go the other way:
 * the validator allows ASCII space, not NBSP. This split was good
 * for storage (each side has a single canonical form) but bad for
 * lookups: a user typing `/whisper John Doe` against a master named
 * `John Doe`, or `+ Friend "Some Char"` against a character
 * named `Some Char`, ends up with a name string that doesn't
 * literally match either column. The bug surfaced as "I can't
 * whisper this person", "they say my DMs aren't reaching them",
 * "they don't show up in the add-friend autocomplete or the DM
 * compose-to-non-friend lookup".
 *
 * The fix is to make every name lookup treat U+00A0 and U+0020 as
 * interchangeable. We do it at QUERY TIME (no migration, no
 * canonical column) by normalizing both sides, the stored value
 * via `REPLACE(LOWER(col), char(160), ' ')` and the typed input
 * via {@link canonicalizeNameForLookup}. The stored display name
 * is untouched; it always renders exactly how it was registered.
 *
 * Why not just store one canonical form on insert? Two reasons:
 *   1. Existing rows have whichever space form their validator
 *      enforced at registration time. Backfilling would lose the
 *      historical fidelity of `John Doe` vs `John Doe`,
 *      legitimately different display intents for masters who
 *      picked NBSP on purpose.
 *   2. The unique constraint on `lower(username)` already prevents
 *      duplicates within each space-class. Treating spaces as
 *      equivalent at LOOKUP without merging on INSERT preserves
 *      both display forms.
 *
 * The JS-side fold now lives in the shared `canonicalizeNameForLookup`
 * (packages/shared/src/names.ts) so the two client render paths and
 * this server side stay in lockstep. Adding new forms there (THIN
 * SPACE U+2009, ZWSP U+200B, etc.) MUST be mirrored by hand in the
 * SQL twin {@link loweredSpaceCanonical} below (`char(160)`), the
 * JS import cannot cover the SQLite side.
 */

/**
 * Re-exported from `@thekeep/shared` for the existing
 * `../lib/nameLookup.js` importers. Lowercases AND folds every
 * space-equivalent codepoint to ASCII space; use it on the INPUT side
 * of a lookup and pair with {@link loweredSpaceCanonical} on the
 * COLUMN side.
 */
export { canonicalizeNameForLookup };

/**
 * Drizzle SQL fragment that produces the lowered + space-folded form
 * of a column for use in `WHERE`. SQLite's `REPLACE(lower(col),
 * char(160), ' ')` matches what {@link canonicalizeNameForLookup}
 * does on the JS side. `char(160)` is the SQLite literal for U+00A0
 * (NBSP).
 *
 * Indexed lookups on `lower(col)` (the existing unique indexes on
 * `users.username` and `characters.name`) won't be used by queries
 * routed through this helper, the expression no longer matches the
 * indexed form. For now that's acceptable: name lookups are
 * low-volume + small tables. If a perf hit shows up, the right next
 * step is a precomputed canonical column with its own index.
 */
export function loweredSpaceCanonical(col: AnyColumn): SQL {
  return sql`replace(lower(${col}), char(160), ' ')`;
}

/**
 * Build a `WHERE` clause that exact-matches the lowered + space-
 * folded form of `col` against the lowered + space-folded form of
 * the input.
 *
 *   eqNameInsensitive(users.username, "John Doe")
 *     → replace(lower(users.username), char(160), ' ') = 'john doe'
 *
 * Hits a master row whose canonical username is `John Doe`
 * (NBSP) AND a master row literally named `John Doe` (ASCII space,
 * if any) AND a character `John Doe`, i.e. every space-equivalent
 * spelling collapses to the same match. The caller still scopes the
 * comparison to the right table.
 */
export function eqNameInsensitive(col: AnyColumn, input: string): SQL {
  const canonical = canonicalizeNameForLookup(input);
  return sql`${loweredSpaceCanonical(col)} = ${canonical}`;
}

/**
 * Like {@link eqNameInsensitive} but for `LIKE %query%` substring
 * matches, the shape the user-directory / mention-autocomplete
 * endpoints want. Escapes the SQL LIKE wildcards (`%` and `_`) in
 * the input so a literal underscore or percent in a search term
 * doesn't widen the match.
 *
 *   substringNameInsensitive(users.username, "john d")
 *     → replace(lower(users.username), char(160), ' ') LIKE '%john d%' ESCAPE '\'
 */
export function substringNameInsensitive(col: AnyColumn, input: string): SQL {
  const canonical = canonicalizeNameForLookup(input);
  const escaped = escapeLike(canonical);
  return sql`${loweredSpaceCanonical(col)} LIKE ${"%" + escaped + "%"} ESCAPE '\\'`;
}

/**
 * Escape the SQL `LIKE` wildcards (`%` and `_`) in a raw search term so
 * a literal underscore or percent the user typed matches literally
 * instead of widening the pattern. The backslash is the escape char, so
 * every wildcard becomes `\%` / `\_`; pair the resulting pattern with an
 * explicit `ESCAPE '\\'` clause (SQLite has no default LIKE escape).
 *
 *   `... LIKE ${"%" + escapeLike(q) + "%"} ESCAPE '\\'`
 *
 * This is the narrow, column-agnostic twin of
 * {@link substringNameInsensitive}: it does ONLY the wildcard escape,
 * with no lowercasing and no NBSP/space folding, so callers that search
 * message bodies or non-name columns keep their exact current matching.
 */
export function escapeLike(s: string): string {
  return s.replace(/[%_]/g, (c) => `\\${c}`);
}
