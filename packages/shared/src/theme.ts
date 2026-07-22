/**
 * UI theme - a small palette applied via CSS variables. Each user (master)
 * and each character can pick their own. The chat itself uses the caller's
 * active theme; profile modals apply the OWNER's theme so each profile feels
 * like the user's "space" regardless of who's looking.
 */
export interface Theme {
  /** chat background */
  bg: string;
  /** banners, side rails, panels */
  panel: string;
  /** rule lines and borders */
  border: string;
  /** primary text color */
  text: string;
  /** muted / secondary text (timestamps, hints) */
  muted: string;
  /** highlights, links, active room name */
  action: string;
  /** strong call-to-action / exit / accent */
  accent: string;
  /** italic system messages */
  system: string;
}

/**
 * Default theme, the "Spire Modern" palette adopted as the install
 * default. Light neutral gray surfaces, near-black text, two-blue
 * accents (deeper indigo for primary actions, lighter steel-blue for
 * accent highlights), and a warm earth-tone system color. Picked to
 * read well under any of the three style families (medieval, modern,
 * scifi) without forcing a personality before the operator picks
 * one. Operators are free to repaint via /admin → Default Theme.
 */
export const DEFAULT_THEME: Theme = {
  bg: "#ebebeb",
  panel: "#d8d8d8",
  border: "#a3a3a3",
  text: "#1e1e1e",
  muted: "#666666",
  action: "#1e5fb8",
  accent: "#3574a2",
  system: "#7a5a1a",
};

