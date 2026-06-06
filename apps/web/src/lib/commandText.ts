/**
 * Helpers for building slash-command strings that include a user- or
 * character-name as a positional argument.
 *
 * The server's command parser
 * (apps/server/src/commands/parser.ts) splits arguments on ASCII
 * whitespace but treats NBSP (U+00A0) as a normal word character, by
 * design, since master usernames are allowed to contain spaces and the
 * canonical storage form uses NBSP for the in-name separators. The
 * name-lookup helper (apps/server/src/lib/nameLookup.ts) normalizes
 * ASCII space ↔ NBSP at query time, so a name written either way
 * matches the stored row.
 *
 * Practical consequence for the client: when we prepend a name into a
 * command (e.g. `/whisper Khalbir Dhor'ashiq Hello`) we MUST swap any
 * ASCII spaces inside the name for NBSPs first, otherwise the tokenizer
 * splits "Khalbir Dhor'ashiq" into two args and the command sees only
 * "Khalbir", which is exactly the `[WHISPER_NO_USER] No user named
 * "Khalbir"` failure users have been hitting on multi-word handles.
 *
 * Double-quoting would also work syntactically (the tokenizer accepts
 * `"…"` and `'…'`), but apostrophes inside names like "Dhor'ashiq"
 * collide with single quotes, and a stray user-typed quote inside a
 * double-quoted name silently truncates the argument. NBSP is
 * invisible, lossless, and is the route the parser was designed for.
 */

const ASCII_SPACE_RX = / +/g;
const NBSP = " ";

/**
 * Render a name for use as a positional argument in a slash command.
 * Replaces every run of ASCII spaces with a single NBSP so the server's
 * tokenizer keeps the name as one argument; non-space characters
 * (apostrophes, hyphens, dots, backticks, alphanumerics) pass through
 * untouched. Empty / whitespace-only input returns "", callers that
 * care should validate before calling.
 */
export function nameForCommand(name: string): string {
  return name.replace(ASCII_SPACE_RX, NBSP);
}

/**
 * Build a slash-command target argument from an identity. Prefers
 * the unambiguous token form (`@cid:<id>` for characters,
 * `@id:<userId>` for masters) whenever the caller already has the
 * id, falling back to the NBSP-escaped name only when neither id is
 * available.
 *
 * Server-side `resolveIdentityArg` accepts both forms in the same
 * argument slot, so callers can switch to this helper without any
 * coordinated parser change, the token branch just skips the
 * name-lookup ambiguity check entirely.
 *
 * Use this for every click-driven command builder (chat-line whisper
 * click, profile-modal Whisper / Ignore / Friend buttons, userlist
 * row click) so the resulting command can't get mis-routed when two
 * users share the typed name.
 */
export function identityArgFor(input: {
  userId: string | null | undefined;
  characterId: string | null | undefined;
  displayName: string;
}): string {
  if (input.characterId) return `@cid:${input.characterId}`;
  if (input.userId) return `@id:${input.userId}`;
  return nameForCommand(input.displayName);
}
