/**
 * Medieval — Parchment
 *
 * The flagship style. Treats every panel as a sheet of aged vellum bound
 * with ink filigree. Visual vocabulary:
 *
 *  - **Texture**: warm paper grain. 128 px tile of multi-octave noise
 *    biased toward the panel's darker ramp steps, with sparse "age spots"
 *    (soft brown stippling) so the same tile doesn't tessellate visibly.
 *  - **Corners**: 32 px ink-filigree corner pieces. A curling vine root
 *    + paired leaves, drawn in border-ramp dark with accent-ramp inner
 *    highlight. Each corner is the same source rotated/mirrored to its
 *    quadrant so the four corners read as a continuous frame.
 *  - **Divider**: horizontal flourish with a central diamond sigil and
 *    paired knobs along a two-tone ink line. Built from the accent + bone
 *    end of the ramp so it reads as gilded ink, not flat color.
 *  - **Bg overlay**: large radial warm-glow gradient stack + soft vignette,
 *    rendered as SVG so it scales to any viewport without raster blur.
 *
 * Every ornament reads its colors from the live palette ramp, so the same
 * generator produces parchment-ish ink under the default tan theme AND
 * cool-toned ink under a Twilight repaint.
 */

import type { OrnamentPalette, OrnamentSet, StyleGenerator } from "../types.js";
import { canvasToUrl, cornerFalloff, line, makeCanvas, mixHex, rng2, svgToUrl } from "../primitives.js";

export const medieval: StyleGenerator = {
  key: "medieval",
  label: "Medieval",
  generate(p: OrnamentPalette): OrnamentSet {
    // Tiled noise textures were ugly at viewport scale — visible
    // wallpaper seams + repetition. The style identity now lives in
    // the per-style frame CSS (border treatment, shadows, gradients)
    // and the SVG bg-overlay, neither of which tile. Texture stays
    // available as an ornament key but every style returns "none"
    // until we find a treatment that genuinely benefits from one.
    void makeTexture;
    return {
      "corner-tl": makeCorner(p, "tl"),
      "corner-tr": makeCorner(p, "tr"),
      "corner-bl": makeCorner(p, "bl"),
      "corner-br": makeCorner(p, "br"),
      divider: makeDivider(p),
      "bg-overlay": makeBgOverlay(p),
    };
  },
};

/* ============================================================
 * Texture — tiled parchment grain
 * ============================================================ */
function makeTexture(p: OrnamentPalette): string {
  const SIZE = 128;
  const c = makeCanvas(SIZE, SIZE);
  const cx = c.getContext("2d");
  if (!cx) return "none";
  cx.imageSmoothingEnabled = false;

  // Base fill is transparent — the texture is meant to overlay on the
  // panel's actual background color, contributing only grain + age spots.
  // Two ramp steps drive the grain: panel-400 (one shade darker than
  // base) for the dark fibers and panel-200 (one shade lighter) for the
  // highlight fibers.
  const darkFiber = p.panel[3] ?? p.panel[2] ?? "#000";
  const lightFiber = p.panel[1] ?? p.panel[2] ?? "#fff";
  const ageSpot = p.border[3] ?? p.muted[3] ?? "#553";

  const img = cx.createImageData(SIZE, SIZE);
  const data = img.data;
  const [dr, dg, db] = hexParts(darkFiber);
  const [lr, lg, lb] = hexParts(lightFiber);
  const [ar, ag, ab] = hexParts(ageSpot);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Multi-octave noise: a coarse cell + a fine cell + a single-pixel
      // jitter, summed into [-1, 1]. The base noise becomes paper fibers.
      const n1 = rng2(Math.floor(x / 4), Math.floor(y / 4)) - 0.5;
      const n2 = rng2(Math.floor(x / 2) + 17, Math.floor(y / 2) + 31) - 0.5;
      const n3 = rng2(x + 191, y + 313) - 0.5;
      const noise = n1 * 0.5 + n2 * 0.3 + n3 * 0.2;

      // Tiny chance per pixel of an age spot. Sparse and irregular —
      // the rng2 seed mixing avoids tile-edge alignment.
      const spotChance = rng2(x + 977, y + 1289);
      const isSpot = spotChance > 0.985;

      const idx = (y * SIZE + x) * 4;
      if (isSpot) {
        // Age-spot pixel: warm brown at moderate alpha. Slight variation
        // in alpha so the cluster reads as organic, not solid.
        const aIntensity = 0.5 + rng2(x + 7, y + 13) * 0.4;
        data[idx] = ar;
        data[idx + 1] = ag;
        data[idx + 2] = ab;
        data[idx + 3] = Math.round(aIntensity * 140);
      } else if (noise > 0.12) {
        // Dark fiber — boosted alpha so the grain reads even under
        // the multiply blend mode the CSS layer applies.
        data[idx] = dr;
        data[idx + 1] = dg;
        data[idx + 2] = db;
        data[idx + 3] = Math.round(Math.min(1, noise * 1.8) * 80);
      } else if (noise < -0.12) {
        // Light fiber (highlight)
        data[idx] = lr;
        data[idx + 1] = lg;
        data[idx + 2] = lb;
        data[idx + 3] = Math.round(Math.min(1, -noise * 1.8) * 55);
      } else {
        // Neutral pixel — fully transparent so the panel color shows
        // through unaltered.
        data[idx + 3] = 0;
      }
    }
  }
  cx.putImageData(img, 0, 0);
  return canvasToUrl(c);
}

