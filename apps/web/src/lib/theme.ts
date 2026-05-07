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
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const slot of VAR_KEYS) {
    root.style.setProperty(`--keep-${slot}`, hexToRgbTriple(theme[slot]));
  }
  root.style.colorScheme = isDarkTheme(theme) ? "dark" : "light";
  document.body.setAttribute("data-theme-bg", theme.bg);
}