export const THEME_PRESETS: ReadonlyArray<{ name: string; theme: Theme }> = [
  {
    // Original phpMyChat-inspired parchment palette. Inlined here
    // because `DEFAULT_THEME` is now the gray-blue install seed
    // rather than parchment; we still want operators to pick this
    // palette by name when they want the warm-paper look.
    name: "Parchment",
    theme: {
      bg: "#f4efe2",
      panel: "#e2d6b8",
      border: "#a89572",
      text: "#1a1a1a",
      muted: "#6b6256",
      action: "#2c5d2c",
      accent: "#8a1f1f",
      system: "#7a5a1a",
    },
  },
  {
    name: "Twilight",
    theme: {
      bg: "#1c1b29",
      panel: "#2a2840",
      border: "#4a4665",
      text: "#e6e3f2",
      muted: "#a8a3c4",
      action: "#9b85ff",
      accent: "#ff6b8a",
      system: "#ffd57a",
    },
  },
  {
    name: "Forest",
    theme: {
      bg: "#1f2820",
      panel: "#2c3a2c",
      border: "#4d6b4d",
      text: "#e8efe2",
      muted: "#a3b29b",
      action: "#a3d977",
      accent: "#e87a4e",
      system: "#f0c060",
    },
  },
  {
    name: "Ember",
    theme: {
      bg: "#241612",
      panel: "#3a221d",
      border: "#7a4434",
      text: "#f4e4d4",
      muted: "#c4a48e",
      action: "#ff9966",
      accent: "#ff5544",
      system: "#ffcc55",
    },
  },
  {
    name: "Ocean",
    theme: {
      bg: "#0f1d2b",
      panel: "#1a3147",
      border: "#3a5a78",
      text: "#e0eef8",
      muted: "#8aa8c0",
      action: "#5acef0",
      accent: "#ff7a9a",
      system: "#ffd060",
    },
  },
  {
    name: "Slate",
    theme: {
      bg: "#f5f5f5",
      panel: "#e5e5e5",
      border: "#a3a3a3",
      text: "#1e1e1e",
      muted: "#666666",
      action: "#1e5fb8",
      accent: "#b81e1e",
      system: "#7a5a1a",
    },
  },
  {
    // Default DARK companion to Parchment. Picked to read against the
    // original dark splash artwork (now the_spire_bg_classic_dark.jpg),
    // near-black bg/panel pulled from the artwork's deep blue-black sky,
    // a dark sky-blue system slot taken from the moonlit highlight on
    // the mountain ridge, a darker amber yellow accent matching the
    // dragon glyphs on the parchment overlay, and a spire-energy cyan
    // action color tying back to the magic circle's neon halo. The
    // splash adds a matching pair of corner glows (cyan top-left,
    // moon-white bottom-right) when this palette, or any palette whose
    // bg luminance reads as "dark", is active.
    name: "Darkness",
    theme: {
      bg: "#0a0e1a",
      panel: "#141828",
      border: "#2a3548",
      text: "#e8eaf2",
      muted: "#7e8a9e",
      action: "#3fa5a0",
      accent: "#d4a83a",
      system: "#5a8aa8",
    },
  },
  {
    // Glass Light, pairs with the "glass" design style. The visual
    // language is translucent frosted panels over the user's chosen
    // backdrop (or the light Spire artwork as fallback), so the
    // PALETTE here is restrained: near-white bg/panel so the frost
    // reads as pale crystal, soft cool border for inset bevels, deep
    // navy text for legibility through 50–60% transparency. Action +
    // accent stay vivid because they ride the panel's frost tint at
    // 0.6 alpha, desaturated picks would disappear into the glass.
    name: "Glass Light",
    theme: {
      bg: "#f7f8fb",
      panel: "#ffffff",
      border: "#c8d0dc",
      text: "#1a1f2e",
      muted: "#6a7286",
      action: "#2a72d1",
      accent: "#d147a3",
      system: "#b07e22",
    },
  },
  {
    // Glass Dark, the dark companion to Glass Light. Deep cool
    // navy/blue-gray surfaces over the dark Spire backdrop, with
    // saturated sky-blue + pink accents that punch through the
    // frosted darkening overlay. Reads as a high-end OS / settings
    // panel rather than a chatroom, professional, not playful.
    name: "Glass Dark",
    theme: {
      bg: "#0e1422",
      panel: "#1a2236",
      border: "#3a4760",
      text: "#e9eef7",
      muted: "#8e98ad",
      action: "#6cb0ff",
      accent: "#ff7ad1",
      system: "#ffc764",
    },
  },
  {
    // Keys the ORIGINAL painted splash artwork (the parchment map +
    // spire landscape, preserved as the_spire_bg_classic.*). Palette
    // sampled from that art: warm map-paper surfaces, sepia ink text,
    // a deep teal action pulled from the spire's magic-circle glow,
    // and a copper accent matching the map's ink linework. Selecting
    // this preset (unmodified) is what routes the splash + glass shell
    // to the classic background set, see isSpireClassicTheme.
    name: "Spire Classic Light",
    theme: {
      bg: "#f0e8d5",
      panel: "#e3d3ae",
      border: "#a68c63",
      text: "#241c10",
      muted: "#6f6350",
      action: "#1f6e6a",
      accent: "#96421c",
      system: "#7a5a1a",
    },
  },
  {
    // Dark companion, keyed to the original night artwork
    // (the_spire_bg_classic_dark.*): near-black warm-neutral surfaces
    // from the burnt-map side, teal action from the spire's glowing
    // sigil ring, copper accent from the etched map lines, and a
    // moonlit steel-blue system slot.
    name: "Spire Classic Dark",
    theme: {
      bg: "#0c0e12",
      panel: "#16191f",
      border: "#333840",
      text: "#e6e4dc",
      muted: "#8d8878",
      action: "#3fc2b8",
      accent: "#c9964b",
      system: "#7fa3b8",
    },
  },
];

/**
 * True when the palette is one of the "Spire Classic" presets
 * (unmodified). These presets exist to keep the ORIGINAL splash /
 * glass-shell artwork available after the commissioned character art
 * became the default: background pickers (splash classes, glass chat
 * shell) route to the `the_spire_bg_classic*` asset set for them and
 * the new `the_spire_bg*` set for everything else. Tweaking any slot
 * away from the preset drops back to the default art, same
 * exact-match philosophy as the per-preset design map.
 */
export function isSpireClassicTheme(theme: Theme): boolean {
  const name = matchThemePreset(theme);
  return name === "Spire Classic Light" || name === "Spire Classic Dark";
}

