/**
 * Mention parsing - pure, used by both the message renderer and the
 * notification decision. Two flavors share one tokenizer pass:
 *
 *   @username        resolves to a master account or active character's
 *                    name. The click handler delegates to profile:fetch.
 *
 *   @world:slug      resolves to a world by slug. The click handler opens
 *                    the World viewer modal. Slug characters mirror the
 *                    SLUG_RX in apps/server/src/routes/worlds.ts:
 *                    [a-z0-9][a-z0-9-]{0,58}[a-z0-9]? - lowercase letters,
 *                    digits, and hyphens, 1-60 chars.
 *
 * Name characters for @username: Unicode letters (\p{L}), numbers (\p{N}),
 * underscore, and hyphen - matching what the username/character validators
 * allow on the server side. The boundary BEFORE the @ requires a non-name
 * char (so "foo@bar" inside an email doesn't trigger a mention).
 *
 * The world: prefix is matched FIRST in the alternation so "world" doesn't
 * accidentally parse as a username when followed by a colon + valid slug.
 */
const NAME_CLASS = "[\\p{L}\\p{N}_\\-]";
const WORLD_SLUG_CHARS = "[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?";
const MENTION_RE = new RegExp(
  `(^|[^\\p{L}\\p{N}_\\-])@(?:world:(${WORLD_SLUG_CHARS})|(${NAME_CLASS}{1,32}))`,
  "gu",
);

export interface MentionPart {
  kind: "mention";
  /** Original casing as typed (used for display). */
  raw: string;
  /** Lower-cased name for resolution and self-detection. */
  name: string;
}

export interface WorldMentionPart {
  kind: "world-mention";
  /** Original slug as typed (slugs are lowercase by spec, so display = canonical). */
  slug: string;
}

export interface TextPart {
  kind: "text";
  text: string;
}

export type BodyPart = TextPart | MentionPart | WorldMentionPart;

/**
 * Split a message body into alternating text and mention parts. The output
 * preserves all original characters - concatenating every `text`/`raw`
 * (or `@world:slug` for world mentions) back together reproduces the input.
 */
export function splitMentions(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  let lastIndex = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const [matched, prefix, worldSlug, userName] = m;
    const start = m.index ?? 0;
    // Anything before this match (including the prefix character that
    // preceded the @) becomes text.
    const textChunk = body.slice(lastIndex, start) + (prefix ?? "");
    if (textChunk) parts.push({ kind: "text", text: textChunk });
    if (worldSlug) {
      parts.push({ kind: "world-mention", slug: worldSlug.toLowerCase() });
    } else if (userName) {
      parts.push({ kind: "mention", raw: userName, name: userName.toLowerCase() });
    }
    lastIndex = start + (matched?.length ?? 0);
  }
  if (lastIndex < body.length) parts.push({ kind: "text", text: body.slice(lastIndex) });
  return parts;
}

/**
 * Extract every lowercased @username mention from a body (excluding world
 * mentions, which never trigger notifications). Used by the notification
 * path to check whether a message mentions the viewer.
 */
export function extractMentions(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    // Group 3 is the username branch; group 2 is the world-slug branch
    // which we deliberately ignore here - linking a world isn't a ping.
    if (m[3]) out.push(m[3].toLowerCase());
  }
  return out;
}

/**
 * Returns true if any @mention in `body` matches one of the provided
 * `selfNames` (master username and active character name, lower-cased).
 */
export function isMentioned(body: string, selfNames: ReadonlyArray<string>): boolean {
  if (selfNames.length === 0) return false;
  const set = new Set(selfNames.map((n) => n.toLowerCase()));
  for (const name of extractMentions(body)) {
    if (set.has(name)) return true;
  }
  return false;
}
