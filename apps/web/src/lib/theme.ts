import { createContext, useContext, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { DEFAULT_THEME, isDarkPalette, legibleThemePalette, THEME_PRESETS, type Theme } from "@thekeep/shared";
import { applyStyle } from "./ornaments/index.js";
import { loadCachedActiveTheme, type SiteBranding } from "../state/store.js";

/**
 * Read access to the currently-active theme, the same value `applyTheme`
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
 * GLOBAL ink-vs-surface mechanic: decide whether a surface reads as
 * dark, so callers can flip text light/dark instead of trusting theme
 * classes that assume a particular background.
 *
 *   - `imageOverlay: true` → the surface is one of our image banners,
 *     which always paint a dark gradient scrim over the art — the
 *     surface is dark BY CONSTRUCTION, whatever the image or theme.
 *   - otherwise → sample the palette (WCAG relative luminance via
 *     isDarkPalette) of whatever theme paints that surface.
 *
 * Pair with {@link inkClass} for the standard class strings.
 */
export function isDarkSurface(theme: Theme, opts?: { imageOverlay?: boolean }): boolean {
  if (opts?.imageOverlay) return true;
  return isDarkPalette(theme);
}

/** Standard legible-ink classes for a sampled surface. */
export const inkClass = {
  /** Headline ink. */
  title: (dark: boolean) => (dark ? "text-white drop-shadow-[0_1px_3px_rgba(0,0,0,.9)]" : "text-keep-text"),
  /** Secondary line ink. */
  sub: (dark: boolean) => (dark ? "text-white/80 drop-shadow" : "text-keep-muted"),
  /** Meta/caption ink. */
  meta: (dark: boolean) => (dark ? "text-white/70" : "text-keep-muted"),
  /** Emphasized inline ink inside meta. */
  strong: (dark: boolean) => (dark ? "text-white" : "text-keep-text"),
} as const;

/**
 * ROOT-level design override for forum surfaces (the Forums Catalog
 * modal and the public /f/ landing — both cover the viewport).
 *
 * A DESIGN cannot be subtree-scoped the way a palette can: design CSS
 * keys off `html[data-theme-style=…]`, and an ancestor design (e.g. the
 * viewer's glass) keeps matching INSIDE any card that declares its own
 * attribute — glass translucency bleeding through a medieval forum was
 * exactly that. So while a forum that has CHOSEN a design style is on
 * screen, we swap the root design to it (ornaments regenerated from the
 * forum's palette) and restore the viewer's design on the way out.
 *
 * Forums with NO chosen style leave the viewer's design untouched —
 * the user's own preferences fill the gaps, never override a choice.
 */
export function useScopedRootDesign(
  /** Palette the ornaments should be generated from (forum theme,
   *  falling back to the viewer's active palette). */
  theme: Theme,
  /** The forum's chosen design key; null/undefined = no override. */
  styleKey: string | null | undefined,
  /** Gate: only swap once the forum detail has actually loaded. */
  enabled: boolean,
  /** Viewer's root palette, used to regenerate THEIR ornaments on restore. */
  restoreTheme: Theme,
): void {
  // Latest restore palette without retriggering the swap effect.
  const restoreRef = useRef(restoreTheme);
  restoreRef.current = restoreTheme;
  useEffect(() => {
    if (!enabled || !styleKey) return;
    const root = document.documentElement;
    const prevKey = root.getAttribute("data-theme-style");
    applyStyle(theme, styleKey);
    return () => {
      applyStyle(restoreRef.current, prevKey);
    };
  }, [theme, styleKey, enabled]);
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
 *   1. User's last-active theme, cached in localStorage after
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
  // matchMedia is undefined in SSR / non-DOM environments, defensive
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
  const legible = legibleThemePalette(theme);
  const out: Record<string, string> = {};
  for (const slot of VAR_KEYS) {
    const base = legible[slot];
    out[`--keep-${slot}`] = hexToRgbTriple(base);
    // Emit the same 5-step ramp `applyTheme` writes at :root. Without
    // these, a subtree that swaps in a different theme (a profile or
    // world modal showing the owner's palette) inherits the viewer's
    // ramps, so rules like `[data-theme-style="scifi"] body` that
    // reference `--keep-bg-500` resolve to the wrong color and the
    // owner's glass / neon effects don't read correctly.
    const ramp = buildRamp(base);
    for (let i = 0; i < ramp.length; i++) {
      const step = (i + 1) * 100;
      out[`--keep-${slot}-${step}`] = ramp[i]!;
    }
  }
  out["--keep-action-neon"] = buildNeon(theme.action);
  out["--keep-accent-neon"] = buildNeon(theme.accent);
  Object.assign(out, themeUserVars(theme, legible));
  out.colorScheme = isDarkTheme(theme) ? "dark" : "light";
  return out as CSSProperties;
}

/**
 * User-facing `--theme-*` aliases. Same palette as the internal
 * `--keep-*` slots, but emitted as ready-to-use `rgb(r g b)` strings
 *, writers styling their profile bio with custom CSS can drop
 * `color: var(--theme-accent)` straight into their stylesheet without
 * having to wrap with `rgb()` themselves. The `*-rgb` companion vars
 * hold the raw triple ("r g b") so the same writer can do
 * `rgb(var(--theme-accent-rgb) / 0.5)` for alpha composition. Neon
 * variants (the scifi glow derivations) are exposed too so theming
 * matches whatever palette the owner picked.
 *
 * Names are stable user contract, any rename ripples through every
 * user's saved CSS, so treat this list as additive only.
 */
function themeUserVars(theme: Theme, legible: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slot of VAR_KEYS) {
    const triple = hexToRgbTriple(legible[slot]);
    out[`--theme-${slot}-rgb`] = triple;
    out[`--theme-${slot}`] = `rgb(${triple.replace(/\s+/g, " ")})`;
  }
  const actionNeon = buildNeon(theme.action);
  const accentNeon = buildNeon(theme.accent);
  out["--theme-action-neon-rgb"] = actionNeon;
  out["--theme-action-neon"] = `rgb(${actionNeon})`;
  out["--theme-accent-neon-rgb"] = accentNeon;
  out["--theme-accent-neon"] = `rgb(${accentNeon})`;
  return out;
}

