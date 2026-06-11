/**
 * Baked-SVG helpers for the room-transition rites, ported from the
 * spire-transitions.html demo. Each returns a `url("data:image/svg+xml,…")`
 * string used as a CSS background-image / mask. They rasterise their noise
 * once inside the SVG, so the rites only ever animate transform/opacity —
 * runtime cost stays pure compositing. Pure functions, no DOM.
 */

const enc = (svg: string): string => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

/** a real starfield — crisp white dots, not colour noise */
export function starsURI(n = 95, w = 660, h = 540, seed = 21): string {
  let k = seed;
  const rnd = () => { k++; const v = Math.sin(k * 12.9898 + seed * 78.233) * 43758.5453; return v - Math.floor(v); };
  let c = "";
  for (let i = 0; i < n; i++) {
    const x = (rnd() * w).toFixed(1), y = (rnd() * h).toFixed(1);
    const r = (rnd() * 1.4 + 0.3).toFixed(2), o = (rnd() * 0.6 + 0.35).toFixed(2);
    c += `<circle cx='${x}' cy='${y}' r='${r}' fill='#e4e9ff' opacity='${o}'/>`;
  }
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>${c}</svg>`);
}

/** a soft curling smoke wisp (two blurred strokes), for the candle snuff */
export function wispURI(o: { w?: number; h?: number; color?: string } = {}): string {
  const { w = 140, h = 240, color = "198,198,214" } = o;
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>` +
    `<defs><filter id='b' x='-40%' y='-20%' width='180%' height='140%'><feGaussianBlur stdDeviation='3.5'/></filter></defs>` +
    `<g filter='url(#b)' fill='none' stroke-linecap='round'>` +
      `<path d='M70,226 C48,184 96,158 66,118 C46,90 84,64 62,26' stroke='rgba(${color},0.5)' stroke-width='8'/>` +
      `<path d='M70,226 C56,192 88,166 70,128 C58,100 80,72 68,40' stroke='rgba(${color},0.85)' stroke-width='3'/>` +
    `</g></svg>`);
}

/** warm corona rays for the eclipse rim */
export function coronaRaysURI(o: { w?: number; n?: number; seed?: number } = {}): string {
  const { w = 900, n = 46, seed = 8 } = o;
  const c = w / 2; let k = seed;
  const rnd = () => { k++; const v = Math.sin(k * 12.9898 + seed * 78.233) * 43758.5453; return v - Math.floor(v); };
  let lines = "";
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI + rnd() * 0.06;
    const r0 = w * 0.392, r1 = r0 + w * (0.018 + rnd() * 0.085);
    lines += `<line x1='${(c + Math.cos(a) * r0).toFixed(1)}' y1='${(c + Math.sin(a) * r0).toFixed(1)}' ` +
      `x2='${(c + Math.cos(a) * r1).toFixed(1)}' y2='${(c + Math.sin(a) * r1).toFixed(1)}' ` +
      `stroke='rgba(255,236,200,${(0.14 + rnd() * 0.36).toFixed(2)})' stroke-width='${(1 + rnd() * 1.6).toFixed(1)}' stroke-linecap='round'/>`;
  }
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${w}'>` +
    `<defs><filter id='g' x='-10%' y='-10%' width='120%' height='120%'><feGaussianBlur stdDeviation='1.6'/></filter></defs>` +
    `<g filter='url(#g)'>${lines}</g></svg>`);
}

/** a baked irregular ink blob (real displaced edge) */
export function inkBlobURI(o: { w?: number; seed?: number; r?: number } = {}): string {
  const { w = 900, seed = 9, r = 210 } = o;
  const c = w / 2;
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${w}'>` +
    `<defs>` +
      `<filter id='rag' x='-30%' y='-30%' width='160%' height='160%'>` +
        `<feTurbulence type='fractalNoise' baseFrequency='0.012 0.016' numOctaves='4' seed='${seed}' stitchTiles='stitch' result='n'/>` +
        `<feDisplacementMap in='SourceGraphic' in2='n' scale='120' xChannelSelector='R' yChannelSelector='G'/></filter>` +
      `<radialGradient id='inkCol' cx='50%' cy='44%' r='62%'>` +
        `<stop offset='0' stop-color='#161126'/><stop offset='0.5' stop-color='#0a0814'/><stop offset='1' stop-color='#05040b'/></radialGradient>` +
    `</defs>` +
    `<g filter='url(#rag)'>` +
      `<circle cx='${c}' cy='${c}' r='${r}' fill='url(#inkCol)'/>` +
      `<circle cx='${c}' cy='${c}' r='${r - 4}' fill='none' stroke='rgba(120,100,165,0.22)' stroke-width='7'/>` +
    `</g></svg>`);
}

