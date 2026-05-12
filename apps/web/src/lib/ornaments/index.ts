/**
 * Theme style system — public API.
 *
 * `applyStyle(theme, styleKey)` is the entry point. The caller (typically
 * App.tsx) invokes it AFTER `applyTheme` has set the color custom
 * properties, so the ornament generator can read the live ramps off
 * `:root` and produce its data URLs.
 *
 * Each ornament becomes a `--orn-*` custom property on `<html>` which the
 * CSS layer consumes through `background-image: var(--orn-*)`. A style
 * may choose to skip an ornament by returning `"none"` (or omitting it
 * from the OrnamentSet); the consumer falls back to flat color.
 *
 * The result of each `(themeHash, styleKey)` pair is memoized for the
 * session — switching back to a previously-applied combination is
 * instant (no canvas re-render).
 */

import type { Theme } from "@thekeep/shared";
import { buildRamp, rgbTripleToHex } from "../theme.js";
import { medieval } from "./styles/medieval.js";
import { modern } from "./styles/modern.js";
import { scifi } from "./styles/scifi.js";
import type { OrnamentKey, OrnamentPalette, OrnamentSet, StyleGenerator } from "./types.js";

/** Every ornament key the CSS layer might read. Used to clear stale props on style switch. */
const ALL_ORNAMENT_KEYS: ReadonlyArray<OrnamentKey> = [
  "corner-tl", "corner-tr", "corner-bl", "corner-br",
  "divider", "texture", "bg-overlay",
];

/**
 * Registry of available styles. Three families — each a complete design
 * language, not just a texture variant:
 *
 *   medieval — flat warm surfaces, soft inset shadows, parchment palette
 *              defaults, drop shadows on bottom, serif headers.
 *   modern   — soft two-tone gradients, rounded corners, light shadows.
 *   scifi    — glass + multi-color radial bokeh, neon glow on focus,
 *              sharp corners, action-color edges.
 *
 * The 9-substyle catalog (medieval-parchment / sandstone / wood, etc.)
 * was collapsed to these three: with textures removed the sub-variants
 * looked identical and only diluted the design language. Insertion order
 * drives picker order.
 */
export const STYLES: Record<string, StyleGenerator> = {
  [medieval.key]: medieval,
  [modern.key]: modern,
  [scifi.key]: scifi,
};

/** Default style id used when a user/site hasn't picked one yet. */
export const DEFAULT_STYLE_KEY = medieval.key;

/** List of available styles for picker UIs (Phase 2 admin panel + user profile). */
export function listStyles(): Array<{ key: string; label: string }> {
  return Object.values(STYLES).map((s) => ({ key: s.key, label: s.label }));
}

/**
 * Compute (or retrieve from cache) the ornament set for a theme+style pair
 * and set it on `<html>`. Run from the same effect chain as `applyTheme`.
 *
 * Cache key combines the 8 theme hex values + the style key. Both must
 * match for a cache hit, so re-applying after a single color change
 * regenerates (cheap — canvas drawing is microseconds on these small
 * surfaces).
 */
const cache = new Map<string, OrnamentSet>();

export function applyStyle(theme: Theme, styleKey: string | null): void {
  const root = document.documentElement;
  const generator = (styleKey && STYLES[styleKey]) || STYLES[DEFAULT_STYLE_KEY];
  if (!generator) {
    // No styles registered — clear any leftover props and bail.
    clearOrnaments(root);
    return;
  }

  const cacheKey = `${generator.key}::${JSON.stringify(theme)}`;
  let ornaments = cache.get(cacheKey);
  if (!ornaments) {
    const palette = buildPaletteFromTheme(theme);
    try {
      ornaments = generator.generate(palette);
    } catch (err) {
      console.warn("[ornaments] generator failed", err);
      clearOrnaments(root);
      return;
    }
    cache.set(cacheKey, ornaments);
  }

  // Set new props + clear any key the new style didn't define so a
  // previous style's leftover URL doesn't survive across switches.
  for (const key of ALL_ORNAMENT_KEYS) {
    const v = ornaments[key];
    root.style.setProperty(`--orn-${key}`, v ?? "none");
  }
  root.setAttribute("data-theme-style", generator.key);
}

function clearOrnaments(root: HTMLElement): void {
  for (const key of ALL_ORNAMENT_KEYS) {
    root.style.setProperty(`--orn-${key}`, "none");
  }
  root.removeAttribute("data-theme-style");
}

/**
 * Build an `OrnamentPalette` directly from a Theme. Each slot's 5-step
 * ramp comes from `buildRamp` (which returns "r g b" triples); we convert
 * back to "#rrggbb" so canvas code can use the values as `fillStyle`
 * directly without re-parsing on every pixel.
 */
function buildPaletteFromTheme(theme: Theme): OrnamentPalette {
  return {
    bg: buildRamp(theme.bg).map(rgbTripleToHex),
    panel: buildRamp(theme.panel).map(rgbTripleToHex),
    border: buildRamp(theme.border).map(rgbTripleToHex),
    text: buildRamp(theme.text).map(rgbTripleToHex),
    muted: buildRamp(theme.muted).map(rgbTripleToHex),
    action: buildRamp(theme.action).map(rgbTripleToHex),
    accent: buildRamp(theme.accent).map(rgbTripleToHex),
    system: buildRamp(theme.system).map(rgbTripleToHex),
  };
}
