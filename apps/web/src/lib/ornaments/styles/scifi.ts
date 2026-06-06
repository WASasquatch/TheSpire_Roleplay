/**
 * Scifi, Cyberpunk
 *
 * Neon-on-dark aesthetic, flat data planes, hot edges, scan lines.
 * Visual vocabulary:
 *
 *  - **Texture**: 1px horizontal scan lines + a sparse hexgrid overlay.
 *    Reads as a CRT or low-budget terminal display.
 *  - **Corners**: angular L-brackets with a neon outer glow trace.
 *    Cut at 45° tips so the corners look "chopped", very Y2K UI.
 *  - **Divider**: thin neon line with a center diamond and end-caps.
 *  - **Bg overlay**: deep vignette + magenta/cyan ambient blooms.
 */

import type { OrnamentPalette, OrnamentSet, StyleGenerator } from "../types.js";
import { canvasToUrl, makeCanvas, svgToUrl } from "../primitives.js";

export const scifi: StyleGenerator = {
  key: "scifi",
  label: "Scifi",
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
  const SIZE = 128;
  const c = makeCanvas(SIZE, SIZE);
  const ctx = c.getContext("2d");
  if (!ctx) return "none";
  const cx = ctx;
  cx.imageSmoothingEnabled = false;

  const scan = p.text[4] ?? "#000";
  const hex = p.action[2] ?? "#00ffd5";
  const [sr, sg, sb] = parseHex(scan);
  const [hr, hg, hb] = parseHex(hex);

  const img = cx.createImageData(SIZE, SIZE);
  const data = img.data;
  for (let y = 0; y < SIZE; y++) {
    // Scan lines: every 2nd row darker.
    const onScan = y % 2 === 0;
    for (let x = 0; x < SIZE; x++) {
      const idx = (y * SIZE + x) * 4;
      // Hex grid: very sparse 1px outline every ~20 cells.
      const onHex = ((x + (Math.floor(y / 16) % 2) * 10) % 20) === 0 && (y % 16) === 0;
      if (onHex) {
        data[idx] = hr; data[idx + 1] = hg; data[idx + 2] = hb;
        data[idx + 3] = 32;
      } else if (onScan) {
        data[idx] = sr; data[idx + 1] = sg; data[idx + 2] = sb;
        data[idx + 3] = 22;
      }
    }
  }
  cx.putImageData(img, 0, 0);
  return canvasToUrl(c);
}

function makeCorner(p: OrnamentPalette, corner: "tl" | "tr" | "bl" | "br"): string {
  // Top corners pull from the action ramp (cyan in the default palette,
  // matching the body's cyan bloom at viewport 12% 8% / 68% 28%); bottom
  // corners pull from accent (magenta, matching the bloom at 90% 94% /
  // 22% 76%). The result: each L-bracket is brightest at its outer tip,
  // fading back to the current dim "neon" along the legs, reads as if
  // the body bg blooms are casting onto the chrome.
  const isTop = corner === "tl" || corner === "tr";
  const bright = (isTop ? p.action[0] : p.accent[0]) ?? (isTop ? "#bff7f1" : "#ffc7e8");
  const base   = (isTop ? p.action[2] : p.accent[2]) ?? (isTop ? "#00ffd5" : "#ff00aa");
  const lit    = p.action[1] ?? "#88ffea";
  // Radial gradient centered on the outer tip (0,0 in the path's local
  // frame). After the per-corner transform below, that tip lands at the
  // actual outer corner of the frame, so the brightest spot points away
  // from the panel into the ambient bloom, exactly where the light is.
  // Gradient ID is per-corner so multiple corner backgrounds on one page
  // can't collide. `userSpaceOnUse` keeps the radius literal-pixels.
  const gid = `scifi-corner-${corner}`;
  const defs = `
    <defs>
      <radialGradient id="${gid}" cx="0" cy="0" r="22" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="${bright}" stop-opacity="1"/>
        <stop offset="60%" stop-color="${base}" stop-opacity="0.85"/>
        <stop offset="100%" stop-color="${base}" stop-opacity="0.55"/>
      </radialGradient>
    </defs>
  `;
  // Chopped-tip L-bracket: 14 px legs that taper at the outer end.
  const stroke = `
    <path d="M0 6 L6 0 L18 0 L18 2 L7 2 L2 7 L2 18 L0 18 Z" fill="url(#${gid})"/>
    <path d="M0 6 L6 0 L18 0 L18 2 L7 2 L2 7 L2 18 L0 18 Z" fill="none" stroke="${lit}" stroke-width="0.3" opacity="0.6"/>
  `;
  const transform =
    corner === "tl" ? "" :
    corner === "tr" ? "translate(32 0) scale(-1 1)" :
    corner === "bl" ? "translate(0 32) scale(1 -1)" :
    "translate(32 32) scale(-1 -1)";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
      ${defs}
      <g transform="${transform}">${stroke}</g>
    </svg>
  `;
  return svgToUrl(svg);
}

function makeDivider(p: OrnamentPalette): string {
  const neon = p.action[2] ?? "#00ffd5";
  const accent = p.accent[2] ?? "#ff00aa";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 14" width="240" height="14" preserveAspectRatio="none">
      <line x1="6" y1="7" x2="110" y2="7" stroke="${neon}" stroke-width="1.5" stroke-linecap="square"/>
      <line x1="130" y1="7" x2="234" y2="7" stroke="${neon}" stroke-width="1.5" stroke-linecap="square"/>
      <polygon points="120,1 128,7 120,13 112,7" fill="${accent}"/>
      <line x1="4" y1="3" x2="4" y2="11" stroke="${neon}" stroke-width="1.5"/>
      <line x1="236" y1="3" x2="236" y2="11" stroke="${neon}" stroke-width="1.5"/>
    </svg>
  `;
  return svgToUrl(svg);
}

function makeBgOverlay(p: OrnamentPalette): string {
  // Strong cyan/magenta ambient blooms layered ON TOP of the CSS
  // body bokeh in styles.css, both contribute additively so the
  // viewport reads as a dense lens-defocus haze rather than one
  // dim wash. No vignette (the previous 45%-alpha black darken
  // was crushing the body bokeh's pink/cyan corners).
  const cyan = p.action[1] ?? p.action[2] ?? "#00ffd5";  // brighter ramp step
  const magenta = p.accent[1] ?? p.accent[2] ?? "#ff00aa";
  const cyan2 = p.action[2] ?? "#00ffd5";
  const magenta2 = p.accent[2] ?? "#ff00aa";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" preserveAspectRatio="none">
      <defs>
        <radialGradient id="g1" cx="15%" cy="20%" r="60%">
          <stop offset="0%" stop-color="${cyan}" stop-opacity="0.35"/>
          <stop offset="55%" stop-color="${cyan}" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="g2" cx="85%" cy="80%" r="60%">
          <stop offset="0%" stop-color="${magenta}" stop-opacity="0.35"/>
          <stop offset="55%" stop-color="${magenta}" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="g3" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="${cyan2}" stop-opacity="0.10"/>
          <stop offset="70%" stop-color="${magenta2}" stop-opacity="0.06"/>
          <stop offset="100%" stop-color="${magenta2}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="800" height="600" fill="url(#g1)"/>
      <rect width="800" height="600" fill="url(#g2)"/>
      <rect width="800" height="600" fill="url(#g3)"/>
    </svg>
  `;
  return svgToUrl(svg);
}

function parseHex(s: string): [number, number, number] {
  const h = s.startsWith("#") ? s.slice(1) : s;
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
}