/**
 * Apply a theme to <html> (the :root scope) so the overrides cleanly win
 * against the default values declared in styles.css :root. Also sets
 * `color-scheme` so native form controls (select menus, scrollbars,
 * checkboxes) render in the matching light/dark variant.
 *
 * In addition to the 8 base slots, we emit a 5-step lightness ramp for
 * each, `--keep-<slot>-100/200/300/400/500`. 300 is the user-picked
 * value; 100/200 are lighter, 400/500 darker. Ramps give components a
 * way to layer depth (panel-200 highlights, panel-400 shadow rims)
 * without the renderer having to hard-code alpha-blended approximations.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  // Nudge text + muted for legibility against bg, same guarantee as
  // themeStyle. A user who picks a theme with muted-on-muted contrast
  // (or who later darkens their bg until the existing muted disappears
  // into it) still gets readable body copy; the saved hex doesn't
  // change, only the rendered RGB triple shifts.
  const legible = legibleThemePalette(theme);
  for (const slot of VAR_KEYS) {
    const base = legible[slot];
    root.style.setProperty(`--keep-${slot}`, hexToRgbTriple(base));
    const ramp = buildRamp(base);
    for (let i = 0; i < ramp.length; i++) {
      const step = (i + 1) * 100; // 100, 200, 300, 400, 500
      root.style.setProperty(`--keep-${slot}-${step}`, ramp[i]!);
    }
  }
  // Derived neon variants for glow/halo treatments. Same hue as the
  // user's picked action / accent, but normalized to full saturation +
  // mid-dark luminance, read as rich saturated neons regardless of
  // whether the user picked a washed-out pastel or a near-black accent.
  // Consumed by the scifi theme's tube-light rules; harmless on
  // medieval/modern (they don't reference these vars). Built from the
  // ORIGINAL action/accent (not the legibility-nudged copy) since the
  // neon recipe normalizes saturation/luminance from scratch.
  root.style.setProperty("--keep-action-neon", buildNeon(theme.action));
  root.style.setProperty("--keep-accent-neon", buildNeon(theme.accent));
  // Mirror the user-facing `--theme-*` aliases that `themeStyle`
  // emits on subtree elements, so any CSS, site chrome, admin
  // surfaces, user-authored bios that escape their scope, can
  // reference `var(--theme-accent)` from the document root.
  for (const [k, v] of Object.entries(themeUserVars(theme, legible))) {
    root.style.setProperty(k, v);
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
 * Kept as a closed set so the UI stays readable at every step, a
 * free-numeric scale would invite both microscopic and unusable
 * settings.
 *
 * Each tier carries TWO values: desktop and mobile. Mobile devices
 * render text relatively larger than desktop at the same px size
 * (smaller physical screen, closer reading distance, OS-level system
 * scaling on most phones), so the chat shell drops every tier by 2px
 * on small viewports. A user who picked "medium" still has the same
 * relative size step they'd expect; the absolute px just reflects
 * the device class.
 */
