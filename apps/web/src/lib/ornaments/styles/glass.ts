/**
 * Glass, Frosted glass / liquid glass
 *
 * Translucent panels over the user's chosen backdrop image, with soft
 * frost bevels and outer ambient shadows. The visual language sits
 * close to modern OS settings UIs (macOS Sequoia, iOS Control Center)
 * rather than gaming chrome.
 *
 * Visual vocabulary:
 *  - **Ornaments are deliberately sparse.** The whole design lives in
 *    CSS, backdrop-filter blur, inset highlight + dark bevels, soft
 *    radial outer shadow. Adding L-bracket corners or neon dividers
 *    here would fight the frost recipe, so we skip them entirely.
 *  - **bg-overlay**: a faint two-stop diagonal tint in the palette's
 *    action + accent colors. Layered on top of the user's backdrop
 *    image at very low alpha (~6%) so the palette pokes through the
 *    glass without ever competing with the bg artwork itself.
 *  - No corners, no divider, no texture. Frame chrome is entirely
 *    style-driven (see styles.css `[data-theme-style="glass"]`).
 */

import type { OrnamentPalette, OrnamentSet, StyleGenerator } from "../types.js";
import { svgToUrl } from "../primitives.js";

export const glass: StyleGenerator = {
  key: "glass",
  label: "Glass",
  generate(p: OrnamentPalette): OrnamentSet {
    return {
      "bg-overlay": makeBgOverlay(p),
    };
  },
};

function makeBgOverlay(p: OrnamentPalette): string {
  // Two faint radial blooms in the palette's action + accent colors.
  // Sits between the backdrop image and the chat shell, so the
  // palette tints the artwork without obscuring it. Kept at very low
  // alpha, the darkening rectangle in CSS does the bulk of the
  // contrast lift; this is purely color memory.
  const action = p.action[2] ?? "#3aa";
  const accent = p.accent[2] ?? "#d3a";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" preserveAspectRatio="none">
      <defs>
        <radialGradient id="g-action" cx="18%" cy="22%" r="62%">
          <stop offset="0%" stop-color="${action}" stop-opacity="0.10"/>
          <stop offset="60%" stop-color="${action}" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="g-accent" cx="82%" cy="78%" r="60%">
          <stop offset="0%" stop-color="${accent}" stop-opacity="0.08"/>
          <stop offset="60%" stop-color="${accent}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="800" height="600" fill="url(#g-action)"/>
      <rect width="800" height="600" fill="url(#g-accent)"/>
    </svg>
  `;
  return svgToUrl(svg);
}
