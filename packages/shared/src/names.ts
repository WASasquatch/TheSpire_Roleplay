/**
 * Canonical character-name validation shared by the two server creation
 * paths (`/char create` in commands/builtins/char.ts and the
 * `POST /characters` route in routes/characters.ts) so they stay in
 * lockstep.
 *
 * A non-breaking space (U+00A0) is allowed and PRESERVED: the command
 * parser treats NBSP as a normal word character (see commands/parser.ts),
 * so a two-word name stays one token and works with /whisper, /char,
 * etc. An ASCII space is still accepted here for backward compatibility
 * with existing names and the `/char create` command, but the client
 * creation UIs steer new names away from it (it splits on whitespace and
 * breaks those same commands).
 */
export const CHAR_NAME_RX = /^[\p{L}\p{N}_\-'\u00A0 ]{1,40}$/u;

/**
 * Normalize a typed character name before the regex check. Trims
 * surrounding whitespace (including edge NBSP) but PRESERVES interior
 * NBSP (U+00A0): folding it to an ASCII space used to defeat the whole
 * point of typing Alt+0160 for a parser-safe name; the stored value
 * came back with a real space that breaks /whisper, /char, and every
 * other name-taking command. Name lookups canonicalize NBSP-vs-space
 * via `eqNameInsensitive`, so switching / editing / deleting still
 * resolves regardless of which form the user typed or stored, and dup
 * detection stays space-insensitive so two-word names collide.
 */
export function normalizeCharName(input: string): string {
  return input.trim();
}

/**
 * Set of Unicode codepoints treated as equivalent to a regular ASCII
 * space when matching names. Currently:
 *   - U+0020 SPACE                    (the canonical)
 *   - U+00A0 NO-BREAK SPACE           (Alt+0160; master-username "fake space")
 *
 * U+2009 THIN SPACE, U+200B ZERO-WIDTH SPACE, etc. are NOT included
 * yet, adding them would silently collapse genuinely-different display
 * names. Re-evaluate if a new failure mode shows up.
 *
 * NB: the SQLite side of this fold lives in `loweredSpaceCanonical`
 * (`apps/server/src/lib/nameLookup.ts`) as `char(160)`. Adding a new
 * form here is a one-line change that must be mirrored there in
 * lockstep, the JS import cannot cover the SQL twin.
 */
const SPACE_EQUIVALENTS = /[ ]/g;

/**
 * Canonicalize a name string for lookup / mention matching. Lowercases
 * AND folds every space-equivalent codepoint (NBSP → ASCII space) so a
 * name typed or rendered with the "fake space" matches the same name
 * typed with a regular space. Used both server-side (paired with
 * `loweredSpaceCanonical` on the column side of a query) and client-side
 * (self-name highlight + mention-chip resolution in the message
 * renderers). NB: does NOT trim, leading/trailing whitespace is the
 * caller's call (we don't want to silently strip a leading NBSP from a
 * name that actually starts with one, though that would fail the
 * validator on registration anyway).
 */
export function canonicalizeNameForLookup(name: string): string {
  return name.replace(SPACE_EQUIVALENTS, " ").toLowerCase();
}
