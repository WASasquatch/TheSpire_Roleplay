import { extractMentions as sharedExtractMentions, mentionRegex, splitOnCode } from "@thekeep/shared";

/**
 * Render-time mention parsing. The regex + extractMentions live in
 * `packages/shared/src/mentions.ts` so the server's notification path
 * can't drift from the client's render path. This module layers
 * splitMentions on top for the message renderer.
 */

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
 * preserves all original characters — concatenating every `text`/`raw`
 * (or `@world:slug` for world mentions) back together reproduces the input,
 * minus any backslash an author placed to escape an `@`.
 *
 * Suppression rules so authors can show what a mention LOOKS like without
 * pinging anyone:
 *   - `@…` inside an inline `code` span or a fenced ```code``` block is
 *     left as plain text. The shared `splitOnCode` segmenter identifies
 *     those regions; this function only extracts mentions from the
 *     non-code segments.
 *   - A backslash immediately before the `@` escapes the mention: the
 *     backslash is dropped and `@name` survives as literal text.
 */
export function splitMentions(body: string): BodyPart[] {
  const out: BodyPart[] = [];
  for (const seg of splitOnCode(body)) {
    if (seg.kind === "code") {
      // Code regions pass through verbatim — downstream `parseInline`
      // re-tokenizes the backticks and renders them as <code>.
      out.push({ kind: "text", text: seg.raw });
      continue;
    }
    extractFromTextSegment(seg.raw, out);
  }
  return out;
}

function extractFromTextSegment(text: string, out: BodyPart[]): void {
  let lastIndex = 0;
  for (const m of text.matchAll(mentionRegex())) {
    const matched = m[0];
    const prefix = m.groups?.prefix ?? "";
    const worldSlug = m.groups?.worldSlug;
    const userName = m.groups?.userName;
    const start = m.index ?? 0;
    const escaped = prefix === "\\";
    // Text up to this match. When the match is escaped, the captured
    // prefix (a `\`) is dropped from the surrounding text; otherwise it
    // rides along as plain text just like the rest of the body.
    const textChunk = text.slice(lastIndex, start) + (escaped ? "" : prefix);
    if (textChunk) out.push({ kind: "text", text: textChunk });
    if (escaped) {
      // The matched span (after the prefix we already dropped) is the
      // `@name` or `@world:slug` itself — emit it as literal text.
      out.push({ kind: "text", text: matched.slice(prefix.length) });
    } else if (worldSlug) {
      out.push({ kind: "world-mention", slug: worldSlug.toLowerCase() });
    } else if (userName) {
      out.push({ kind: "mention", raw: userName, name: userName.toLowerCase() });
    }
    lastIndex = start + matched.length;
  }
  if (lastIndex < text.length) out.push({ kind: "text", text: text.slice(lastIndex) });
}

/** Re-export the shared extractor so existing call sites keep working. */
export const extractMentions = sharedExtractMentions;

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
