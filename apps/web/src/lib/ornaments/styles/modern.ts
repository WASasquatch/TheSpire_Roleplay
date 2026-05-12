/**
 * Modern — Flat
 *
 * Clean, minimal 2025-web aesthetic. SVG-based for crisp lines at any
 * resolution. Visual vocabulary:
 *
 *  - **Texture**: essentially none — barely-perceptible vertical
 *    gradient hint to give panels a sense of light direction
 *    without committing to a heavy treatment.
 *  - **Corners**: thin geometric L-brackets — single 1px stroke,
 *    no fills, no ornament. Reads as a Bauhaus-style frame.
 *  - **Divider**: hairline rule with a small accent-color square
 *    at the center.
 *  - **Bg overlay**: very subtle vertical gradient + soft corner glow.
 */

import type { OrnamentPalette, OrnamentSet, StyleGenerator } from "../types.js";
import { svgToUrl } from "../primitives.js";

export const modern: StyleGenerator = {
  key: "modern",
  label: "Modern",
  generate(p: OrnamentPalette): OrnamentSet {
    return {
      // texture omitted: tiled noise looked bad at viewport scale.
      "corner-tl": makeCorner(p, "tl"),
      "corner-tr": makeCorner(p, "tr"),
      "corner-bl": makeCorner(p, "bl"),
      "corner-br": makeCorner(p, "br"),
      divider: makeDivider(p),
      "bg-overlay": makeBgOverlay(p),
    };
  },
};

function makeTexture(p: OrnamentPalette): string {
  // Faintest possible vertical hint — purely tonal, no grain.
  const light = p.panel[1] ?? "#ffffff";
  const dark = p.panel[3] ?? "#aaaaaa";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" preserveAspectRatio="none">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${light}" stop-opacity="0.06"/>
          <stop offset="100%" stop-color="${dark}" stop-opacity="0.05"/>
        </linearGradient>
      </defs>
      <rect width="128" height="128" fill="url(#g)"/>
    </svg>
  `;
  return svgToUrl(svg);
}

function makeCorner(p: OrnamentPalette, corner: "tl" | "tr" | "bl" | "br"): string {
  const stroke = p.border[3] ?? "#999";
  // Path drawn in TL coords; transform inserted per quadrant.
  // Two 14-pixel legs meeting at the corner, both 1px stroke.
  const lines = `<path d="M2 0 V14 M0 2 H14" stroke="${stroke}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
  const transform =
    corner === "tl" ? "" :
    corner === "tr" ? "translate(32 0) scale(-1 1)" :
    corner === "bl" ? "translate(0 32) scale(1 -1)" :
    "translate(32 32) scale(-1 -1)";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
      <g transform="${transform}">${lines}</g>
    </svg>
  `;
  return svgToUrl(svg);
}

function makeDivider(p: OrnamentPalette): string {
  const rule = p.border[3] ?? "#888";
  const dot = p.action[3] ?? "#0078d4";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 14" width="240" height="14" preserveAspectRatio="none">
      <line x1="8" y1="7" x2="112" y2="7" stroke="${rule}" stroke-width="1" stroke-linecap="round"/>
      <line x1="128" y1="7" x2="232" y2="7" stroke="${rule}" stroke-width="1" stroke-linecap="round"/>
      <rect x="116" y="3" width="8" height="8" fill="${dot}" rx="1"/>
    </svg>
  `;
  return svgToUrl(svg);
}

function makeBgOverlay(p: OrnamentPalette): string {
  const tint = p.action[2] ?? "#0078d4";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" preserveAspectRatio="none">
      <defs>
        <radialGradient id="g1" cx="80%" cy="0%" r="70%">
          <stop offset="0%" stop-color="${tint}" stop-opacity="0.06"/>
          <stop offset="65%" stop-color="${tint}" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#fff" stop-opacity="0.02"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0.04"/>
        </linearGradient>
      </defs>
      <rect width="800" height="600" fill="url(#g1)"/>
      <rect width="800" height="600" fill="url(#g2)"/>
    </svg>
  `;
  return svgToUrl(svg);
}