/** dense inner rune ring to counter-rotate inside the main sigil */
export function runeRingURI(o: { color?: string; w?: number } = {}): string {
  const { color = "#b48fe0", w = 420 } = o;
  const c = w / 2; let ticks = "";
  for (let i = 0; i < 36; i++) {
    const a = i / 36 * 2 * Math.PI, r1 = 176, r2 = (i % 3 ? 186 : 191);
    ticks += `<line x1='${(c + Math.cos(a) * r1).toFixed(1)}' y1='${(c + Math.sin(a) * r1).toFixed(1)}' x2='${(c + Math.cos(a) * r2).toFixed(1)}' y2='${(c + Math.sin(a) * r2).toFixed(1)}' stroke='${color}' stroke-width='2.5'/>`;
  }
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${w}'>` +
    `<defs><filter id='g' x='-20%' y='-20%' width='140%' height='140%'><feGaussianBlur stdDeviation='4'/></filter></defs>` +
    `<g fill='none' stroke='${color}'>` +
      `<g filter='url(#g)' stroke-width='4' opacity='0.65'><circle cx='${c}' cy='${c}' r='192'/></g>` +
      `<circle cx='${c}' cy='${c}' r='192' stroke-width='2'/>` +
      `<circle cx='${c}' cy='${c}' r='160' stroke-width='1.6' stroke-dasharray='7 12'/>` +
      `${ticks}` +
    `</g></svg>`);
}

/** desaturated (grayscale) noise — for ash/char/static texture */
export function monoNoiseURI(o: { freq?: number; oct?: number; seed?: number; w?: number; h?: number; slope?: number } = {}): string {
  const { freq = 0.55, oct = 3, seed = 5, w = 260, h = 260, slope = 0.5 } = o;
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>` +
    `<filter id='f'>` +
      `<feTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='${oct}' seed='${seed}' stitchTiles='stitch' result='n'/>` +
      `<feColorMatrix in='n' type='saturate' values='0' result='g'/>` +
      `<feComponentTransfer in='g'><feFuncA type='linear' slope='${slope}' intercept='0'/></feComponentTransfer>` +
    `</filter>` +
    `<rect width='100%' height='100%' filter='url(#f)'/></svg>`);
}

/** FULLY-BAKED cloud bitmap: gray colour + noise shape + softness + optional inner-edge fade */
export function cloudBG(o: {
  freq?: number; oct?: number; seed?: number; w?: number; h?: number;
  fade?: "l" | "r" | null; blur?: number; slope?: number; intercept?: number;
  light?: string; dark?: string;
} = {}): string {
  const {
    freq = 0.011, oct = 3, seed = 2, w = 480, h = 520, fade = null, blur = 11,
    slope = 1.4, intercept = 0.06,
    light = "rgba(150,154,168,0.97)", dark = "rgba(50,53,66,0.98)",
  } = o;
  const turbF =
    `<filter id='t' x='-6%' y='-6%' width='112%' height='112%'>` +
      `<feTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='${oct}' seed='${seed}' stitchTiles='stitch' result='n'/>` +
      `<feComponentTransfer in='n' result='a'><feFuncA type='linear' slope='${slope}' intercept='${intercept}'/></feComponentTransfer>` +
      `<feColorMatrix in='a' type='matrix' values='0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 1'/>` +
    `</filter>`;
  let edgeDefs = "", shape: string;
  if (fade) {
    const stops = fade === "l"
      ? `<stop offset='0' stop-color='#fff'/><stop offset='0.42' stop-color='#fff'/><stop offset='1' stop-color='#000'/>`
      : `<stop offset='0' stop-color='#000'/><stop offset='0.58' stop-color='#fff'/><stop offset='1' stop-color='#fff'/>`;
    edgeDefs = `<linearGradient id='fg' gradientUnits='userSpaceOnUse' x1='0' y1='0' x2='${w}' y2='0'>${stops}</linearGradient>` +
      `<mask id='edge'><rect width='100%' height='100%' fill='url(#fg)'/></mask>`;
    shape = `<g mask='url(#edge)'><rect width='100%' height='100%' filter='url(#t)'/></g>`;
  } else {
    shape = `<rect width='100%' height='100%' filter='url(#t)'/>`;
  }
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>` +
    `<defs>` + turbF +
      `<filter id='soft' x='-25%' y='-25%' width='150%' height='150%'><feGaussianBlur stdDeviation='${blur}'/></filter>` +
      edgeDefs +
      `<linearGradient id='col' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${light}'/><stop offset='1' stop-color='${dark}'/></linearGradient>` +
      `<mask id='shape'>${shape}</mask>` +
    `</defs>` +
    `<g filter='url(#soft)'><rect width='100%' height='100%' fill='url(#col)' mask='url(#shape)'/></g>` +
    `</svg>`);
}