/**
 * Built-in pairings: when a user lands on a named preset and neither
 * they nor the admin's `themeDesignMap` have pinned a design, the
 * resolver falls through to this map before the site default. Lets
 * presets ship with a sensible "design intent" so the operator doesn't
 * have to wire `themeDesignMap` for every shipped preset.
 *
 * Only includes pairings that are strongly bound to the preset's
 * visual identity, Glass Light/Dark exist specifically to dress the
 * glass design, and the Spire Classic pair exists to show the original
 * splash artwork, which inside the chat shell is only visible through
 * the glass design's backdrop. The medieval/modern/scifi-friendly
 * presets (Parchment, Twilight, etc.) stay unmapped so the admin or
 * user picks what fits.
 */
export const DEFAULT_PRESET_DESIGNS: Readonly<Record<string, string>> = {
  "Glass Light": "glass",
  "Glass Dark": "glass",
  "Spire Classic Light": "glass",
  "Spire Classic Dark": "glass",
};

/**
 * Return true when a palette's background reads as "dark" (relative
 * luminance below 0.18 ≈ "the splash card needs the dark variant of
 * its image"). Used by the splash + boot screens to decide which
 * background asset to load and whether to layer the cyan/moon corner
 * glows on top. Reuses the WCAG luminance math the contrast walker
 * below already implements.
 *
 * 0.18 is empirical: Parchment's bg (#f4efe2) reads ~0.91, Ember's
 * (#241612) reads ~0.013, Slate's (#f5f5f5) reads ~0.91, Darkness's
 * (#0a0e1a) reads ~0.005. The threshold lands between Slate (light)
 * and Twilight's bg #1c1b29 (~0.012, dark). Safe over a wide range
 * of custom palettes.
 */
export function isDarkPalette(theme: Theme): boolean {
  const rgb = parseHexColor(theme.bg);
  if (!rgb) return false;
  return relativeLuminance(rgb) < 0.18;
}

/**
 * Match a runtime palette to a named preset by exact slot-by-slot
 * comparison. Returns the preset name (e.g. "Twilight") or null if the
 * palette has been customized away from any seeded preset.
 *
 * Used by the style resolver: when the user's active palette equals a
 * preset, the per-preset design map in admin settings pins a default
 * design (medieval/modern/scifi) to it. Customized palettes fall
 * through to the site-wide default style instead, there's no preset
 * name to look up.
 *
 * Comparison is case-insensitive on hex values so `#FFAA00` and
 * `#ffaa00` aren't treated as different palettes; everything else is
 * a strict equal.
 */
export function matchThemePreset(theme: Theme): string | null {
  const norm = (h: string) => h.toLowerCase();
  for (const preset of THEME_PRESETS) {
    if (
      norm(preset.theme.bg) === norm(theme.bg) &&
      norm(preset.theme.panel) === norm(theme.panel) &&
      norm(preset.theme.border) === norm(theme.border) &&
      norm(preset.theme.text) === norm(theme.text) &&
      norm(preset.theme.muted) === norm(theme.muted) &&
      norm(preset.theme.action) === norm(theme.action) &&
      norm(preset.theme.accent) === norm(theme.accent) &&
      norm(preset.theme.system) === norm(theme.system)
    ) {
      return preset.name;
    }
  }
  return null;
}

/**
 * Theme color "slots" that a custom-command author can target instead
 * of a literal hex. Stored on a message as `theme:<slot>` and
 * resolved at render time to whatever the VIEWER's theme defines as
 * that slot. This way a "Looks like a system message" command keeps
 * the right visual identity for every reader, regardless of their
 * personal theme.
 *
 * Only the text-tone slots are exposed, `bg`, `panel`, `border` are
 * structural and would render as invisible-on-itself text.
 */
export const THEMEABLE_TEXT_SLOTS = ["system", "action", "accent", "muted", "text"] as const;
export type ThemeableTextSlot = (typeof THEMEABLE_TEXT_SLOTS)[number];

