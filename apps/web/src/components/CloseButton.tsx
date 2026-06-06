/**
 * CloseButton, shared dismiss control rendered as a square `×`
 * button.
 *
 * Replaces the ad-hoc `<button>close</button>` text links scattered
 * across modals/panels with a single consistent affordance. The
 * glyph is the Unicode multiplication sign (U+00D7), universally
 * recognized as "close" without needing the word, and visually
 * lighter than typing the letter "X".
 *
 * Visual: bordered square, muted color, lifts to keep-text on hover
 * with a banner-tinted background, matches the existing keep-button
 * treatment so it feels native everywhere.
 *
 * Use `aria-label` (or the default "Close") to keep screen readers
 * happy; the visual `×` is `aria-hidden` so it's not announced.
 */

interface Props {
  onClick: () => void;
  /** Defaults to "Close". Pass a more specific label when the
   *  surface needs one (e.g. "Close admin panel"). */
  label?: string;
  /** Optional extra classes for positioning/alignment in tight
   *  headers (e.g. `self-start` to keep this in the top-right of
   *  a vertically-centered flex row). */
  className?: string;
}

export function CloseButton({ onClick, label = "Close", className }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={
        "shrink-0 inline-flex h-7 w-7 items-center justify-center rounded border border-keep-rule/60 bg-keep-bg/40 text-lg leading-none text-keep-muted hover:border-keep-rule hover:bg-keep-banner/60 hover:text-keep-text focus:outline-none focus:ring-1 focus:ring-keep-action " +
        (className ?? "")
      }
    >
      <span aria-hidden>×</span>
    </button>
  );
}