/** FULLY-BAKED burned-parchment sheet: solid char on the left, a ragged charred edge on the right */
export function burnSheet(o: { w?: number; h?: number; seed?: number; scale?: number } = {}): string {
  const { w = 1100, h = 760, seed = 7, scale = 84 } = o;
  const rag = `<filter id='rag' x='-16%' y='-16%' width='132%' height='132%'>` +
    `<feTurbulence type='fractalNoise' baseFrequency='0.006 0.02' numOctaves='4' seed='${seed}' stitchTiles='stitch' result='n'/>` +
    `<feDisplacementMap in='SourceGraphic' in2='n' scale='${scale}' xChannelSelector='R' yChannelSelector='G'/></filter>`;
  const grain = `<filter id='grain'><feTurbulence type='fractalNoise' baseFrequency='0.6' numOctaves='3' seed='${seed + 4}' result='g'/>` +
    `<feColorMatrix in='g' type='saturate' values='0' result='m'/>` +
    `<feComponentTransfer in='m'><feFuncA type='linear' slope='0.3' intercept='0'/></feComponentTransfer></filter>`;
  const charG = `<linearGradient id='charG' x1='0' y1='0' x2='1' y2='0'>` +
    `<stop offset='0' stop-color='rgb(26,21,14)'/>` +
    `<stop offset='0.5' stop-color='rgb(19,15,9)'/>` +
    `<stop offset='0.6' stop-color='rgb(11,8,6)'/>` +
    `<stop offset='0.66' stop-color='rgba(8,6,4,1)'/>` +
    `<stop offset='0.7' stop-color='rgba(6,5,4,0)'/>` +
    `<stop offset='1' stop-color='rgba(6,5,4,0)'/></linearGradient>`;
  const ca = `<linearGradient id='ca' x1='0' y1='0' x2='1' y2='0'>` +
    `<stop offset='0' stop-color='#fff'/><stop offset='0.5' stop-color='#fff'/>` +
    `<stop offset='0.6' stop-color='#000'/><stop offset='1' stop-color='#000'/></linearGradient>` +
    `<mask id='gm'><rect width='100%' height='100%' fill='url(#ca)'/></mask>`;
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>` +
    `<defs>${rag}${grain}${charG}${ca}</defs>` +
    `<g filter='url(#rag)'><rect width='100%' height='100%' fill='url(#charG)'/></g>` +
    `<g mask='url(#gm)'><rect width='100%' height='100%' filter='url(#grain)' opacity='0.22'/></g>` +
    `</svg>`);
}

/** ragged opaque band masking the ember field at the burning line */
export function emberBandURI(o: { w?: number; h?: number; seed?: number; scale?: number } = {}): string {
  const { w = 1100, h = 760, seed = 7, scale = 84 } = o;
  const rag = `<filter id='rag' x='-16%' y='-16%' width='132%' height='132%'>` +
    `<feTurbulence type='fractalNoise' baseFrequency='0.006 0.02' numOctaves='4' seed='${seed}' stitchTiles='stitch' result='n'/>` +
    `<feDisplacementMap in='SourceGraphic' in2='n' scale='${scale}' xChannelSelector='R' yChannelSelector='G' result='d'/>` +
    `<feGaussianBlur in='d' stdDeviation='2'/></filter>`;
  const bandG = `<linearGradient id='bandG' x1='0' y1='0' x2='1' y2='0'>` +
    `<stop offset='0.642' stop-color='rgba(255,255,255,0)'/>` +
    `<stop offset='0.662' stop-color='rgba(255,255,255,1)'/>` +
    `<stop offset='0.68' stop-color='rgba(255,255,255,1)'/>` +
    `<stop offset='0.70' stop-color='rgba(255,255,255,0)'/>` +
    `<stop offset='1' stop-color='rgba(255,255,255,0)'/></linearGradient>`;
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>` +
    `<defs>${rag}${bandG}</defs>` +
    `<g filter='url(#rag)'><rect width='100%' height='100%' fill='url(#bandG)'/></g></svg>`);
}

