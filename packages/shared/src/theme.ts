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
 * Default theme — the "Spire Modern" palette adopted as the install
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
];

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
