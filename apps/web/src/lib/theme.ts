import { createContext, useContext } from "react";
import type { CSSProperties } from "react";
import { DEFAULT_THEME, isDarkPalette, THEME_PRESETS, type Theme } from "@thekeep/shared";
import { loadCachedActiveTheme, type SiteBranding } from "../state/store.js";

/**
 * Read access to the currently-active theme — the same value `applyTheme`
 * pushed into CSS variables on `<html>`. Components consume this when
 * they need to make a runtime decision based on the palette (e.g.
 * choosing a legible variant of a user-picked color against the current
 * background). The CSS-var path is enough for most styling; the context
 * exists for code that has to inspect colors imperatively.
 *
 * Default to {@link DEFAULT_THEME} so tests and any consumer mounted
 * outside the provider get sane values instead of nullish guards.
 */
export const ActiveThemeContext = createContext<Theme>(DEFAULT_THEME);

export function useActiveTheme(): Theme {
  return useContext(ActiveThemeContext);
}

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
 * Pick the splash's effective palette. Priority chain (highest wins):
 *
 *   1. User's last-active theme — cached in localStorage after
 *      authentication. A brief sign-out shouldn't bounce a Darkness
 *      user through a flash of Parchment splash.
 *   2. System `prefers-color-scheme: dark` → built-in Darkness preset.
 *   3. Fallback → built-in Parchment preset.
 *
 * Note we intentionally do NOT use `branding.defaultTheme` here. The
 * admin default theme governs the authenticated chat fallback (for
 * users without a personal theme); the splash is anonymous chrome
 * that should auto-match the visitor's system preference so a
 * dark-mode visitor doesn't land on a blinding light splash. Admins
 * who want a uniformly themed brand will see their pick on the chat
 * shell once a user signs in.
 *
 * Pure function (modulo `localStorage` + `window.matchMedia`); safe to
 * call from inline `style={themeStyle(...)}` on each splash render.
 *
 * Accepts SiteBranding for backwards compatibility with callers, even
 * though no field is currently read from it. Keeping the param so the
 * signature stays stable if we re-introduce admin overrides later.
 */
export function resolveSplashTheme(_branding: SiteBranding): Theme {
  const cached = loadCachedActiveTheme();
  if (cached) return cached;
  // matchMedia is undefined in SSR / non-DOM environments — defensive
  // for tests; the splash only runs in a browser in practice.
  const systemDark =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const presetName = systemDark ? "Darkness" : "Parchment";
  const preset = THEME_PRESETS.find((p) => p.name === presetName);
  return preset ? preset.theme : DEFAULT_THEME;
}

/** Path for the splash background image, dark / light variant chosen
 *  by the resolved splash palette. The dark variant is bundled at
 *  /the_spire_bg_dark.jpg (added 2026-05). */
export function splashBgUrl(theme: Theme): string {
  return isDarkPalette(theme) ? "/the_spire_bg_dark.jpg" : "/the_spire_bg.jpg";
}

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
  // Derived neon variants — same hue as the user's pick, but normalized
  // to full saturation + mid-dark luminance so glow/halo treatments in
  // styles like scifi read as a rich saturated neon instead of a
  // washed-out near-white. See `buildNeon` for the recipe.
  out["--keep-action-neon"] = buildNeon(theme.action);
  out["--keep-accent-neon"] = buildNeon(theme.accent);
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
  // Derived neon variants for glow/halo treatments. Same hue as the
  // user's picked action / accent, but normalized to full saturation +
  // mid-dark luminance — read as rich saturated neons regardless of
  // whether the user picked a washed-out pastel or a near-black accent.
  // Consumed by the scifi theme's tube-light rules; harmless on
  // medieval/modern (they don't reference these vars).
  root.style.setProperty("--keep-action-neon", buildNeon(theme.action));
  root.style.setProperty("--keep-accent-neon", buildNeon(theme.accent));
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
/**
 * Derive a "neon" RGB triple from a base hex. Preserves the user's hue
 * but clamps both saturation and lightness toward a muted dusty-pastel
 * band so scifi glow treatments don't read as a hot signage tube
 * regardless of how vivid the user's pick is.
 *
 *   saturation → clamped to a 55% ceiling (anything above gets dropped
 *                to 55%; lower-sat picks pass through unchanged)
 *   lightness  → clamped to a 55% ceiling (already-darker picks pass
 *                through; brighter picks get pulled to the mid-tone)
 *
 * Both are CEILINGS, never floors — picking a muted slate or a deep
 * burgundy leaves those characteristics intact. The clamp only fires
 * for picks that would otherwise bleach to near-white when blurred
 * (saturated accent #ff6b8a → muted dusty pink ≈ #c46a7e), giving the
 * "soft pastel" tone the design calls for without the user having to
 * pick a soft pastel themselves.
 *
 * Returns "r g b" (space-separated, Tailwind-compatible). Falls back
 * to "0 0 0" on parse failure — same posture as the other helpers.
 */
export function buildNeon(baseHex: string): string {
  const rgb = hexToRgb(baseHex);
  if (!rgb) return "0 0 0";
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const s = Math.min(hsl.s, 55);
  const l = Math.min(hsl.l, 55);
  const out = hslToRgb(hsl.h, s, l);
  return `${out.r} ${out.g} ${out.b}`;
}

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