/** fixed ember bed: fractal noise through a fire palette */
export function emberFieldURI(o: { w?: number; h?: number; seed?: number } = {}): string {
  const { w = 1000, h = 760, seed = 10 } = o;
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>` +
    `<defs><filter id='fire'>` +
      `<feTurbulence type='fractalNoise' baseFrequency='0.035 0.05' numOctaves='4' seed='${seed}' stitchTiles='stitch' result='n'/>` +
      `<feColorMatrix in='n' type='saturate' values='0' result='gs'/>` +
      `<feComponentTransfer in='gs'>` +
        `<feFuncR type='table' tableValues='0 0 0.45 0.85 1 1 1'/>` +
        `<feFuncG type='table' tableValues='0 0 0 0.25 0.6 0.9 1'/>` +
        `<feFuncB type='table' tableValues='0 0 0 0 0.05 0.45 0.95'/>` +
        `<feFuncA type='table' tableValues='1 1 1 1 1 1 1'/>` +
      `</feComponentTransfer>` +
    `</filter></defs>` +
    `<rect width='100%' height='100%' filter='url(#fire)'/></svg>`);
}

/** a slab of tower stonework with a beveled inner edge. inner: 'r' or 'l'. */
export function stonePanelURI(o: { w?: number; h?: number; seed?: number; inner?: "r" | "l" } = {}): string {
  const { w = 420, h = 780, seed = 3, inner = "r" } = o;
  const grain = `<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.14 0.14' numOctaves='4' seed='${seed}' stitchTiles='stitch' result='n'/>` +
    `<feColorMatrix in='n' type='saturate' values='0' result='m'/>` +
    `<feComponentTransfer in='m'><feFuncA type='linear' slope='0.5' intercept='0'/></feComponentTransfer></filter>`;
  const base = `<linearGradient id='st' x1='0' y1='0' x2='0.2' y2='1'>` +
    `<stop offset='0' stop-color='#302c25'/><stop offset='0.5' stop-color='#221f19'/><stop offset='1' stop-color='#15120d'/></linearGradient>`;
  const bv = inner === "r"
    ? `<linearGradient id='bv' x1='0' y1='0' x2='1' y2='0'><stop offset='0.82' stop-color='rgba(0,0,0,0)'/><stop offset='0.95' stop-color='rgba(132,120,100,0.16)'/><stop offset='0.99' stop-color='rgba(0,0,0,0.45)'/><stop offset='1' stop-color='rgba(0,0,0,0.7)'/></linearGradient>`
    : `<linearGradient id='bv' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='rgba(0,0,0,0.7)'/><stop offset='0.01' stop-color='rgba(0,0,0,0.45)'/><stop offset='0.05' stop-color='rgba(132,120,100,0.16)'/><stop offset='0.18' stop-color='rgba(0,0,0,0)'/></linearGradient>`;
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>` +
    `<defs>${grain}${base}${bv}</defs>` +
    `<rect width='100%' height='100%' fill='url(#st)'/>` +
    `<rect width='100%' height='100%' filter='url(#g)' opacity='0.22'/>` +
    `<rect width='100%' height='100%' fill='url(#bv)'/>` +
    `</svg>`);
}

/** an arcane rune-circle: nested rings + tick band + pentagram + glow copy */
export function sigilURI(o: { color?: string; w?: number; h?: number } = {}): string {
  const { color = "#b48fe0", w = 600, h = 600 } = o;
  const cx = 300, cy = 300;
  let ticks = "";
  const N = 24;
  for (let i = 0; i < N; i++) {
    const a = i / N * 2 * Math.PI, r1 = 232, r2 = (i % 2 ? 246 : 253);
    ticks += `<line x1='${(cx + Math.cos(a) * r1).toFixed(1)}' y1='${(cy + Math.sin(a) * r1).toFixed(1)}' x2='${(cx + Math.cos(a) * r2).toFixed(1)}' y2='${(cy + Math.sin(a) * r2).toFixed(1)}' stroke='${color}' stroke-width='3'/>`;
  }
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / 5; pts.push([cx + Math.cos(a) * 150, cy + Math.sin(a) * 150]); }
  const poly = [0, 2, 4, 1, 3, 0].map((i) => { const p = pts[i]!; return `${p[0].toFixed(1)},${p[1].toFixed(1)}`; }).join(" ");
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>` +
    `<defs><filter id='glow' x='-30%' y='-30%' width='160%' height='160%'><feGaussianBlur stdDeviation='6'/></filter></defs>` +
    `<g fill='none' stroke='${color}' stroke-width='2.5'>` +
      `<g filter='url(#glow)' stroke-width='5' opacity='0.7'>` +
        `<circle cx='${cx}' cy='${cy}' r='258'/><circle cx='${cx}' cy='${cy}' r='210'/><polyline points='${poly}'/>` +
      `</g>` +
      `<circle cx='${cx}' cy='${cy}' r='258'/><circle cx='${cx}' cy='${cy}' r='246'/>` +
      `<circle cx='${cx}' cy='${cy}' r='210'/><circle cx='${cx}' cy='${cy}' r='150'/>` +
      `<polyline points='${poly}'/>${ticks}` +
    `</g></svg>`);
}

