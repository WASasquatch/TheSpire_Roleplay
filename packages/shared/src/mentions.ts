import { splitOnCode } from "./codemask.js";

/**
 * Mention parsing — shared between client (rendering + ping detection) and
 * server (push-trigger fan-out). Single regex with named capture groups so
 * both sides agree on what counts as a mention and neither can drift if
 * the alternation is reordered.
 *
 * Two flavors:
 *   @username       resolves to a master account or active character. The
 *                   click handler delegates to profile:fetch on the web,
 *                   and the push pipeline notifies the matched user when
 *                   they're offline.
 *   @world:slug     resolves to a world by slug — opens the World viewer
 *                   modal on click. Deliberately NOT counted as a ping;
 *                   linking a world isn't directing attention at a person.
 *
 * Name characters: Unicode letters (\p{L}), numbers (\p{N}), underscore,
 * hyphen, plus NBSP (U+00A0) — matching the master-username and
 * character-name validators. Master usernames use NBSP as their "fake
 * space" separator (`The[NBSP]Doctor`) and the autocomplete inserts
 * NBSPs in place of any regular spaces in a character displayName, so
 * a multi-word mention like `@The Doctor` (rendered with NBSP under
 * the hood) parses as a single token. Regular U+0020 spaces are
 * deliberately NOT in the class — they'd make the parser greedy and
 * cause `@Bob waves at someone` to consume the whole tail.
 *
 * The leading boundary requires start-of-string, whitespace, or `\`
 * (the escape character). Earlier this accepted any non-name char,
 * which caused `@user` substrings inside URLs (e.g. tiktok.com/@user)
 * to be parsed as mentions — the `/` before `@` counted as a
 * boundary. Restricting to whitespace + start of input makes the
 * mention a true word-level token: it has to stand alone, not appear
 * embedded in a path, email, or other punctuation-rich string.
 *
 * The world: prefix matches FIRST in the alternation so "world" can't
 * accidentally parse as a username when followed by `:slug`.
 */
// Inner character set, exported as the bare contents so we can reuse it
// in BOTH the name class and its negation (the leading-boundary check).
// Letters, numbers, underscore, hyphen, plus NBSP (the chosen "fake
// space" for multi-word usernames + autocomplete-inserted character
// names).
export const MENTION_NAME_CHARS = "\\p{L}\\p{N}_\\-\\u00A0";
export const MENTION_NAME_CLASS = `[${MENTION_NAME_CHARS}]`;
export const MENTION_WORLD_SLUG_CHARS = "[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?";

/**
 * Build a fresh regex on every call. RegExp objects with the `g` flag
 * carry mutable `lastIndex` state across `.exec` calls; sharing one
 * across an iteration of `matchAll` is fine but sharing a singleton
 * across modules is not.
 *
 * Name length cap matches the master / character name validators
 * (40 chars). Previously this was 32, which silently truncated the
 * tail of any 33-40 char mention.
 */
export function mentionRegex(): RegExp {
  return new RegExp(
    `(?<prefix>^|[\\s\\\\])@(?:world:(?<worldSlug>${MENTION_WORLD_SLUG_CHARS})|(?<userName>${MENTION_NAME_CLASS}{1,40}))`,
    "gu",
  );
}

/**
 * Extract every lowercased @username mention from a body, ignoring world
 * mentions. Used on both sides for notification gating: the client to
 * decide whether to surface a desktop toast, the server to decide
 * whether to push to an offline recipient.
 *
 * Mirrors the render-side suppression rules so a name typed inside a
 * code span or escaped with a leading backslash doesn't ping someone:
 *   - `@…` inside `code` or fenced ```code``` is skipped (the shared
 *     `splitOnCode` segmenter identifies those regions).
 *   - A `\` immediately before the `@` escapes the mention; the captured
 *     prefix tells us when to skip.
 */
export function extractMentions(body: string): string[] {
  const out: string[] = [];
  for (const seg of splitOnCode(body)) {
    if (seg.kind === "code") continue;
    for (const m of seg.raw.matchAll(mentionRegex())) {
      const userName = m.groups?.userName;
      if (!userName) continue;
      if ((m.groups?.prefix ?? "") === "\\") continue;
      out.push(userName.toLowerCase());
    }
  }
  return out;
}
