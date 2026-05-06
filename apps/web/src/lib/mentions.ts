/**
 * @username mention parsing — pure, used by both the message renderer and
 * the notification decision. Mentions resolve to a master username OR an
 * active character's name; the click handler delegates to profile:fetch
 * which already resolves both forms.
 *
 * Name characters: Unicode letters (\p{L}), numbers (\p{N}), underscore,
 * and hyphen — matching what the username/character validators allow on
 * the server side. The boundary BEFORE the @ requires a non-name char
 * (so "foo@bar" inside an email doesn't trigger a mention) and the
 * boundary AFTER the name is implicit (the regex is greedy up to a
 * non-name char).
 */
const NAME_CLASS = "[\\p{L}\\p{N}_\\-]";
const MENTION_RE = new RegExp(
  `(^|[^\\p{L}\\p{N}_\\-])@(${NAME_CLASS}{1,32})`,
  "gu",
);

export interface MentionPart {
  kind: "mention";
  /** Original casing as typed (used for display). */
  raw: string;
  /** Lower-cased name for resolution and self-detection. */
  name: string;
}

export interface TextPart {
  kind: "text";
  text: string;
}

export type BodyPart = TextPart | MentionPart;

/**
 * Split a message body into alternating text and mention parts. The output
 * preserves all original characters — concatenating every `text`/`raw`
 * back together (with `@` prefix for mentions) reproduces the input.
 */
export function splitMentions(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  let lastIndex = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const [, prefix, name] = m;
    const start = m.index ?? 0;
    // Anything before this match (including the prefix character that
    // preceded the @) becomes text.
    const textChunk = body.slice(lastIndex, start) + (prefix ?? "");
    if (textChunk) parts.push({ kind: "text", text: textChunk });
    parts.push({ kind: "mention", raw: name ?? "", name: (name ?? "").toLowerCase() });
    lastIndex = start + (prefix?.length ?? 0) + 1 /* @ */ + (name?.length ?? 0);
  }
  if (lastIndex < body.length) parts.push({ kind: "text", text: body.slice(lastIndex) });
  return parts;
}

/**
 * Extract every lowercased mention name from a body. Used by the
 * notification path to check whether a message mentions the viewer.
 */
export function extractMentions(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    if (m[2]) out.push(m[2].toLowerCase());
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