/** radial star-streaks emanating from centre — scaled up at runtime */
export function warpStreaksURI(o: { w?: number; h?: number; n?: number; seed?: number; color?: string } = {}): string {
  const { w = 700, h = 700, n = 130, seed = 4, color = "rgba(190,245,255," } = o;
  const cx = w / 2, cy = h / 2; let k = seed;
  const rnd = () => { k++; const v = Math.sin(k * 12.9898 + seed * 78.233) * 43758.5453; return v - Math.floor(v); };
  let lines = "";
  for (let i = 0; i < n; i++) {
    const a = rnd() * 2 * Math.PI, r0 = 40 + rnd() * 120, r1 = r0 + 120 + rnd() * 260;
    const x0 = (cx + Math.cos(a) * r0).toFixed(1), y0 = (cy + Math.sin(a) * r0).toFixed(1);
    const x1 = (cx + Math.cos(a) * r1).toFixed(1), y1 = (cy + Math.sin(a) * r1).toFixed(1);
    lines += `<line x1='${x0}' y1='${y0}' x2='${x1}' y2='${y1}' stroke='${color}${(0.25 + rnd() * 0.6).toFixed(2)})' stroke-width='${(0.6 + rnd() * 1.6).toFixed(2)}' stroke-linecap='round'/>`;
  }
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><g>${lines}</g></svg>`);
}

/** concentric rings in cyan→violet with a dark central throat */
export function vortexURI(o: { w?: number; h?: number } = {}): string {
  const { w = 700, h = 700 } = o;
  const cx = w / 2, cy = h / 2;
  const rings = [
    { r: 96, a: 0.90, sw: 7, col: "195,245,255" },
    { r: 132, a: 0.70, sw: 6, col: "155,225,255" },
    { r: 174, a: 0.55, sw: 6, col: "150,195,255" },
    { r: 222, a: 0.42, sw: 5, col: "170,175,255" },
    { r: 276, a: 0.30, sw: 5, col: "195,160,255" },
    { r: 332, a: 0.20, sw: 4, col: "205,165,255" },
  ];
  let strokes = "";
  rings.forEach((ring) => { strokes += `<circle cx='${cx}' cy='${cy}' r='${ring.r}' fill='none' stroke='rgba(${ring.col},${ring.a})' stroke-width='${ring.sw}'/>`; });
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>` +
    `<defs>` +
      `<filter id='soft' x='-20%' y='-20%' width='140%' height='140%'><feGaussianBlur stdDeviation='5'/></filter>` +
      `<radialGradient id='cglow' cx='50%' cy='50%' r='50%'>` +
        `<stop offset='0' stop-color='rgba(120,200,255,0)'/><stop offset='0.45' stop-color='rgba(110,180,255,0.1)'/><stop offset='1' stop-color='rgba(110,180,255,0)'/></radialGradient>` +
      `<radialGradient id='throat' cx='50%' cy='50%' r='50%'>` +
        `<stop offset='0' stop-color='#02030a'/><stop offset='0.16' stop-color='#02030c'/>` +
        `<stop offset='0.24' stop-color='rgba(5,7,18,0.96)'/>` +
        `<stop offset='0.42' stop-color='rgba(10,15,35,0.4)'/><stop offset='0.64' stop-color='rgba(0,0,0,0)'/></radialGradient>` +
    `</defs>` +
    `<rect width='100%' height='100%' fill='url(#cglow)'/>` +
    `<g filter='url(#soft)'>${strokes}</g>` +
    `<rect width='100%' height='100%' fill='url(#throat)'/>` +
    `</svg>`);
}
