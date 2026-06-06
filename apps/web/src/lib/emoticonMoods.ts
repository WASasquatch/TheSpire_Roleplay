/**
 * Map an emoticon's label to an animation family. The label string is
 * the truth (admins type it; the cell index is just a slot), so we
 * pattern-match keywords rather than hard-coding indices. Unknown
 * labels fall back to a generic pop.
 *
 * Each entry returns the CSS class that, when applied to a chip OR
 * a sprite-button, drives the continuous keyframe animations defined
 * in styles.css (chip border / box-shadow pulse + nested face
 * transform + decorative pseudo-elements). The animations are
 * `infinite`, they read as constant signs-of-life rather than a
 * one-shot reaction. Hover-paused inside each keyframe block so the
 * chip's own scale hover affordance still reads as a deliberate
 * interaction target.
 */
const KEYWORD_TO_MOOD: Array<{ match: RegExp; mood: EmoticonMood }> = [
  // Light laughter, bouncing face + warm gold border pulse.
  // Keywords cover the broad "happy / fun" surface so any positive
  // emoticon picks up something instead of dropping to default.
  { match: /(laugh|lol|hehe|haha|chuckle|happy|joy)/i, mood: "chuckle" },
  // Squinty smile, gentler than chuckle, sways instead of bouncing.
  { match: /(giggle|snicker|teehee|grin)/i, mood: "giggle" },
  // Angry / determined, shake + red flash + ripple ring.
  { match: /(angry|mad|rage|fury|determin|fierce)/i, mood: "rage" },
  // Single quiet tear, blue border + a drip from the bottom edge.
  // Keyworded before `cry` so "sad" never falls through to crying.
  { match: /(sad|tear|sob)/i, mood: "sad" },
  // Heavy weep, multiple cascading streams + a side-to-side shake.
  { match: /(cry|weep|bawl)/i, mood: "crying" },
  // Sharp pop + "!" mark, fastest in the set so it reads as a snap.
  { match: /(surpris|shock|gasp|wow|alarm)/i, mood: "surprise" },
  // Warm flush, inset rose glow that pulses with a slow sway.
  { match: /(blush|embarrass|flush|shy)/i, mood: "blush" },
  // Slow purple glide + sparkle, the "cool smug" look.
  { match: /(smirk|smug|sly|cool)/i, mood: "smirk" },
  // Breathing border + floating "z" particles.
  { match: /(sleep|sleepy|tired|drowsy|yawn|doze)/i, mood: "sleep" },
  // Heartbeat border + orbiting hearts.
  { match: /(love|heart|romance|smitten|swoon|adore)/i, mood: "love" },
  // Tilting "?" + diagonal background pattern.
  { match: /(confus|puzzl|baffl|huh|what|unsure)/i, mood: "confused" },
  // Sharp twitch + spark, short, jittery, irritated.
  { match: /(annoy|irritat|exasperat|frown|grump)/i, mood: "annoy" },
];

export type EmoticonMood =
  | "chuckle"
  | "giggle"
  | "rage"
  | "sad"
  | "crying"
  | "surprise"
  | "blush"
  | "smirk"
  | "sleep"
  | "love"
  | "confused"
  | "annoy"
  | "default";

export function moodForLabel(label: string | null | undefined): EmoticonMood {
  if (!label) return "default";
  for (const { match, mood } of KEYWORD_TO_MOOD) {
    if (match.test(label)) return mood;
  }
  return "default";
}

/** Class name used by ReactionChip + EmoticonPicker cells to apply
 *  the mood-specific continuous animation. Stamped onto the
 *  container; CSS targets nested sprite + ::before/::after for the
 *  decorative effects. */
export function animationClassForLabel(label: string | null | undefined): string {
  return `emoticon-anim-${moodForLabel(label)}`;
}
