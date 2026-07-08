/**
 * Slug derivation shared by worlds, pages, stories, servers, and forums:
 * lowercase, non-alphanumerics → the separator, trim leading/trailing
 * separators, cap at `max` chars. The server uses this as a fallback when the
 * user doesn't supply an explicit slug; editors use it for the live preview
 * the user sees while typing a name. Both sides import from here so the
 * preview never lies about what the server will accept.
 *
 * Defaults match the original world/story slug (dash separator, 60 chars).
 * Servers use a 40-char cap; forums use `_` as the separator with a 40-char
 * cap. The edge-trim regex is built from `sep` so forums trim `_`, not `-`.
 */
export function deriveSlug(
  input: string,
  { sep = "-", max = 60 }: { sep?: string; max?: number } = {},
): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`^${sep}+|${sep}+$`, "g"), "")
    .slice(0, max);
}

/**
 * Format-validation regex for the "tight" slug shape shared by worlds,
 * stories, chat rooms, and emoticons: lowercase letters/digits/hyphens,
 * must start and end alphanumeric (no leading/trailing/edge hyphen), and
 * between 1 and `max` characters. This is the shape `deriveSlug` already
 * normalizes to; callers re-validate so a normalize-to-empty input (all
 * symbols) is rejected instead of silently writing nothing.
 *
 * `max` is the total length cap: worlds/stories/rooms use 60, community
 * emoticons use 42. The inner quantifier is `max - 2` so the single-char
 * form `[a-z0-9]` and the bookended form both stay within the cap.
 */
export function slugRx(max: number): RegExp {
  return new RegExp(`^[a-z0-9](?:[a-z0-9-]{0,${max - 2}}[a-z0-9])?$`);
}
