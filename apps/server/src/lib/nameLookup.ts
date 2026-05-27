import { sql, type SQL, type AnyColumn } from "drizzle-orm";

/**
 * Space-insensitive, case-insensitive name matching helpers.
 *
 * Master usernames store NBSP (U+00A0) as the "fake space" separator
 * (see `MASTER_USERNAME_RX` in routes/auth.ts) — regular spaces never
 * appear in the username column. Character names go the other way:
 * the validator allows ASCII space, not NBSP. This split was good
 * for storage (each side has a single canonical form) but bad for
 * lookups: a user typing `/whisper John Doe` against a master named
 * `John Doe`, or `+ Friend "Some Char"` against a character
 * named `Some Char`, ends up with a name string that doesn't
 * literally match either column. The bug surfaced as "I can't
 * whisper this person", "they say my DMs aren't reaching them",
 * "they don't show up in the add-friend autocomplete or the DM
 * compose-to-non-friend lookup".
 *
 * The fix is to make every name lookup treat U+00A0 and U+0020 as
 * interchangeable. We do it at QUERY TIME (no migration, no
 * canonical column) by normalizing both sides — the stored value
 * via `REPLACE(LOWER(col), char(160), ' ')` and the typed input
 * via {@link canonicalizeNameForLookup}. The stored display name
 * is untouched; it always renders exactly how it was registered.
 *
 * Why not just store one canonical form on insert? Two reasons:
 *   1. Existing rows have whichever space form their validator
 *      enforced at registration time. Backfilling would lose the
 *      historical fidelity of `John Doe` vs `John Doe` —
 *      legitimately different display intents for masters who
 *      picked NBSP on purpose.
 *   2. The unique constraint on `lower(username)` already prevents
 *      duplicates within each space-class. Treating spaces as
 *      equivalent at LOOKUP without merging on INSERT preserves
 *      both display forms.
 *
 * Adding new forms here (THIN SPACE U+2009, ZWSP U+200B, etc.) is
 * a one-line change to both `canonicalizeNameForLookup` and
 * `loweredSpaceCanonical` — keep them in lockstep.
 */

/**
 * Set of Unicode codepoints that should be treated as equivalent to
 * a regular ASCII space when matching names. Currently:
 *   - U+0020 SPACE                    (the canonical)
 *   - U+00A0 NO-BREAK SPACE           (Alt+0160; master-username "fake space")
 *
 * U+2009 THIN SPACE, U+200B ZERO-WIDTH SPACE, etc. are NOT included
 * yet — adding them would silently collapse genuinely-different
 * display names. Re-evaluate if a new failure mode shows up.
 */
const SPACE_EQUIVALENTS = /[ ]/g;

/**
 * Canonicalize a name string for lookup comparison. Lowercases AND
 * folds every space-equivalent codepoint to ASCII space. Use this on
 * the INPUT side of a lookup; pair with {@link loweredSpaceCanonical}
 * on the COLUMN side. NB: does NOT trim — leading/trailing whitespace
 * is the caller's call (we don't want to silently strip a leading
 * NBSP from a name that actually starts with one, though that would
 * fail the validator on registration anyway).
 */
export function canonicalizeNameForLookup(name: string): string {
  return name.replace(SPACE_EQUIVALENTS, " ").toLowerCase();
}

/**
 * Drizzle SQL fragment that produces the lowered + space-folded form
 * of a column for use in `WHERE`. SQLite's `REPLACE(lower(col),
 * char(160), ' ')` matches what {@link canonicalizeNameForLookup}
 * does on the JS side. `char(160)` is the SQLite literal for U+00A0
 * (NBSP).
 *
 * Indexed lookups on `lower(col)` (the existing unique indexes on
 * `users.username` and `characters.name`) won't be used by queries
 * routed through this helper — the expression no longer matches the
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
 * Hits a master row whose canonical username is `John Doe`
 * (NBSP) AND a master row literally named `John Doe` (ASCII space,
 * if any) AND a character `John Doe` — i.e. every space-equivalent
 * spelling collapses to the same match. The caller still scopes the
 * comparison to the right table.
 */
export function eqNameInsensitive(col: AnyColumn, input: string): SQL {
  const canonical = canonicalizeNameForLookup(input);
  return sql`${loweredSpaceCanonical(col)} = ${canonical}`;
}

/**
 * Like {@link eqNameInsensitive} but for `LIKE %query%` substring
 * matches — the shape the user-directory / mention-autocomplete
 * endpoints want. Escapes the SQL LIKE wildcards (`%` and `_`) in
 * the input so a literal underscore or percent in a search term
 * doesn't widen the match.
 *
 *   substringNameInsensitive(users.username, "john d")
 *     → replace(lower(users.username), char(160), ' ') LIKE '%john d%' ESCAPE '\'
 */
export function substringNameInsensitive(col: AnyColumn, input: string): SQL {
  const canonical = canonicalizeNameForLookup(input);
  const escaped = canonical.replace(/[%_]/g, (c) => `\\${c}`);
  return sql`${loweredSpaceCanonical(col)} LIKE ${"%" + escaped + "%"} ESCAPE '\\'`;
}