/** Matches a stored color token like `theme:system`. */
const THEME_COLOR_TOKEN_RE = /^theme:([a-z]+)$/;

/**
 * Pattern admin endpoints use to validate a custom-command color
 * coming in over the wire. Accepts a `#rrggbb` literal OR a
 * `theme:<slot>` token referencing one of {@link THEMEABLE_TEXT_SLOTS}.
 */
export const COLOR_TOKEN_OR_HEX_RE = new RegExp(
  `^(?:#[0-9a-fA-F]{6}|theme:(?:${THEMEABLE_TEXT_SLOTS.join("|")}))$`,
);

/**
 * Resolve a stored message color to a CSS color value the client can
 * drop into `style={{ color: ... }}`. Returns:
 *   - `undefined` for null/empty (the renderer falls back to default)
 *   - `rgb(var(--keep-<slot>))` for `theme:<slot>` tokens, so the
 *     viewer's theme palette drives the value
 *   - a hex color for literal hex inputs, optionally adjusted for
 *     legibility against the viewer's theme background
 *   - the literal string unchanged for anything else
 *
 * The CSS-variable form depends on the web app exposing each theme
 * slot as `--keep-<slot>` in the format `R G B` (space-separated rgb
 * channels). The Vite app already does this, see `lib/theme.ts`'s
 * `applyTheme` which sets each slot via `setProperty`.
 *
 * `themeBg` (optional) is the viewer's current theme background hex.
 * When supplied, literal hex colors that don't meet WCAG 4.5:1 contrast
 * against it are nudged toward legibility (lightened on dark bgs,
 * darkened on light bgs) while preserving hue and saturation. Theme
 * tokens are left alone, those already resolve to palette-tuned values
 * the operator picked for that theme.
 */
export function resolveMessageColor(
  raw: string | null | undefined,
  themeBg?: string | null,
): string | undefined {
  if (!raw) return undefined;
  const m = THEME_COLOR_TOKEN_RE.exec(raw);
  if (m && (THEMEABLE_TEXT_SLOTS as readonly string[]).includes(m[1]!)) {
    return `rgb(var(--keep-${m[1]}))`;
  }
  if (themeBg && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(raw)) {
    return legibleAgainstBg(raw, themeBg);
  }
  return raw;
}

/* ============================================================
 * Contrast utilities
 * ============================================================ */

/** WCAG normal-text minimum. Anything below this is considered illegible. */
const CONTRAST_TARGET = 4.5;

/**
 * Return `color` unchanged when it already meets {@link CONTRAST_TARGET}
 * contrast against `bgHex`. Otherwise return a hue/saturation-preserving
 * lightness-shifted variant, pushed lighter for dark backgrounds,
 * darker for light ones, until it crosses the target or hits the
 * 0/100 lightness ceiling. Falls back to the input if either argument
 * isn't a parseable hex (we don't want to mangle CSS literals like
 * `rgb(...)` or palette tokens).
 *
 * Used so a player who picks, say, deep navy looks correct on a light
 * theme but stays readable when another viewer (or that same player)
 * switches to a dark theme, the saved color stays untouched, only the
 * rendered value adapts to the current background.
 */
export function legibleAgainstBg(color: string, bgHex: string, targetContrast: number = CONTRAST_TARGET): string {
  const fg = parseHexColor(color);
  const bg = parseHexColor(bgHex);
  if (!fg || !bg) return color;
  if (contrastRatio(fg, bg) >= targetContrast) return color;
  const bgLum = relativeLuminance(bg);
  const goingLighter = bgLum < 0.5;
  const hsl = rgbToHsl(fg);
  // Walk lightness in 4% steps toward the legible end. Cap at 95 / 5
  // so we don't bottom out at pure white / black, which kills the hue.
  const step = goingLighter ? 4 : -4;
  let l = hsl.l;
  for (let i = 0; i < 25; i++) {
    l += step;
    if (l <= 5 || l >= 95) { l = goingLighter ? 95 : 5; }
    const candidate = hslToRgb({ h: hsl.h, s: hsl.s, l });
    if (contrastRatio(candidate, bg) >= targetContrast) return rgbToHex(candidate);
    if (l <= 5 || l >= 95) return rgbToHex(candidate);
  }
  return rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l }));
}

