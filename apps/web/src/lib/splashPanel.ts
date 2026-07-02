/**
 * Shared front-page (splash) container chrome, so every content block reads as a
 * consistent panel and lights up the same way on hover.
 *
 * - `SPLASH_PANEL`      — the neutral bordered container surface.
 * - `SPLASH_GLOW`       — hover accent glow + ring, WITHOUT touching the border
 *   colour (for panels that already carry an intentional accent border, e.g. the
 *   teal/gold hero cards).
 * - `SPLASH_PANEL_HOVER` — `SPLASH_GLOW` plus a border brighten to the action
 *   accent, for neutral (keep-border) panels.
 */
export const SPLASH_PANEL = "rounded-md border border-keep-border/50 bg-keep-panel/30";

export const SPLASH_GLOW =
  "transition-all duration-200 hover:shadow-[0_12px_36px_-16px_rgb(var(--keep-action)/0.45)] hover:ring-1 hover:ring-keep-action/20";

export const SPLASH_PANEL_HOVER = `${SPLASH_GLOW} hover:border-keep-action/60`;
