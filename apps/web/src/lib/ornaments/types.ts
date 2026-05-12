/**
 * Theme style system — types.
 *
 * A "style" is the orthogonal axis to the existing palette. Where palette
 * controls *what colors* the UI uses, style controls *what visual treatment*
 * those colors get applied through: parchment textures + ink filigree
 * (medieval), brushed-metal panels (modern), neon line-art + scanlines
 * (scifi).
 *
 * Each style implements a `StyleGenerator` that, given the active palette
 * ramps, returns a set of ornament data URLs the CSS layer consumes via
 * `--orn-*` custom properties on <html>. The CSS contract is uniform
 * across all styles — only the visual output of each generator changes.
 */

/**
 * The fixed set of ornament keys every style is expected to emit. A style
 * MAY return `"none"` for any of these to fall back to flat color rendering
 * for that slot (e.g. a minimalist modern style might decline to produce
 * corner ornaments).
 *
 * - `corner-*`: 24-48 px decorative pieces anchored to each corner of a
 *   panel via `::before` / `::after` pseudo-elements.
 * - `divider`: horizontal flourish placed between panel header and body,
 *   or between message groupings.
 * - `texture`: tileable subtle overlay applied at low opacity over panel
 *   surfaces (paper grain, brushed metal, hex grid, etc.).
 * - `bg-overlay`: full-app, fixed-position overlay (vignette, scanlines,
 *   ambient gradient stack). Larger and more elaborate than `texture`.
 */
export type OrnamentKey =
  | "corner-tl"
  | "corner-tr"
  | "corner-bl"
  | "corner-br"
  | "divider"
  | "texture"
  | "bg-overlay";

/**
 * Output of a `StyleGenerator`. Map from OrnamentKey to a CSS
 * `background-image` value — `url("data:image/png;base64,...")` for canvas
 * output, `url("data:image/svg+xml,...")` for vector output, or `"none"`
 * to suppress that ornament for this style.
 */
export type OrnamentSet = Partial<Record<OrnamentKey, string>>;

/**
 * Pre-computed 5-step ramps for each palette slot, ready for use inside a
 * generator. Index 0 is lightest (100), index 4 is darkest (500); index 2
 * (300) is the user-picked base. Values are "#rrggbb" strings so canvas
 * code can use them as `fillStyle` directly.
 */
export interface OrnamentPalette {
  bg: string[];
  panel: string[];
  border: string[];
  text: string[];
  muted: string[];
  action: string[];
  accent: string[];
  system: string[];
}

/**
 * The contract every style file implements + the registry that
 * `applyStyle()` consults to look up a style by key.
 */
export interface StyleGenerator {
  /** Stable identifier used in the database / settings. One of 'medieval', 'modern', 'scifi'. */
  key: string;
  /** User-facing label for the style picker. e.g. "Medieval". */
  label: string;
  /** Build the ornament set for the given palette. Pure; called whenever the theme changes. */
  generate(palette: OrnamentPalette): OrnamentSet;
}