/**
 * Return a copy of the theme with every FOREGROUND slot nudged for
 * readability against `bg` via {@link legibleAgainstBg}.
 *
 *   - `text`    , WCAG AA body-text floor (4.5:1)
 *   - `muted`   , large/secondary-text floor (3:1), kept softer than
 *                  text so the muted character is preserved
 *   - `action`  , button labels / links / active-room name. Drives
 *                  the `text-keep-action` everywhere in the app, so
 *                  it needs the same 3:1 floor that button labels do
 *   - `accent`  , exit / strong CTA color, also rendered as text on
 *                  warning chips. 3:1.
 *   - `system`  , italic system-message text. 3:1.
 *   - `border`  , rule lines. Doesn't need WCAG-level contrast but
 *                  a 1.5:1 floor keeps the dividers from melting into
 *                  the panel on near-monochrome themes
 *
 * The `panel` slot is left at the user's pick, it's a surface, not
 * a foreground, and its contrast story is "looks distinct from bg"
 * rather than "readable against bg." `bg` is the reference point we
 * measure everything else against, so it can't sensibly nudge itself.
 *
 * Applied at theme-application time (both `themeStyle` for scoped
 * subtrees and `applyTheme` for the document root). The hex stored
 * in the DB is unchanged; only the rendered RGB triple shifts when
 * a slot fails its target. Original picks are preserved verbatim if
 * they already meet the floor.
 *
 * Important for cross-theme profile viewing: the function nudges
 * against the OWNER's `bg`, which assumes the rendered surface is
 * fully opaque. Callers that paint the owner palette onto a
 * translucent card (where the viewer's theme bleeds through) must
 * either tighten the surface alpha or pass an effective bg color
 *, otherwise the contrast guarantee here is computed against a
 * surface color the user never actually sees.
 */
export function legibleThemePalette(theme: Theme): Theme {
  return {
    ...theme,
    text:   legibleAgainstBg(theme.text,   theme.bg, 4.5),
    muted:  legibleAgainstBg(theme.muted,  theme.bg, 3.0),
    action: legibleAgainstBg(theme.action, theme.bg, 3.0),
    accent: legibleAgainstBg(theme.accent, theme.bg, 3.0),
    system: legibleAgainstBg(theme.system, theme.bg, 3.0),
    border: legibleAgainstBg(theme.border, theme.bg, 1.5),
  };
}

interface Rgb { r: number; g: number; b: number; }
interface Hsl { h: number; s: number; l: number; }

function parseHexColor(hex: string): Rgb | null {
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

function relativeLuminance({ r, g, b }: Rgb): number {
  // WCAG sRGB luminance: linearize each channel then weight per CIE.
  const toLin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
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

function hslToRgb({ h, s, l }: Hsl): Rgb {
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

function rgbToHex({ r, g, b }: Rgb): string {
  const toHex = (n: number) => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Tolerant of partial/legacy data - anything missing falls back to default. */
export function normalizeTheme(input: unknown): Theme {
  if (!input || typeof input !== "object") return DEFAULT_THEME;
  const o = input as Partial<Theme>;
  return {
    bg: typeof o.bg === "string" ? o.bg : DEFAULT_THEME.bg,
    panel: typeof o.panel === "string" ? o.panel : DEFAULT_THEME.panel,
    border: typeof o.border === "string" ? o.border : DEFAULT_THEME.border,
    text: typeof o.text === "string" ? o.text : DEFAULT_THEME.text,
    muted: typeof o.muted === "string" ? o.muted : DEFAULT_THEME.muted,
    action: typeof o.action === "string" ? o.action : DEFAULT_THEME.action,
    accent: typeof o.accent === "string" ? o.accent : DEFAULT_THEME.accent,
    system: typeof o.system === "string" ? o.system : DEFAULT_THEME.system,
  };
}
