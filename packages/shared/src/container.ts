/**
 * Themed "container" embed messages (`/container <style> [color]`).
 *
 * Shared so the server command validator and the client renderer agree on the
 * allowed style + accent-color keywords. The color is stored on the message as
 * a KEYWORD (theme-independent) and resolved to an accent hue per VIEWER at
 * render time (never a snapshot hex), so a container re-themes when a viewer
 * switches palette. The container's base surface (bg/border/text) tracks the
 * viewer's active theme via the `--theme-*` CSS vars; the accent overlays it.
 */

/** Card styles. Each maps to a `.container-embed--<style>` class on the web. */
export const CONTAINER_STYLES = ["solid", "glass", "parchment", "bokeh", "gradient"] as const;
export type ContainerStyle = (typeof CONTAINER_STYLES)[number];
export function isContainerStyle(s: string): s is ContainerStyle {
  return (CONTAINER_STYLES as readonly string[]).includes(s);
}

/**
 * Accent color KEYWORDS a `/container` may carry. Absent = the viewer's theme
 * accent (`--theme-accent`). "alert" is the yellow-orange call-out hue.
 */
export const CONTAINER_COLORS = ["alert", "red", "orange", "green", "teal", "blue", "purple", "pink"] as const;
export type ContainerColor = (typeof CONTAINER_COLORS)[number];
export function isContainerColor(s: string): s is ContainerColor {
  return (CONTAINER_COLORS as readonly string[]).includes(s);
}

/**
 * Keyword → "R G B" triple (space-separated) for CSS `rgb(<triple> / <alpha>)`.
 * The web renderer sets `--container-accent` to this so the injected
 * `.container-embed--<style>` rules can tint borders/glows/gradients. A row
 * with no keyword falls back to `var(--theme-accent-rgb)`.
 */
/**
 * Row→wire spread for a message's container presentation (parity with the
 * `sceneImageUrl` inline spread at every message-build site). Attaches
 * `containerStyle` (+ `containerColor` when set) only when the row is styled,
 * so non-container rows stay light on the wire. Mirrors `mentionsField`.
 */
export function containerFields(
  row: { containerStyle?: string | null; containerColor?: string | null },
): { containerStyle?: string; containerColor?: string } {
  if (!row.containerStyle) return {};
  return {
    containerStyle: row.containerStyle,
    ...(row.containerColor ? { containerColor: row.containerColor } : {}),
  };
}

export const CONTAINER_COLOR_RGB: Record<ContainerColor, string> = {
  alert: "234 179 8",   // amber-500 — the yellow-orange "alert" hue
  red: "220 38 38",     // red-600
  orange: "234 88 12",  // orange-600
  green: "22 163 74",   // green-600
  teal: "13 148 136",   // teal-600
  blue: "37 99 235",    // blue-600
  purple: "147 51 234", // purple-600
  pink: "219 39 119",   // pink-600
};
