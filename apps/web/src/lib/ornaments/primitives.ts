/**
 * Canvas + math primitives shared by every style generator. Kept
 * dependency-free so styles can compose these without pulling in extra
 * modules.
 */

/**
 * Allocate a canvas at `(w, h)` device pixels with `imageSmoothingEnabled
 * = false`. Pixel-art ornaments depend on crisp 1px units, and modern
 * styles can opt back into smoothing on a per-draw basis.
 */
export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cx = c.getContext("2d");
  if (cx) cx.imageSmoothingEnabled = false;
  return c;
}

/**
 * Serialize a canvas to a CSS `url("data:image/png;base64,...")` string
 * ready to assign as a custom property value. The PNG path keeps alpha,
 * which we lean on for the texture/overlay blends.
 */
export function canvasToUrl(canvas: HTMLCanvasElement): string {
  return `url("${canvas.toDataURL("image/png")}")`;
}

/**
 * Same idea but for SVG, used by modern/scifi styles that want resolution-
 * independent line art. The SVG body is wrapped in a `data:` URL with the
 * minimum escaping browsers need (`#` and `<` are the touchy ones).
 */
export function svgToUrl(svg: string): string {
  const encoded = svg
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/"/g, "'")
    .replace(/#/g, "%23")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
  return `url("data:image/svg+xml,${encoded}")`;
}

/**
 * Deterministic hash-based PRNG. Same seed → same noise pattern across
 * theme re-applies, so ornaments don't shimmer on every toggle. Two-input
 * variant lets generators key off (x, y) for textures or (seed, index)
 * for sigil families.
 */
export function rng2(a: number, b: number): number {
  let x = (a * 374761393 + b * 668265263) | 0;
  x = (x ^ (x >>> 13)) * 1274126177;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 0xffffffff;
}

/**
 * Worn-edge noise for parchment / paper textures. Returns a value in
 * [0, 1] that falls off smoothly toward the corners — useful for damping
 * the "noise mask" generators apply so corners look more weathered than
 * the center.
 */
export function cornerFalloff(x: number, y: number, w: number, h: number): number {
  const dx = Math.min(x, w - 1 - x) / (w / 2);
  const dy = Math.min(y, h - 1 - y) / (h / 2);
  return Math.min(1, Math.min(dx, dy) * 1.8);
}

/**
 * Bresenham line iterator. Walks every (x, y) cell between two endpoints
 * inclusive. Used by pixel-art generators that want to draw line work
 * (filigree spines, rune segments) without anti-aliasing artifacts.
 */
export function* line(x0: number, y0: number, x1: number, y1: number): Generator<[number, number]> {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  // Safety cap so a malformed input can't loop forever.
  const maxSteps = (dx - dy) + 4;
  for (let i = 0; i < maxSteps; i++) {
    yield [x, y];
    if (x === x1 && y === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/**
 * Linear interpolate between two hex colors. Returns "#rrggbb". Useful
 * inside generators that need an intermediate tone between two ramp steps
 * (e.g. a bevel highlight that's between panel-200 and panel-100).
 */
export function mixHex(a: string, b: string, t: number): string {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  const toHex = (n: number) => Math.min(255, Math.max(0, n)).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(bl)}`;
}
