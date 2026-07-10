import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorldCatalogEntry, WorldGenre } from "@thekeep/shared";
import { useChat } from "../../state/store.js";
import { useReducedMotion } from "../../lib/reducedMotion.js";

const ROTATE_MS = 7000;

/**
 * Splash-page world carousel, a scrying-orb framing of the open
 * worlds catalog. The orb is canvas-rendered (aura, pulse rings,
 * inner gradient, motion-keyed particles, glass rim + highlights);
 * the world's name / blurb / meta float over the center with
 * theme-aware text shadows so they stay legible against whatever
 * color is blooming inside the sphere.
 *
 * When a world has a cover image, that image is drawn as the
 * INSIDE-SPHERE background, clipped to the orb circle, cover-fit
 * to fill the diameter, with the orb effects (swirl, particles,
 * highlight, rim) layered on top so the image still reads as
 * "scryed through glass" rather than a flat hero. Without a cover
 * image the orb falls back to a theme-tinted radial gradient.
 *
 * Pauses on hover/focus, supports left/right swipe + arrow buttons
 * + indicator dots, and rotates automatically. Renders nothing when
 * the admin toggle is off (parent gates this) or the fetch returns
 * zero entries (brand-new install posture).
 */

interface Props {
  /** Client-side nav helper. When provided, "Enter this realm"
   *  pushes through the SPA router; otherwise it falls back to a
   *  full-page assignment to `/w/<slug>`. */
  onNavigate?: (path: string) => void;
}

type Motion = "storm" | "leaves" | "embers" | "ash" | "bubbles" | "wisps" | "motes" | "snow" | "sparks";

const GENRE_MOTION: Record<WorldGenre, Motion> = {
  fantasy: "wisps",
  scifi: "sparks",
  modern: "motes",
  horror: "ash",
  western: "ash",
  steampunk: "embers",
  mythological: "wisps",
  other: "motes",
};

/** Catalog keys (marketing ns) for the per-genre eyebrow line; resolved with
 *  t() at render so the copy follows the active language. */
const EYEBROW_KEY_BY_GENRE: Record<WorldGenre, string> = {
  fantasy: "featuredWorlds.eyebrow.fantasy",
  scifi: "featuredWorlds.eyebrow.scifi",
  modern: "featuredWorlds.eyebrow.modern",
  horror: "featuredWorlds.eyebrow.horror",
  western: "featuredWorlds.eyebrow.western",
  steampunk: "featuredWorlds.eyebrow.steampunk",
  mythological: "featuredWorlds.eyebrow.mythological",
  other: "featuredWorlds.eyebrow.other",
};

/** Read a `--keep-*` CSS var (space-separated RGB triple) as [r, g, b]. */
function readTriple(root: HTMLElement, name: string): [number, number, number] {
  const v = getComputedStyle(root).getPropertyValue(name).trim();
  const parts = v.split(/\s+/).map((s) => parseInt(s, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return [120, 140, 200];
  return [parts[0]!, parts[1]!, parts[2]!];
}

/** Curated jewel-tone accent pairs. Each world is mapped to one via a
 *  stable hash of its id, so cycling between worlds yields a different
 *  scrying tint each time without the orb feeling random. accent ↔
 *  accent2 is a lighter / deeper of the same hue, used as the
 *  gradient base / pulse rim / particle color. The set mirrors the
 *  MVP's curated swatches (sky / emerald / violet / coral / teal /
 *  lime / amber / indigo / tangerine). */
const WORLD_ACCENT_PALETTE: Array<{ accent: [number, number, number]; accent2: [number, number, number] }> = [
  { accent: [125, 211, 252], accent2: [56, 189, 248] },   // sky
  { accent: [134, 239, 172], accent2: [74, 222, 128] },   // emerald
  { accent: [196, 181, 253], accent2: [167, 139, 250] },  // violet
  { accent: [252, 165, 165], accent2: [248, 113, 113] },  // coral
  { accent: [94, 234, 212],  accent2: [45, 212, 191] },   // teal
  { accent: [190, 242, 100], accent2: [163, 230, 53] },   // lime
  { accent: [252, 211, 77],  accent2: [251, 191, 36] },   // amber
  { accent: [165, 180, 252], accent2: [129, 140, 248] },  // indigo
  { accent: [253, 186, 116], accent2: [251, 146, 60] },   // tangerine
];

function worldHash(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function worldAccents(id: string): { accent: [number, number, number]; accent2: [number, number, number] } {
  return WORLD_ACCENT_PALETTE[worldHash(id) % WORLD_ACCENT_PALETTE.length]!;
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function blendRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))];
}
function easeInOut(t: number) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; size: number;
}

