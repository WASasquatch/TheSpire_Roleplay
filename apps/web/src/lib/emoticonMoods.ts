/**
 * Map an emoticon's label to an animation family. The label string is
 * the truth (admins type it; the cell index is just a slot) — so we
 * pattern-match keywords rather than hard-coding indices. Unknown
 * labels fall back to a generic pop.
 *
 * Each entry returns the CSS class that, when applied to a chip OR
 * a sprite, triggers the matching keyframe animation defined in
 * styles.css. Animations are one-shot (forwards / 0.6-0.8s) so the
 * class can be left on the element after the animation completes
 * without re-triggering.
 */
const KEYWORD_TO_MOOD: Array<{ match: RegExp; mood: EmoticonMood }> = [
  // Joyful / smug — bouncy overshoot + warm gold flash.
  { match: /(happy|laugh|smug|grin|joy)/i, mood: "joyful" },
  // Fiery / angry / determined — shake + red flash.
  { match: /(angry|mad|rage|fury|determin|fierce)/i, mood: "fiery" },
  // Melancholy / tears — droops in from above with cool tint.
  { match: /(sad|cry|tear|sleep|tired|sob)/i, mood: "melancholy" },
  // Jolt / shock — fast zoom with white halo.
  { match: /(surpris|shock|gasp|wow)/i, mood: "jolt" },
  // Flush — pink fade-in tilt.
  { match: /(embarrass|blush|flush|shy)/i, mood: "flush" },
  // Heart pulse — repeating beat with pink glow.
  { match: /(love|heart|romance|smitten|swoon)/i, mood: "lovestruck" },
  // Wobble — confused rotation.
  { match: /(confus|puzzl|baffl|huh|what)/i, mood: "confused" },
];

export type EmoticonMood =
  | "joyful"
  | "fiery"
  | "melancholy"
  | "jolt"
  | "flush"
  | "lovestruck"
  | "confused"
  | "default";

export function moodForLabel(label: string | null | undefined): EmoticonMood {
  if (!label) return "default";
  for (const { match, mood } of KEYWORD_TO_MOOD) {
    if (match.test(label)) return mood;
  }
  return "default";
}

/** Class name used by EmoticonSprite + ReactionChip to apply the
 *  mood-specific one-shot pop animation on mount. */
export function animationClassForLabel(label: string | null | undefined): string {
  return `emoticon-anim-${moodForLabel(label)}`;
}
