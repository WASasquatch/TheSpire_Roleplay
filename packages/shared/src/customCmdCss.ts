/**
 * Allow-list-based CSS sanitizer for custom-command styling. Admins
 * provide a small declaration list ("font-weight: bold; color: #4a8")
 * that gets stored on the command row and snapshotted onto each
 * message emitted by it; the renderer then parses + applies it as an
 * inline `style` on the body. Unknown properties or values that don't
 * match the per-property regex are silently dropped so a stray `url(…)`
 * or `position: fixed` can't break out of the chat layout.
 *
 * The allow-list mirrors (and is a subset of) the `allowedStyles` used
 * by `sanitizeBio` in apps/server/src/auth/html.ts. Layout / sizing
 * properties (`position`, `width`, `margin`, etc.) are deliberately
 * absent — a custom command paints text, not chrome.
 */
import { legibleAgainstBg } from "./theme.js";

const HEX_OR_RGB = [
  /^#(?:[0-9a-fA-F]{3}){1,2}$/,
  /^rgb\([\s\d,.%]+\)$/,
  /^rgba\([\s\d,.%]+\)$/,
];

/**
 * Property → allowed-value patterns. A value must match at least one
 * pattern (or the unconditional matcher returning `true`) to survive.
 * Single source of truth for both validation on the server and the
 * camelCase translation on the client.
 */
export const CUSTOM_CMD_ALLOWED_STYLES: Record<string, RegExp[]> = {
  color: HEX_OR_RGB,
  "background-color": HEX_OR_RGB,
  "font-weight": [/^(?:bold|normal|lighter|bolder|[1-9]00)$/],
  "font-style": [/^(?:italic|normal|oblique)$/],
  "font-family": [/^[\w\s"',\-]{1,200}$/],
  "font-size": [
    /^(?:[1-9]|[1-6]\d|7[0-2])px$/,
    /^(?:0\.[5-9]|[1-3](?:\.\d+)?|4)em$/,
    /^(?:[5-9]\d|[1-3]\d{2}|400)%$/,
    /^(?:xx-small|x-small|small|medium|large|x-large|xx-large)$/,
  ],
  "line-height": [/^(?:0?\.\d+|[1-3](?:\.\d+)?)$/, /^(?:1[0-9]|[2-6]\d)px$/],
  "text-decoration": [/^(?:underline|line-through|overline|none)$/],
  "text-align": [/^(?:left|right|center|justify)$/],
  "text-transform": [/^(?:none|uppercase|lowercase|capitalize)$/],
  "text-shadow": [/^[\s\w#().,%-]{1,80}$/],
  "letter-spacing": [/^-?(?:0?\.\d+|[0-3](?:\.\d+)?)(?:em|px)$/],
  "font-variant": [/^(?:normal|small-caps)$/],
  opacity: [/^(?:0|1|0?\.\d+)$/],
};

/**
 * Hard cap on the raw input length so an admin can't paste a 10KB style
 * block. Generous enough for any reasonable per-command palette.
 */
export const CUSTOM_CMD_CSS_MAX_LEN = 600;

/**
 * Parse a CSS declaration list, drop any property/value the allow-list
 * doesn't recognize, and return a canonicalized `prop: value; …` string.
 * Empty (or fully-invalid) input returns `""`. Always safe to inline
 * into a `style="…"` attribute; the renderer further reparses it into
 * a React style object before applying.
 */
export function sanitizeCustomCmdCss(input: string | null | undefined): string {
  if (!input) return "";
  const trimmed = input.trim().slice(0, CUSTOM_CMD_CSS_MAX_LEN);
  if (!trimmed) return "";
  const declarations = trimmed.split(/;+/);
  const out: string[] = [];
  for (const decl of declarations) {
    const colon = decl.indexOf(":");
    if (colon <= 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (!prop || !value) continue;
    const patterns = CUSTOM_CMD_ALLOWED_STYLES[prop];
    if (!patterns) continue;
    if (!patterns.some((re) => re.test(value))) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join("; ");
}

/**
 * Parse a sanitized CSS string into the camelCased object shape React's
 * `style` prop expects. Caller is responsible for passing a string that
 * already went through {@link sanitizeCustomCmdCss}; this helper does
 * NOT re-validate property names. Returns null on empty input so the
 * renderer can skip the `style={…}` prop entirely instead of attaching
 * an empty object.
 *
 * `themeBg` (optional) is the viewer's current theme background hex.
 * When supplied, any `color: #hex` declaration is run through
 * `legibleAgainstBg` so an admin-picked color that would disappear on
 * the reader's current palette gets nudged toward a legible variant
 * (same contract that drives the per-user chat-color override). If the
 * CSS itself sets `background-color`, that bg wins over the theme bg
 * — an admin who explicitly paints a background is taking ownership of
 * the contrast model for that combo.
 *
 * Only `color` is nudged. `background-color` is left verbatim because
 * the admin chose it as the canvas; rewriting it would defeat the
 * purpose of styling the body. Non-hex values (rgb / rgba) also pass
 * through unchanged — the legibility helper is hex-only.
 */
export function customCmdCssToStyle(
  css: string | null | undefined,
  themeBg?: string | null,
): Record<string, string> | null {
  if (!css) return null;
  // First pass: parse declarations into a kebab-keyed map so we can
  // see whether `background-color` is set before we decide the color
  // nudge's reference background.
  const raw: Record<string, string> = {};
  for (const decl of css.split(/;+/)) {
    const colon = decl.indexOf(":");
    if (colon <= 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (!prop || !value) continue;
    raw[prop] = value;
  }
  const effectiveBg = raw["background-color"] || themeBg || null;
  const out: Record<string, string> = {};
  for (const [prop, value] of Object.entries(raw)) {
    let v = value;
    if (prop === "color" && effectiveBg && /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(value)) {
      v = legibleAgainstBg(value, effectiveBg);
    }
    const camel = prop.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    out[camel] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}
