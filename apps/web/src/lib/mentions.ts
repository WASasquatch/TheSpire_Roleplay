import { extractMentions as sharedExtractMentions, mentionRegex } from "@thekeep/shared";

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
 * preserves all original characters - concatenating every `text`/`raw`
 * (or `@world:slug` for world mentions) back together reproduces the input.
 */
export function splitMentions(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  let lastIndex = 0;
  for (const m of body.matchAll(mentionRegex())) {
    const matched = m[0];
    const prefix = m.groups?.prefix;
    const worldSlug = m.groups?.worldSlug;
    const userName = m.groups?.userName;
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
    lastIndex = start + matched.length;
  }
  if (lastIndex < body.length) parts.push({ kind: "text", text: body.slice(lastIndex) });
  return parts;
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
