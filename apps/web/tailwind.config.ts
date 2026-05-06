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
          // canonical names
          bg: c("bg"),
          panel: c("panel"),
          border: c("border"),
          text: c("text"),
          muted: c("muted"),
          action: c("action"),
          accent: c("accent"),
          system: c("system"),

          // legacy aliases — same canonical vars, just different spelling
          parchment: c("bg"),
          banner: c("panel"),
          rule: c("border"),
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
