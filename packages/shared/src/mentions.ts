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
 * hyphen — matching the master-username and character-name validators.
 * The leading boundary requires a non-name char so "foo@bar" inside an
 * email doesn't fire a mention.
 *
 * The world: prefix matches FIRST in the alternation so "world" can't
 * accidentally parse as a username when followed by `:slug`.
 */
export const MENTION_NAME_CLASS = "[\\p{L}\\p{N}_\\-]";
export const MENTION_WORLD_SLUG_CHARS = "[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?";

/**
 * Build a fresh regex on every call. RegExp objects with the `g` flag
 * carry mutable `lastIndex` state across `.exec` calls; sharing one
 * across an iteration of `matchAll` is fine but sharing a singleton
 * across modules is not.
 */
export function mentionRegex(): RegExp {
  return new RegExp(
    `(?<prefix>^|[^\\p{L}\\p{N}_\\-])@(?:world:(?<worldSlug>${MENTION_WORLD_SLUG_CHARS})|(?<userName>${MENTION_NAME_CLASS}{1,32}))`,
    "gu",
  );
}

/**
 * Extract every lowercased @username mention from a body, ignoring world
 * mentions. Used on both sides for notification gating: the client to
 * decide whether to surface a desktop toast, the server to decide
 * whether to push to an offline recipient.
 */
export function extractMentions(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(mentionRegex())) {
    const userName = m.groups?.userName;
    if (userName) out.push(userName.toLowerCase());
  }
  return out;
}