/* ============================================================
 * Corner ornament — ink filigree
 *
 * Drawn natively in the top-left quadrant then transformed onto the
 * other three corners. Designed at 32×32 px, scaled 1×; pixel-art
 * crispness comes from `image-rendering: pixelated` on the consumer
 * element (set in styles.css).
 * ============================================================ */
function makeCorner(p: OrnamentPalette, corner: "tl" | "tr" | "bl" | "br"): string {
  const SIZE = 32;
  const c = makeCanvas(SIZE, SIZE);
  const ctx = c.getContext("2d");
  if (!ctx) return "none";
  // Capture the non-null context into a `const` so the nested helpers
  // below close over a definitely-defined value — TS can't propagate the
  // null-guard narrowing through a function boundary otherwise.
  const cx = ctx;
  cx.imageSmoothingEnabled = false;

  // Filigree palette:
  //   dark   — the deepest border step, for the spine of every line
  //   mid    — one step lighter, for the curl interior
  //   light  — accent (gilded ink highlights)
  //   bone   — the lightest text tone, for inner glow dots
  const dark = p.border[4] ?? p.border[3] ?? "#3a2a18";
  const mid = p.border[2] ?? p.muted[2] ?? "#6c5532";
  const light = p.action[2] ?? p.accent[2] ?? "#b88a3c";
  const bone = p.text[0] ?? p.muted[0] ?? "#e8dab3";

  // Helper: plot a single pixel in TL-coordinate space, then transform
  // to the actual quadrant. This keeps the source drawing readable
  // (always top-left) while emitting the right rotation per call.
  function plot(x: number, y: number, color: string): void {
    let tx = x, ty = y;
    if (corner === "tr") { tx = SIZE - 1 - x; ty = y; }
    else if (corner === "bl") { tx = x; ty = SIZE - 1 - y; }
    else if (corner === "br") { tx = SIZE - 1 - x; ty = SIZE - 1 - y; }
    cx.fillStyle = color;
    cx.fillRect(tx, ty, 1, 1);
  }
  function dot(x: number, y: number, color: string): void { plot(x, y, color); }
  function stroke(x0: number, y0: number, x1: number, y1: number, color: string): void {
    for (const [x, y] of line(x0, y0, x1, y1)) plot(x, y, color);
  }

  // ---- Outer L-frame, two layers (dark + mid bevel) ----
  // Top horizontal: thin double rule
  for (let x = 1; x < 26; x++) {
    plot(x, 1, dark);
    plot(x, 2, mid);
  }
  // Left vertical: thin double rule
  for (let y = 1; y < 26; y++) {
    plot(1, y, dark);
    plot(2, y, mid);
  }
  // Inner corner notch — adds depth where the two rules meet
  plot(1, 1, dark);
  plot(2, 2, light);

  // ---- Vine root that curls inward from the corner ----
  // Two-stage curl: outer arc (broad sweep) then a tight inner loop.
  // Coordinates were tuned by eye for a 32px field.
  const arc1: Array<[number, number]> = [
    [4, 4], [5, 4], [6, 5], [7, 5], [8, 6],
    [9, 7], [10, 8], [11, 10], [12, 12], [12, 14],
    [11, 15], [10, 16], [9, 16], [8, 15],
  ];
  for (const [x, y] of arc1) plot(x, y, dark);
  // Bevel along the inside of the arc
  for (const [x, y] of arc1) plot(x + 1, y, mid);

  // ---- Paired leaves at the bottom of the curl ----
  // Each leaf is a small diamond with a brighter inner dot.
  function leaf(cxp: number, cyp: number): void {
    plot(cxp, cyp - 1, dark);
    plot(cxp - 1, cyp, dark);
    plot(cxp + 1, cyp, dark);
    plot(cxp, cyp + 1, dark);
    plot(cxp, cyp, light);
  }
  leaf(14, 17);
  leaf(17, 14);

  // ---- Decorative knob at the L-frame corner ----
  // Three-pixel diamond in the gilded color with a single bone highlight.
  plot(4, 1, dark);
  plot(1, 4, dark);
  plot(3, 2, light);
  plot(2, 3, light);
  plot(3, 3, bone);

  // ---- End cap on the L-frame ends ----
  // Small terminal flourish so the rules don't just stop dead.
  stroke(25, 1, 25, 4, dark);
  stroke(26, 2, 26, 3, mid);
  plot(26, 3, light);

  stroke(1, 25, 4, 25, dark);
  stroke(2, 26, 3, 26, mid);
  plot(3, 26, light);

  return canvasToUrl(c);
}

/* ============================================================
 * Divider — horizontal flourish with center sigil
 * ============================================================ */
