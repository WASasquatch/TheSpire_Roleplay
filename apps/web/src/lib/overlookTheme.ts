/**
 * Bridge the site's active palette onto the Excalidraw canvas.
 *
 * HOW EXCALIDRAW DARK MODE ACTUALLY WORKS: `theme="dark"` does not restyle
 * elements. It applies one CSS filter to the whole canvas,
 * `invert(93%) hue-rotate(180deg)`, so a default near-black stroke comes out
 * near-white, and a manually-coloured element keeps its hue while its
 * lightness flips. That is exactly the behaviour we want (default shapes
 * invert, deliberate colours survive recognisably) and it costs one prop.
 *
 * THE CATCH: the filter also hits `viewBackgroundColor`, which is painted
 * onto the same canvas. Feeding it our theme's dark `bg` would run it through
 * the invert and produce a LIGHT canvas. So in dark mode we store the
 * PRE-IMAGE: the colour that, once filtered, lands on the theme background.
 * `preimageForDarkFilter` below is that inverse, derived from the CSS filter
 * spec rather than eyeballed.
 *
 * If Excalidraw ever changes its filter constants this file is the single
 * place that has to follow; the symptom would be a canvas background that
 * doesn't quite match the chat behind it, not a broken canvas.
 */
import { isDarkPalette, type Theme } from "@thekeep/shared";

/** Excalidraw's `DARK_THEME_FILTER` invert amount. */
const INVERT = 0.93;

/**
 * The CSS `hue-rotate(180deg)` colour matrix, per the filter-effects spec.
 * At 180 degrees cos = -1 and sin = 0, which collapses the general form to
 * these constants. Two properties make the inverse below cheap:
 *   - each row sums to 1, so greys pass through untouched
 *   - a 180 degree rotation is its own inverse (two of them make 360)
 */
const HUE_180: readonly [number, number, number][] = [
  [-0.574, 1.43, 0.144],
  [0.426, 0.43, 0.144],
  [0.426, 1.43, -0.856],
];

function applyHue180(rgb: [number, number, number]): [number, number, number] {
  const out = HUE_180.map(
    (row) => (row[0] ?? 0) * rgb[0] + (row[1] ?? 0) * rgb[1] + (row[2] ?? 0) * rgb[2],
  );
  return [out[0] ?? 0, out[1] ?? 0, out[2] ?? 0];
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m?.[1]) {
    const n = Number.parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const short = /^#?([0-9a-f]{3})$/i.exec(hex.trim());
  if (short?.[1]) {
    const [r, g, b] = short[1].split("");
    return [
      Number.parseInt(`${r}${r}`, 16) / 255,
      Number.parseInt(`${g}${g}`, 16) / 255,
      Number.parseInt(`${b}${b}`, 16) / 255,
    ];
  }
  return null;
}

function toHex(rgb: [number, number, number]): string {
  const part = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

/**
 * Given the colour we want to SEE on a dark-themed canvas, return the colour
 * to actually store, so the filter lands on it.
 *
 * The forward transform is `post = M · (k·pre + j)` with `k = 1 - 2·INVERT`,
 * `j = INVERT`, and M the hue matrix. Because M maps grey to grey it also
 * maps the constant vector to itself, so the offset survives the matrix
 * untouched and the algebra reduces to `pre = M · ((post - j) / k)`, using
 * M's self-inverse property.
 *
 * Values outside the filter's reachable range clamp. That is not a bug: with
 * a 93% invert the brightest reachable result is 93% grey, so asking for pure
 * white legitimately has no pre-image and the nearest one is used.
 */
export function preimageForDarkFilter(hex: string): string | null {
  const post = parseHex(hex);
  if (!post) return null;
  const k = 1 - 2 * INVERT;
  const unoffset: [number, number, number] = [
    (post[0] - INVERT) / k,
    (post[1] - INVERT) / k,
    (post[2] - INVERT) / k,
  ];
  return toHex(applyHue180(unoffset));
}

export interface OverlookThemeBridge {
  /** Straight through to Excalidraw's `theme` prop. */
  theme: "light" | "dark";
  /** Store this as `appState.viewBackgroundColor`. Already pre-imaged. */
  viewBackgroundColor: string;
  /** True when the canvas is running the invert filter. */
  dark: boolean;
}

/**
 * Derive everything the canvas needs from the viewer's active palette.
 *
 * Pure and cheap, so callers can just recompute on every render rather than
 * memoizing; the result feeds `updateScene` in an effect keyed on the theme.
 */
export function overlookThemeBridge(theme: Theme): OverlookThemeBridge {
  const dark = isDarkPalette(theme);
  if (!dark) {
    // Light mode runs no filter, so the background is stored verbatim. A
    // malformed palette value falls back to Excalidraw's own default rather
    // than painting the canvas black.
    return {
      theme: "light",
      viewBackgroundColor: parseHex(theme.bg) ? theme.bg : "#ffffff",
      dark: false,
    };
  }
  return {
    theme: "dark",
    viewBackgroundColor: preimageForDarkFilter(theme.bg) ?? "#ffffff",
    dark: true,
  };
}