export type UiFontScale = "small" | "medium" | "large" | "xl";

const FONT_SCALE_PX: Record<UiFontScale, { desktop: number; mobile: number }> = {
  // Mobile tiers run ~2px below desktop across the board. The
  // previous mobile floor (12px on "small") read as oversized
  // chrome on actual phones, every utility chip, sidebar label,
  // and timestamp ate more vertical space than a one-handed
  // viewport could afford. Pulling each tier down one notch lets
  // "small" land at a genuinely-compact 10px, "medium" at the
  // OS-default 13px, and the upper tiers stay readable for users
  // who explicitly need more.
  small:  { desktop: 14, mobile: 10 },
  medium: { desktop: 16, mobile: 13 },
  large:  { desktop: 18, mobile: 15 },
  xl:     { desktop: 20, mobile: 17 },
};

/** CSS media query that flags a viewport as "mobile" for font-scale
 *  purposes. 767px == one pixel below Tailwind's `md` breakpoint
 *  (768px), so phones in portrait and small tablets get the mobile
 *  scale; landscape phones, larger tablets, and every desktop fall to
 *  the desktop tiers. */
const MOBILE_FONT_MQ = "(max-width: 767px)";

/**
 * Resolve a stored scale value to its px equivalent. Null / unknown
 * inputs collapse to the medium tier so a missing preference leaves
 * the document untouched.
 *
 * Pass `isMobile` to pick the mobile-scaled value for the same tier;
 * default to the desktop value when the flag is unknown (callers that
 * don't yet observe viewport state still get a sensible answer).
 */
export function fontScalePx(scale: UiFontScale | null | undefined, isMobile = false): number {
  const tier = scale && FONT_SCALE_PX[scale] ? FONT_SCALE_PX[scale] : FONT_SCALE_PX.medium;
  return isMobile ? tier.mobile : tier.desktop;
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
}): () => void {
  const root = document.documentElement;
  if (prefs.fontFamily && prefs.fontFamily.trim() !== "") {
    root.style.setProperty("--keep-font-family", prefs.fontFamily);
  } else {
    root.style.removeProperty("--keep-font-family");
  }
  // Viewport-aware base font size. Mobile devices oversample text
  // relative to desktop at the same px, so the mobile tier values
  // are 2px below their desktop counterparts. We listen for viewport
  // changes via matchMedia so resizing the window (or rotating a
  // tablet) re-applies the right tier without a reload.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    // SSR / non-DOM environment, apply the desktop fallback once
    // and return a no-op cleanup so callers can still treat the
    // return value uniformly.
    root.style.fontSize = `${fontScalePx(prefs.fontScale, false)}px`;
    return () => {};
  }
  const mq = window.matchMedia(MOBILE_FONT_MQ);
  function apply(): void {
    root.style.fontSize = `${fontScalePx(prefs.fontScale, mq.matches)}px`;
  }
  apply();
  mq.addEventListener("change", apply);
  return () => mq.removeEventListener("change", apply);
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
 * end (clamped at 5%), graceful at the extremes.
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
 * Both are CEILINGS, never floors, picking a muted slate or a deep
 * burgundy leaves those characteristics intact. The clamp only fires
 * for picks that would otherwise bleach to near-white when blurred
 * (saturated accent #ff6b8a → muted dusty pink ≈ #c46a7e), giving the
 * "soft pastel" tone the design calls for without the user having to
 * pick a soft pastel themselves.
 *
 * Returns "r g b" (space-separated, Tailwind-compatible). Falls back
 * to "0 0 0" on parse failure, same posture as the other helpers.
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