function makeDivider(p: OrnamentPalette): string {
  const W = 240;
  const H = 14;
  const c = makeCanvas(W, H);
  const cx = c.getContext("2d");
  if (!cx) return "none";
  cx.imageSmoothingEnabled = false;

  const dark = p.border[4] ?? "#3a2a18";
  const mid = p.border[2] ?? "#6c5532";
  const light = p.action[2] ?? p.accent[2] ?? "#b88a3c";
  const bright = p.action[1] ?? p.accent[1] ?? "#d4a85a";
  const bone = p.text[0] ?? "#e8dab3";
  const accent = p.accent[3] ?? "#8a1f1f";

  const cxp = Math.floor(W / 2);
  const cyp = Math.floor(H / 2);

  // ---- Three-tone center rule, broken at the sigil ----
  for (let x = 0; x < W; x++) {
    const distFromCenter = Math.abs(x - cxp);
    if (distFromCenter < 14) continue;
    const edgeDist = Math.min(x, W - 1 - x);
    if (edgeDist < 10) continue;
    cx.fillStyle = mid;
    cx.fillRect(x, cyp - 1, 1, 1);
    cx.fillStyle = light;
    cx.fillRect(x, cyp, 1, 1);
    cx.fillStyle = dark;
    cx.fillRect(x, cyp + 1, 1, 1);
  }

  // ---- Decorative knobs along the rule ----
  // Spaced and tinted to feel like cast metal beads.
  for (const dx of [-72, -52, -34, 34, 52, 72]) {
    const x = cxp + dx;
    cx.fillStyle = light;
    cx.fillRect(x - 1, cyp - 1, 3, 3);
    cx.fillStyle = bright;
    cx.fillRect(x, cyp - 1, 1, 1);
    cx.fillStyle = dark;
    cx.fillRect(x - 1, cyp + 2, 3, 1);
  }

  // ---- Tapered curl at each end of the rule ----
  for (const side of [-1, 1]) {
    const x0 = cxp + side * 92;
    cx.fillStyle = mid;
    cx.fillRect(x0, cyp - 2, 1, 5);
    cx.fillStyle = light;
    cx.fillRect(x0 + side, cyp - 1, 1, 3);
    cx.fillStyle = bright;
    cx.fillRect(x0 + side * 2, cyp, 1, 1);
  }

  // ---- Center sigil: rotated diamond with accent inset ----
  for (let i = -6; i <= 6; i++) {
    const w = 6 - Math.abs(i);
    for (let j = -w; j <= w; j++) {
      const px = cxp + j;
      const py = cyp + i;
      const onEdge = Math.abs(j) === w;
      if (onEdge) {
        cx.fillStyle = dark;
      } else if (i < 0) {
        cx.fillStyle = light;
      } else if (i === 0) {
        cx.fillStyle = bright;
      } else {
        cx.fillStyle = mid;
      }
      cx.fillRect(px, py, 1, 1);
    }
  }
  // Accent-color inset cross inside the diamond — reads as a heraldic gem
  cx.fillStyle = accent;
  cx.fillRect(cxp - 1, cyp, 3, 1);
  cx.fillRect(cxp, cyp - 1, 1, 3);
  cx.fillStyle = bone;
  cx.fillRect(cxp, cyp, 1, 1);

  return canvasToUrl(c);
}

/* ============================================================
 * Background overlay — warm ambient glow + vignette (SVG)
 *
 * SVG so it scales to any viewport without raster blur. The CSS
 * consumer applies it as a fixed full-viewport `background-image` on
 * `body::before` at moderate opacity.
 * ============================================================ */
function makeBgOverlay(p: OrnamentPalette): string {
  const warmGlow = p.action[2] ?? "#b88a3c";
  const ember = p.accent[3] ?? "#8a1f1f";
  // Two soft radial blooms (one upper-left, one lower-right) layered
  // over a corner-to-corner vignette. Keeps the page from feeling like
  // a single flat parchment slab without distracting from content.
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" preserveAspectRatio="none">
      <defs>
        <radialGradient id="glow1" cx="20%" cy="15%" r="60%">
          <stop offset="0%" stop-color="${warmGlow}" stop-opacity="0.10"/>
          <stop offset="60%" stop-color="${warmGlow}" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="glow2" cx="85%" cy="90%" r="55%">
          <stop offset="0%" stop-color="${ember}" stop-opacity="0.08"/>
          <stop offset="65%" stop-color="${ember}" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="vignette" cx="50%" cy="50%" r="75%">
          <stop offset="55%" stop-color="#000" stop-opacity="0"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0.28"/>
        </radialGradient>
      </defs>
      <rect width="800" height="600" fill="url(#glow1)"/>
      <rect width="800" height="600" fill="url(#glow2)"/>
      <rect width="800" height="600" fill="url(#vignette)"/>
    </svg>
  `;
  void cornerFalloff;
  return svgToUrl(svg);
}

/* ============================================================
 * Helpers
 * ============================================================ */
function hexParts(hex: string): [number, number, number] {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
}
// re-export to satisfy noUnused if styles import mixHex elsewhere later
void mixHex;