export function FeaturedWorldsCarousel({ onNavigate }: Props) {
  const { t } = useTranslation("marketing");
  const [items, setItems] = useState<WorldCatalogEntry[] | null>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [fading, setFading] = useState(false);
  const activityFeedsEnabled = useChat((s) => s.branding.activityFeedsEnabled);
  // Reduce Motion: when on, don't auto-advance worlds and don't run the
  // perpetual canvas animation loop — draw a single static frame instead.
  // Reactive + in the relevant effect dep arrays so flipping the toggle
  // starts/stops both the rotation timer and the rAF loop immediately.
  // Manual prev/next/dots still work (they re-run the canvas effect, which
  // paints one fresh static frame for the newly-selected world).
  const reduceMotion = useReducedMotion();

  const SWIPE_THRESHOLD_PX = 40;
  const swipeStartX = useRef<number | null>(null);

  // Fetch the featured set once. Mirrors the previous component.
  useEffect(() => {
    let cancelled = false;
    fetch("/worlds/featured")
      .then((r) => (r.ok ? (r.json() as Promise<{ entries: WorldCatalogEntry[] }>) : null))
      .then((j) => { if (!cancelled && j) setItems(j.entries); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Auto-rotate. `restart` bumps when the user manually advances so
  // the timer is reset and they get the full ROTATE_MS to read.
  const restartRef = useRef(0);
  useEffect(() => {
    if (!items || items.length <= 1 || paused) return;
    // Reduce Motion: don't auto-advance; the viewer stays on the
    // current world until they use the arrows / dots / swipe.
    if (reduceMotion) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % items.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [items, paused, restartRef.current, reduceMotion]);

  // Trigger the text fade-out when the active world changes.
  // 350ms matches the transition we orchestrate in the canvas.
  useEffect(() => {
    setFading(true);
    const t = window.setTimeout(() => setFading(false), 350);
    return () => window.clearTimeout(t);
  }, [index]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Animation state lives in refs so the render-loop doesn't churn
  // React state every frame. The loop reads `currIdxRef` to know which
  // world it's drawing for; the React `index` state still drives the
  // text overlay + indicator dots.
  const currIdxRef = useRef(0);
  const prevIdxRef = useRef(0);
  const transitionTRef = useRef(1);
  const itemsRef = useRef<WorldCatalogEntry[] | null>(null);

  // Cover-image cache keyed by URL. Avoids re-fetching the bitmap
  // each time the carousel cycles back to a world. Failed loads are
  // marked with `null` so we don't retry forever.
  const imgCacheRef = useRef<Map<string, HTMLImageElement | null>>(new Map());

  useEffect(() => { itemsRef.current = items; }, [items]);

  // When the active index changes, snapshot the prev/curr for the
  // canvas crossfade and reset the transition timer.
  useEffect(() => {
    prevIdxRef.current = currIdxRef.current;
    currIdxRef.current = index;
    transitionTRef.current = 0;
  }, [index]);

  // Eagerly start loading the cover for any incoming world so the
  // bitmap is ready by the time the orb cycles to it.
  useEffect(() => {
    if (!items) return;
    for (const w of items) {
      if (!w.coverImageUrl) continue;
      const cache = imgCacheRef.current;
      if (cache.has(w.coverImageUrl)) continue;
      cache.set(w.coverImageUrl, null); // placeholder until load resolves
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      img.onload = () => { cache.set(w.coverImageUrl!, img); };
      img.onerror = () => { cache.set(w.coverImageUrl!, null); };
      img.src = w.coverImageUrl;
    }
  }, [items]);

  // The render loop. Starts once when the canvas is in the DOM
  // (which only happens after items resolves with entries, the
  // early-return below gates the section). The loop reads refs so
  // it picks up theme + index changes without needing to restart.
  const hasItems = items !== null && items.length > 0;
  // Static-repaint trigger. When Reduce Motion is OFF this is a constant,
  // so the perpetual rAF loop is started exactly once (no behavior change —
  // it keeps drawing every world change via its refs). When Reduce Motion
  // is ON the loop is a one-shot static frame, so we re-run the effect on
  // each `index` change to repaint the newly-selected world's static frame.
  const staticFrameKey = reduceMotion ? index : 0;
  useEffect(() => {
    if (!hasItems) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    // orbR 320 inside a 900×900 canvas, combined with a slightly
    // tighter aura factor (1.4× instead of 1.6×) so 1.4 * 320 = 448
    // still fits inside the 450px half-width and the glow renders
    // fully without the rectangular clip. Bumped up from 280 so the
    // visible orb (~320 CSS px) comfortably wraps multi-line titles
    // like "The Thrice-Crowned Realm" without the corners of the
    // text block breaking past the circle.
    const orbR = 320;
    const AURA_OUTER_RATIO = 1.4;
    const TEXT_RADIUS = orbR * 0.55;

    let raf = 0;
    let time = 0;
    let particles: Particle[] = [];
    let orbits: Array<{ angle: number; speed: number; tilt: number; radius: number; size: number }> = [];

    function spawnParticle(motion: Motion, randomStart: boolean): Particle {
      const angle = Math.random() * Math.PI * 2;
      const r = TEXT_RADIUS + Math.random() * (orbR * 0.85 - TEXT_RADIUS);
      const p: Particle = {
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
        vx: 0, vy: 0,
        life: randomStart ? Math.random() : 0,
        maxLife: 1,
        size: 1 + Math.random() * 1.8,
      };
      switch (motion) {
        case "storm":   p.vx = (Math.random() - 0.5) * 0.9;  p.vy = (Math.random() - 0.5) * 0.9; break;
        case "leaves":  p.vx = (Math.random() - 0.5) * 0.3;  p.vy = -0.2 - Math.random() * 0.25; p.size = 1.5 + Math.random() * 1.5; break;
        case "embers":  p.vx = (Math.random() - 0.5) * 0.25; p.vy = -0.35 - Math.random() * 0.4; break;
        case "ash":     p.vx = (Math.random() - 0.5) * 0.18; p.vy = 0.25 + Math.random() * 0.3; break;
        case "bubbles": p.vx = (Math.random() - 0.5) * 0.12; p.vy = -0.25 - Math.random() * 0.4; p.size = 1.5 + Math.random() * 2; break;
        case "wisps":   p.vx = (Math.random() - 0.5) * 0.25; p.vy = (Math.random() - 0.5) * 0.25; p.size = 1.5 + Math.random() * 2; break;
        case "motes":   p.vx = (Math.random() - 0.5) * 0.2;  p.vy = (Math.random() - 0.5) * 0.2; break;
        case "snow":    p.vx = (Math.random() - 0.5) * 0.18; p.vy = 0.18 + Math.random() * 0.3;  p.size = 1.2 + Math.random() * 1.5; break;
        case "sparks":  p.vx = (Math.random() - 0.5) * 0.6;  p.vy = (Math.random() - 0.5) * 0.6;  p.size = 0.8 + Math.random() * 1.2; break;
      }
      return p;
    }

    function reseed(motion: Motion) {
      particles = [];
      for (let i = 0; i < 22; i++) particles.push(spawnParticle(motion, true));
      orbits = [];
      for (let i = 0; i < 2; i++) {
        orbits.push({
          angle: Math.random() * Math.PI * 2,
          speed: 0.003 + Math.random() * 0.003,
          tilt: Math.random() * Math.PI,
          radius: orbR * (0.75 + Math.random() * 0.15),
          size: 2.5 + Math.random() * 3,
        });
      }
    }

    let lastMotion: Motion = "wisps";
    reseed(lastMotion);

    // Helper: draw a cover image clipped to the orb, scaled to fill
    // the orb's bounding square ("object-fit: cover" equivalent).
    function drawCover(img: HTMLImageElement, alpha: number) {
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      if (!iw || !ih) return;
      const diameter = orbR * 2;
      // cover-fit: scale so the SHORTER side fills the diameter; the
      // longer side gets cropped equally on both ends.
      const scale = Math.max(diameter / iw, diameter / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const dx = cx - dw / 2;
      const dy = cy - dh / 2;
      ctx!.globalAlpha = alpha;
      ctx!.drawImage(img, dx, dy, dw, dh);
      ctx!.globalAlpha = 1;
    }

    function render() {
      const items = itemsRef.current;
      const curr = items && items.length > 0 ? items[Math.min(currIdxRef.current, items.length - 1)]! : null;
      const prev = items && items.length > 0 ? items[Math.min(prevIdxRef.current, items.length - 1)]! : null;

      // Theme palette as fallback (only used when there's no
      // active world, e.g. while the initial fetch is in flight).
      // When a world is active, accent + accent2 come from the
      // curated jewel-tone palette indexed by the world's id hash
      // so each scrying surfaces a different tint.
      const root = document.documentElement;
      const accentBase = readTriple(root, "--keep-accent");
      const actionBase = readTriple(root, "--keep-action");

      const currPair = curr ? worldAccents(curr.id) : { accent: accentBase, accent2: actionBase };
      const prevPair = prev ? worldAccents(prev.id) : { accent: accentBase, accent2: actionBase };
      const currAccent = currPair.accent;
      const currAccent2 = currPair.accent2;
      const prevAccent = prevPair.accent;
      const prevAccent2 = prevPair.accent2;

      const tEase = easeInOut(transitionTRef.current);
      const [ar, ag, ab] = blendRgb(prevAccent, currAccent, tEase);
      const [ar2, ag2, ab2] = blendRgb(prevAccent2, currAccent2, tEase);

      time += 1;
      ctx!.clearRect(0, 0, W, H);

      // Outer aura, sized so the radial reach stays inside the
      // canvas half-width and the glow fades to alpha=0 well before
      // the canvas edge. Two-pass: a bright accent halo right at
      // the orb's edge, then a softer falloff out to the full
      // aura radius. The doubled-up alpha gives the orb the
      // "scrying crystal lit from within" feel.
      const auraOuter = orbR * AURA_OUTER_RATIO;
      // Outer falloff
      const auraGrad = ctx!.createRadialGradient(cx, cy, orbR * 0.85, cx, cy, auraOuter);
      auraGrad.addColorStop(0, `rgba(${ar},${ag},${ab},0.45)`);
      auraGrad.addColorStop(0.4, `rgba(${ar},${ag},${ab},0.20)`);
      auraGrad.addColorStop(0.75, `rgba(${ar},${ag},${ab},0.07)`);
      auraGrad.addColorStop(1, `rgba(${ar},${ag},${ab},0)`);
      ctx!.fillStyle = auraGrad;
      ctx!.beginPath();
      ctx!.arc(cx, cy, auraOuter, 0, Math.PI * 2);
      ctx!.fill();
      // Hot inner halo right at the orb edge so the sphere reads as
      // "lit from within" rather than a flat disc sitting in front
      // of a soft mist. Tight gradient, high opacity at start.
      const haloGrad = ctx!.createRadialGradient(cx, cy, orbR * 0.92, cx, cy, orbR * 1.12);
      haloGrad.addColorStop(0, `rgba(${ar},${ag},${ab},0.55)`);
      haloGrad.addColorStop(1, `rgba(${ar},${ag},${ab},0)`);
      ctx!.fillStyle = haloGrad;
      ctx!.beginPath();
      ctx!.arc(cx, cy, orbR * 1.12, 0, Math.PI * 2);
      ctx!.fill();

      // Pulse rings
      for (let k = 0; k < 2; k++) {
        const pulse = ((time * 0.5 + k * 80) % 200) / 200;
        const pr = orbR + pulse * 60;
        const palpha = (1 - pulse) * 0.22;
        ctx!.strokeStyle = `rgba(${ar},${ag},${ab},${palpha})`;
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.arc(cx, cy, pr, 0, Math.PI * 2);
        ctx!.stroke();
      }

      ctx!.save();
      ctx!.beginPath();
      ctx!.arc(cx, cy, orbR, 0, Math.PI * 2);
      ctx!.closePath();
      ctx!.clip();

      // Inside the orb: cover image if present, then orb effects on top.
      // When a transition is in flight, crossfade prev → curr image.
      const cache = imgCacheRef.current;
      const currImg = curr?.coverImageUrl ? cache.get(curr.coverImageUrl) ?? null : null;
      const prevImg = prev?.coverImageUrl ? cache.get(prev.coverImageUrl) ?? null : null;

      // Base gradient, used both as the no-image fallback AND as a
      // tinted backdrop behind the image (so themed color shows in
      // any transparent regions of the cover art).
      const baseGrad = ctx!.createRadialGradient(cx, cy, 0, cx, cy, orbR);
      baseGrad.addColorStop(0, `rgba(${Math.floor(ar2 * 0.25)},${Math.floor(ag2 * 0.25)},${Math.floor(ab2 * 0.25)},0.85)`);
      baseGrad.addColorStop(0.4, `rgba(${Math.floor(ar2 * 0.5)},${Math.floor(ag2 * 0.5)},${Math.floor(ab2 * 0.5)},0.55)`);
      baseGrad.addColorStop(0.75, `rgba(${ar2},${ag2},${ab2},0.3)`);
      baseGrad.addColorStop(1, `rgba(10,15,30,0.6)`);
      ctx!.fillStyle = baseGrad;
      ctx!.fillRect(cx - orbR, cy - orbR, orbR * 2, orbR * 2);

      if (prevImg && tEase < 1) drawCover(prevImg, 1 - tEase);
      if (currImg) drawCover(currImg, tEase);

      // Inner swirling clouds, accent-tinted, kept toward the rim
      for (let c = 0; c < 3; c++) {
        const t2 = time * 0.005 + c * 2.0;
        const swx = cx + Math.cos(t2) * orbR * 0.55;
        const swy = cy + Math.sin(t2 * 1.3) * orbR * 0.55;
        const swr = orbR * 0.4;
        const swGrad = ctx!.createRadialGradient(swx, swy, 0, swx, swy, swr);
        swGrad.addColorStop(0, `rgba(${ar},${ag},${ab},0.14)`);
        swGrad.addColorStop(1, `rgba(${ar},${ag},${ab},0)`);
        ctx!.fillStyle = swGrad;
        ctx!.fillRect(cx - orbR, cy - orbR, orbR * 2, orbR * 2);
      }

      // Particle motion follows the current world's genre.
      const desiredMotion: Motion = curr ? (GENRE_MOTION[curr.genre] ?? "wisps") : "wisps";
      if (desiredMotion !== lastMotion) {
        lastMotion = desiredMotion;
        reseed(desiredMotion);
      }
      // Tick particles
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]!;
        p.x += p.vx; p.y += p.vy;
        const dx = p.x - cx;
        const dy = p.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < TEXT_RADIUS) {
          const a = Math.atan2(dy, dx);
          p.x = cx + Math.cos(a) * TEXT_RADIUS;
          p.y = cy + Math.sin(a) * TEXT_RADIUS;
          p.vx = Math.cos(a) * Math.abs(p.vx);
          p.vy = Math.sin(a) * Math.abs(p.vy);
        }
        if (dist > orbR * 0.9) {
          const a = Math.atan2(dy, dx);
          p.x = cx + Math.cos(a) * orbR * 0.88;
          p.y = cy + Math.sin(a) * orbR * 0.88;
          p.vx *= -0.5; p.vy *= -0.5;
        }
        p.life += 0.005;
        if (p.life >= p.maxLife) particles[i] = spawnParticle(lastMotion, false);
      }
      for (const p of particles) {
        const alpha = Math.sin(p.life * Math.PI) * 0.75;
        ctx!.fillStyle = `rgba(${ar},${ag},${ab},${alpha})`;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx!.fill();
      }

      // Orbiting energy points, accent-tinted, near rim
      for (const o of orbits) {
        o.angle += o.speed;
        const ox = cx + Math.cos(o.angle) * o.radius * Math.cos(o.tilt);
        const oy = cy + Math.sin(o.angle) * o.radius;
        const og = ctx!.createRadialGradient(ox, oy, 0, ox, oy, o.size * 4);
        og.addColorStop(0, `rgba(255,255,255,0.75)`);
        og.addColorStop(0.3, `rgba(${ar},${ag},${ab},0.5)`);
        og.addColorStop(1, `rgba(${ar},${ag},${ab},0)`);
        ctx!.fillStyle = og;
        ctx!.beginPath();
        ctx!.arc(ox, oy, o.size * 4, 0, Math.PI * 2);
        ctx!.fill();
      }

      // Center darkening vignette, text legibility. Slightly stronger
      // when an image is shown so bright covers don't bleed the title.
      const vignetteAlpha = currImg ? 0.5 : 0.35;
      const vignette = ctx!.createRadialGradient(cx, cy, 0, cx, cy, TEXT_RADIUS * 1.1);
      vignette.addColorStop(0, `rgba(0,0,0,${vignetteAlpha})`);
      vignette.addColorStop(1, "rgba(0,0,0,0)");
      ctx!.fillStyle = vignette;
      ctx!.fillRect(cx - orbR, cy - orbR, orbR * 2, orbR * 2);

      // Top-left glass highlight
      const hlGrad = ctx!.createRadialGradient(cx - orbR * 0.4, cy - orbR * 0.45, 0, cx - orbR * 0.4, cy - orbR * 0.45, orbR * 0.6);
      hlGrad.addColorStop(0, "rgba(255,255,255,0.3)");
      hlGrad.addColorStop(0.5, "rgba(255,255,255,0.07)");
      hlGrad.addColorStop(1, "rgba(255,255,255,0)");
      ctx!.fillStyle = hlGrad;
      ctx!.fillRect(cx - orbR, cy - orbR, orbR * 2, orbR * 2);

      // Bottom rim shadow
      const rimGrad = ctx!.createRadialGradient(cx + orbR * 0.2, cy + orbR * 0.4, orbR * 0.3, cx, cy, orbR);
      rimGrad.addColorStop(0, "rgba(0,0,0,0)");
      rimGrad.addColorStop(1, "rgba(0,0,0,0.35)");
      ctx!.fillStyle = rimGrad;
      ctx!.fillRect(cx - orbR, cy - orbR, orbR * 2, orbR * 2);

      ctx!.restore();

      // Glass rim
      ctx!.strokeStyle = `rgba(${ar},${ag},${ab},0.4)`;
      ctx!.lineWidth = 1.5;
      ctx!.beginPath();
      ctx!.arc(cx, cy, orbR, 0, Math.PI * 2);
      ctx!.stroke();

      ctx!.strokeStyle = "rgba(255,255,255,0.15)";
      ctx!.lineWidth = 1;
      ctx!.beginPath();
      ctx!.arc(cx, cy, orbR - 2, 0, Math.PI * 2);
      ctx!.stroke();

      // Specular dot
      ctx!.fillStyle = "rgba(255,255,255,0.6)";
      ctx!.beginPath();
      ctx!.arc(cx - orbR * 0.55, cy - orbR * 0.55, 6, 0, Math.PI * 2);
      ctx!.fill();

      if (transitionTRef.current < 1) {
        // Reduce Motion: snap the crossfade straight to the current
        // world (no animated transition) instead of stepping it.
        transitionTRef.current = reduceMotion ? 1 : Math.min(1, transitionTRef.current + 0.018);
      }

      // Reduce Motion: this is a one-shot static frame — do NOT schedule
      // another animation frame, so the perpetual decorative loop stops.
      // (A manual prev/next/dot changes `index`, which re-runs this effect
      // and paints a fresh static frame for the new world.)
      if (reduceMotion) return;
      raf = requestAnimationFrame(render);
    }
    raf = requestAnimationFrame(render);
    return () => { cancelAnimationFrame(raf); };
  }, [hasItems, reduceMotion, staticFrameKey]);

  if (!items || items.length === 0) return null;
  const active = items[Math.min(index, items.length - 1)]!;

  function advance(delta: 1 | -1) {
    if (!items || items.length <= 1) return;
    setIndex((i) => (i + delta + items.length) % items.length);
    restartRef.current += 1;
  }

  function enter() {
    const path = `/w/${encodeURIComponent(active.slug)}`;
    if (onNavigate) onNavigate(path);
    else window.location.href = path;
  }

  const eyebrowKey = EYEBROW_KEY_BY_GENRE[active.genre];
  const eyebrow = eyebrowKey ? t(eyebrowKey) : undefined;
  const fadingCls = fading ? " orb-text-fading" : "";

  return (
    <section
      aria-label={t("featuredWorlds.sectionAria")}
      className="orb-section select-none"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onPointerDown={(e) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        swipeStartX.current = e.clientX;
      }}
      onPointerUp={(e) => {
        const start = swipeStartX.current;
        swipeStartX.current = null;
        if (start === null) return;
        const dx = e.clientX - start;
        if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
        advance(dx > 0 ? -1 : 1);
      }}
      onPointerCancel={() => { swipeStartX.current = null; }}
      style={{ touchAction: "pan-y" }}
    >
      <header className="orb-section-header">
        <div className="orb-section-rule" aria-hidden>
          <span className="line" />
          <span className="diamond" />
          <span className="line" />
        </div>
        <h3 className="orb-section-title font-action">{t("featuredWorlds.orbTitle")}</h3>
        <p className="orb-section-subtitle">{t("featuredWorlds.orbSubtitle")}</p>
      </header>

      <div className="orb-stage">
        {items.length > 1 ? (
          <button
            type="button"
            aria-label={t("featuredWorlds.previous")}
            className="orb-arrow orb-arrow-left"
            onClick={() => advance(-1)}
          >
            <ChevronIcon direction="left" />
          </button>
        ) : null}

        {/* The sphere itself is the link target, clicking anywhere
            on the orb (canvas or text overlay) navigates to the
            active world. Keyboard support: tab to focus, Enter or
            Space to activate. The previous "Enter this realm" CTA
            button below has been removed; the orb's clickability is
            communicated by `cursor: pointer` + a hover brightness
            lift in CSS. */}
        <div
          className="orb-wrap"
          role="button"
          tabIndex={0}
          aria-label={t("featuredWorlds.enterAria", { name: active.name })}
          onClick={enter}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              enter();
            }
          }}
        >
          <canvas
            ref={canvasRef}
            width={900}
            height={900}
            className="orb-canvas"
            aria-hidden
          />
          <div className="orb-content">
            <p className={`orb-text orb-eyebrow${fadingCls}`}>{eyebrow}</p>
            <h3 className={`orb-text orb-title font-action${fadingCls}`}>{active.name}</h3>
            <p className={`orb-text orb-desc${fadingCls}`}>
              {active.description ?? t("featuredWorlds.toldInPages", { count: active.pageCount })}
            </p>
            <p className={`orb-text orb-meta${fadingCls}`}>
              {t("featuredWorlds.pagesBy", { count: active.pageCount, name: active.ownerUsername })}
              {activityFeedsEnabled && active.memberCount > 0 ? (
                <> · {t("featuredWorlds.members", { count: active.memberCount })}</>
              ) : null}
            </p>
          </div>
        </div>

        {items.length > 1 ? (
          <button
            type="button"
            aria-label={t("featuredWorlds.next")}
            className="orb-arrow orb-arrow-right"
            onClick={() => advance(1)}
          >
            <ChevronIcon direction="right" />
          </button>
        ) : null}
      </div>

      {items.length > 1 ? (
        <div className="orb-indicators" role="tablist" aria-label={t("featuredWorlds.controlsAria")}>
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={t("featuredWorlds.dotAria", { index: i + 1, total: items.length, name: it.name })}
              onClick={() => { setIndex(i); restartRef.current += 1; }}
              className={`orb-dot${i === index ? " orb-dot-active" : ""}`}
            />
          ))}
        </div>
      ) : null}

    </section>
  );
}

/** Chevron icon for the orb's prev / next buttons. SVG instead of a
 *  unicode glyph (`‹` / `›`) because text-based chevrons sit at the
 *  baseline of a font's line-box, which doesn't visually center
 *  inside a round button, they always render a hair high. An SVG
 *  with a centered viewBox centers cleanly via the button's flex
 *  alignment. */
function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 12 18"
      width="12"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {direction === "left" ? (
        <polyline points="8.5,3 3.5,9 8.5,15" />
      ) : (
        <polyline points="3.5,3 8.5,9 3.5,15" />
      )}
    </svg>
  );
}
