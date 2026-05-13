import type { CSSProperties } from "react";
import type { Theme } from "@thekeep/shared";

/**
 * Convert "#abc" / "#aabbcc" to a space-separated RGB triple ("170 187 204").
 *
 * We store hex in the database (user-facing) but emit RGB triples through
 * CSS variables so Tailwind's opacity modifiers compose correctly. The
 * Tailwind config maps each `keep-*` color to `rgb(var(--keep-X) / <alpha-value>)`,
 * which means `bg-keep-panel/30` resolves to `rgb(170 187 204 / 0.3)`.
 *
 * If the hex can't be parsed we fall back to "0 0 0" rather than throw - a
 * stray bad theme value shouldn't crash the app.
 */
export function hexToRgbTriple(hex: string): string {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return "0 0 0";
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

/**
 * Decide whether a theme is "dark". Used to set CSS `color-scheme`, which
 * tells browsers to render native form controls (select dropdowns, scrollbars,
 * date pickers, etc.) with their dark variant. Without this, an open
 * <select> menu sticks out as bright white over a dark Twilight chat.
 *
 * Uses the standard perceived-luminance formula on theme.bg.
 */
export function isDarkTheme(theme: Theme): boolean {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(theme.bg.trim());
  if (!m) return false;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

const VAR_KEYS: ReadonlyArray<keyof Theme> = [
  "bg", "panel", "border", "text", "muted", "action", "accent", "system",
];

/**
 * Convert a Theme into the inline-style object that overrides CSS variables
 * on a single element. Apply at the document level (caller's theme) or to a
 * subtree (e.g. profile modal showing the OWNER's theme).
 */
export function themeStyle(theme: Theme): CSSProperties {
  const out: Record<string, string> = {};
  for (const slot of VAR_KEYS) {
    out[`--keep-${slot}`] = hexToRgbTriple(theme[slot]);
  }
  out.colorScheme = isDarkTheme(theme) ? "dark" : "light";
  return out as CSSProperties;
}

/**
 * Apply a theme to <html> (the :root scope) so the overrides cleanly win
 * against the default values declared in styles.css :root. Also sets
 * `color-scheme` so native form controls (select menus, scrollbars,
 * checkboxes) render in the matching light/dark variant.
 *
 * In addition to the 8 base slots, we emit a 5-step lightness ramp for
 * each — `--keep-<slot>-100/200/300/400/500`. 300 is the user-picked
 * value; 100/200 are lighter, 400/500 darker. Ramps give components a
 * way to layer depth (panel-200 highlights, panel-400 shadow rims)
 * without the renderer having to hard-code alpha-blended approximations.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const slot of VAR_KEYS) {
    const base = theme[slot];
    root.style.setProperty(`--keep-${slot}`, hexToRgbTriple(base));
    const ramp = buildRamp(base);
    for (let i = 0; i < ramp.length; i++) {
      const step = (i + 1) * 100; // 100, 200, 300, 400, 500
      root.style.setProperty(`--keep-${slot}-${step}`, ramp[i]!);
    }
  }
  root.style.colorScheme = isDarkTheme(theme) ? "dark" : "light";
  document.body.setAttribute("data-theme-bg", theme.bg);
}

/* ============================================================
 * Font / size preferences (per-user accessibility)
 * ============================================================ */

/**
 * Discrete font-size tiers. Mapped to a px value applied as the document
 * font-size, which scales every rem-based Tailwind utility uniformly.
 * Kept as a closed set so the UI stays readable at every step — a
 * free-numeric scale would invite both microscopic and unusable
 * settings.
 */
export type UiFontScale = "small" | "medium" | "large" | "xl";

const FONT_SCALE_PX: Record<UiFontScale, number> = {
  small: 14,
  medium: 16,
  large: 18,
  xl: 20,
};

/**
 * Resolve a stored scale value to its px equivalent. Null / unknown
 * inputs collapse to 16px (medium / browser default), so a missing
 * preference leaves the document untouched.
 */
export function fontScalePx(scale: UiFontScale | null | undefined): number {
  if (scale && FONT_SCALE_PX[scale] !== undefined) return FONT_SCALE_PX[scale];
  return FONT_SCALE_PX.medium;
}

/**
 * Apply per-user font preferences to <html>:
 *   - `--keep-font-family`: free-form CSS font-family stack. Null clears
 *     the override so the document falls back to its base font stack
 *     declared in styles.css.
 *   - `font-size` on <html>: the document root size, which is what every
 *     rem-based Tailwind utility resolves against. Setting it scales the
 *     entire UI proportionally.
 *
 * Called at session load and whenever the user saves a new preference.
 * Independent of `applyTheme` because font preferences are user-level
 * (not character-level / room-level), so they don't follow the same
 * layering rules as the palette.
 */
export function applyFontPrefs(prefs: {
  fontFamily: string | null;
  fontScale: UiFontScale | null;
}): void {
  const root = document.documentElement;
  if (prefs.fontFamily && prefs.fontFamily.trim() !== "") {
    root.style.setProperty("--keep-font-family", prefs.fontFamily);
  } else {
    root.style.removeProperty("--keep-font-family");
  }
  root.style.fontSize = `${fontScalePx(prefs.fontScale)}px`;
}

/* ============================================================
 * Color ramp utilities
 * ============================================================ */

/**
 * Build a 5-step lightness ramp from a base hex. Returns RGB triples
 * (space-separated, Tailwind-compatible) ordered light → dark:
 *   [100, 200, 300, 400, 500] where 300 is the input.
 *
 * Lightness offsets are applied in HSL space so hue + saturation are
 * preserved. Offsets are symmetric so light bases compress on the
 * lighter end (clamped at 95%) and dark bases compress on the darker
 * end (clamped at 5%) — graceful at the extremes.
 *
 * Tuning rationale for the offsets:
 *   100/200: meaningful highlight steps (top bevel, hover lift)
 *   300:     the user-picked value, no shift
 *   400/500: meaningful shadow steps (sunken edges, drop shadows)
 * +/- 18% is broad enough to read as a distinct tier in the UI
 * without crossing into a perceptually different color.
 */
export function buildRamp(baseHex: string): string[] {
  const rgb = hexToRgb(baseHex);
  if (!rgb) return ["0 0 0", "0 0 0", "0 0 0", "0 0 0", "0 0 0"];
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const offsets = [+18, +9, 0, -9, -18];
  return offsets.map((d) => {
    const l = clamp(hsl.l + d, 5, 95);
    const out = hslToRgb(hsl.h, hsl.s, l);
    return `${out.r} ${out.g} ${out.b}`;
  });
}

/** Parse `#abc` / `#aabbcc` to `{ r, g, b }` in 0-255 range. Null on parse failure. */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** RGB (0-255) → HSL (h 0-360, s 0-100, l 0-100). Standard formula. */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)); break;
      case gn: h = ((bn - rn) / d + 2); break;
      case bn: h = ((rn - gn) / d + 4); break;
    }
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

/** HSL (h 0-360, s 0-100, l 0-100) → RGB (0-255 ints). Standard formula. */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hh = ((h % 360) + 360) % 360 / 360;
  const ss = s / 100, ll = l / 100;
  let r: number, g: number, b: number;
  if (ss === 0) { r = g = b = ll; }
  else {
    const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
    const p = 2 * ll - q;
    const hueToRgb = (p: number, q: number, t: number): number => {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };
    r = hueToRgb(p, q, hh + 1 / 3);
    g = hueToRgb(p, q, hh);
    b = hueToRgb(p, q, hh - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** "r g b" triple → "#rrggbb" hex. Used by ornament generators that want hex strings. */
export function rgbTripleToHex(triple: string): string {
  const [r, g, b] = triple.trim().split(/\s+/).map((s) => parseInt(s, 10));
  if (
    typeof r !== "number" || typeof g !== "number" || typeof b !== "number"
    || Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)
  ) return "#000000";
  const hex = (n: number) => clamp(n, 0, 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
