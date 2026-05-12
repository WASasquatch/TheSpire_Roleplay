import type { Config } from "tailwindcss";

/**
 * Colors flow through CSS variables so a single theme can be applied at the
 * document level (caller's theme) or scoped to a subtree (e.g. a profile
 * modal showing the OWNER's theme).
 *
 * Each `--keep-*` variable is a *space-separated RGB triple* (e.g. "226 214 184")
 * — NOT a hex value — because that's the format Tailwind needs for the
 * opacity modifier to compose. With this setup `bg-keep-panel/30` resolves to
 * `rgb(226 214 184 / 0.3)`. The hex→RGB conversion happens in lib/theme.ts.
 *
 * Legacy aliases (parchment/banner/rule) map onto the canonical slots so
 * older class names still work without a sweeping rename.
 */
const c = (name: string) => `rgb(var(--keep-${name}) / <alpha-value>)`;

/**
 * Ramp helper — emits the 5-step lightness ramp Tailwind tokens for a
 * slot. e.g. `ramp("panel")` returns `{ 100: ..., 200: ..., 300: ...,
 * 400: ..., 500: ..., DEFAULT: ... }` so callers can use both
 * `bg-keep-panel` (the user-picked value, == 300) AND
 * `bg-keep-panel-200` (one tier lighter, for highlights), `bg-keep-panel-400`
 * (one tier darker, for shadow rims), etc.
 *
 * The CSS vars driving these (`--keep-<slot>-100` ... `--keep-<slot>-500`)
 * are set by `applyTheme` in lib/theme.ts using HSL lightness offsets.
 */
const ramp = (name: string): Record<string, string> => ({
  DEFAULT: c(name),
  100: c(`${name}-100`),
  200: c(`${name}-200`),
  300: c(`${name}-300`),
  400: c(`${name}-400`),
  500: c(`${name}-500`),
});

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        chat: [
          "ui-sans-serif",
          "system-ui",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        action: ["Georgia", "Cambria", "Times New Roman", "serif"],
      },
      colors: {
        keep: {
          // canonical names — each is a ramp so `bg-keep-panel` (the
          // user-picked tone) AND `bg-keep-panel-200` (lighter highlight)
          // / `bg-keep-panel-400` (darker shadow rim) both compose.
          bg: ramp("bg"),
          panel: ramp("panel"),
          border: ramp("border"),
          text: ramp("text"),
          muted: ramp("muted"),
          action: ramp("action"),
          accent: ramp("accent"),
          system: ramp("system"),

          // legacy aliases — same canonical vars, just different spelling.
          // Kept ramp-aware so existing call sites still benefit from
          // the new tiers (e.g. `bg-keep-banner-200`).
          parchment: ramp("bg"),
          banner: ramp("panel"),
          rule: ramp("border"),
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
