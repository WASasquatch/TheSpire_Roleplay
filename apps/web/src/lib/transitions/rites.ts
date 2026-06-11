/**
 * The room-transition "rites" — ported near-verbatim from the
 * spire-transitions.html demo. Each rite animates `content` (the cloned chat
 * surface) and `fx` (an overlay layer) and calls `swap()` at its obscured
 * midpoint. The orchestrator sets `stage`/`content`/`fx` via `setRiteCtx`
 * before each run (only one transition plays at a time, so module-level
 * mutable context is safe) and owns cleanup afterwards.
 *
 * `anim`/`wait`/`rand`/`raf`/`layer` are the demo's tiny helpers; `Math.random`
 * and `performance.now()` are fine here (this is browser UI, not a workflow).
 */
import {
  burnSheet, cloudBG, coronaRaysURI, emberBandURI, emberFieldURI, inkBlobURI,
  monoNoiseURI, runeRingURI, sigilURI, starsURI, stonePanelURI, vortexURI,
  warpStreaksURI, wispURI,
} from "./svg.js";

let stage: HTMLElement;
let content: HTMLElement;
let fx: HTMLElement;

/** Set the run context. Called by the orchestrator before each rite. */
export function setRiteCtx(s: HTMLElement, c: HTMLElement, f: HTMLElement): void {
  stage = s; content = c; fx = f;
}

const wait = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function anim(node: Element, frames: Keyframe[], opts: KeyframeAnimationOptions): Animation {
  return node.animate(frames, { fill: "both", ...opts });
}

function raf(duration: number, onFrame: (p: number) => void): Promise<void> {
  return new Promise<void>((res) => {
    const start = performance.now();
    const loop = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      onFrame(p);
      if (p < 1) requestAnimationFrame(loop); else res();
    };
    requestAnimationFrame(loop);
  });
}

/** Small overlay factory (defaults: full cover, no pointer events). */
function layer(styles: Record<string, string> = {}): HTMLElement {
  const d = document.createElement("div");
  const all: Record<string, string> = { position: "absolute", inset: "0", pointerEvents: "none", ...styles };
  const s = d.style as unknown as Record<string, string>;
  for (const [k, v] of Object.entries(all)) s[k] = v;
  fx.appendChild(d);
  return d;
}

export interface RiteCtx { swap: () => void; }
export interface Rite { run(ctx: RiteCtx): Promise<void>; }

export const RITES: Record<string, Rite> = {
  /* —— Dimensional Slide —— */
  slide: {
    async run({ swap }) {
      content.style.willChange = "transform,opacity,filter";
      const sweep = layer({ background: "linear-gradient(105deg, transparent 32%, rgba(255,250,235,.055) 50%, transparent 68%)",
        transform: "translateX(-130%)", mixBlendMode: "screen" });
      await anim(content,
        [{ transform: "translateX(0) scale(1)", opacity: 1, filter: "blur(0)" },
         { transform: "translateX(-7%) scale(.985)", opacity: 0, filter: "blur(6px)" }],
        { duration: 340, easing: "cubic-bezier(.55,0,.5,1)" }).finished;
      swap();
      anim(sweep, [{ transform: "translateX(-130%)" }, { transform: "translateX(130%)" }], { duration: 540, easing: "cubic-bezier(.3,.4,.3,1)" });
      await anim(content,
        [{ transform: "translateX(7%) scale(.985)", opacity: 0, filter: "blur(6px)" },
         { transform: "translateX(-.5%) scale(1.002)", opacity: 1, filter: "blur(0)", offset: .82 },
         { transform: "translateX(0) scale(1)", opacity: 1, filter: "blur(0)" }],
        { duration: 470, easing: "cubic-bezier(.2,.7,.25,1)" }).finished;
    },
  },

  /* —— Page Turn —— */
  page: {
    async run({ swap }) {
      content.style.transformOrigin = "50% 50%";
      content.style.willChange = "transform";
      const shade = layer({ background: "linear-gradient(100deg, rgba(0,0,0,.05) 15%, rgba(0,0,0,.78))", opacity: "0" });
      const sheen = layer({ background: "linear-gradient(100deg, transparent 34%, rgba(255,244,216,.09) 50%, transparent 66%)",
        transform: "translateX(-130%)", mixBlendMode: "screen" });
      const a1 = anim(content, [{ transform: "rotateY(0deg) scale(1)" }, { transform: "rotateY(-90deg) scale(.955)" }],
        { duration: 340, easing: "cubic-bezier(.45,0,.95,.4)" });
      anim(shade, [{ opacity: 0 }, { opacity: .8 }], { duration: 340 });
      await a1.finished;
      swap();
      content.style.transform = "rotateY(90deg) scale(.955)";
      const a2 = anim(content, [{ transform: "rotateY(90deg) scale(.955)" }, { transform: "rotateY(0deg) scale(1)" }],
        { duration: 390, easing: "cubic-bezier(.2,.75,.35,1)" });
      anim(shade, [{ opacity: .8 }, { opacity: 0 }], { duration: 390 });
      anim(sheen, [{ transform: "translateX(-130%)" }, { transform: "translateX(130%)" }], { duration: 430, easing: "ease-out" });
      await a2.finished;
    },
  },

  /* —— Television —— */
  tv: {
    async run({ swap }) {
      content.style.transformOrigin = "50% 50%";
      content.style.willChange = "transform,filter";
      const scan = layer({ background: "repeating-linear-gradient(0deg, rgba(0,0,0,.0) 0px, rgba(0,0,0,.45) 1px, rgba(0,0,0,0) 3px)",
        opacity: "0", mixBlendMode: "multiply" });
      const tint = layer({ background: "radial-gradient(120% 90% at 50% 50%, rgba(120,255,200,.06), rgba(0,0,0,.0) 60%)", opacity: "0" });
      const staticy = layer({ backgroundImage: monoNoiseURI({ freq: 0.9, oct: 2, seed: 17, slope: 0.9 }),
        backgroundSize: "180px 180px", mixBlendMode: "screen", opacity: "0" });
      const line = layer({ top: "50%", bottom: "auto", left: "0", right: "0", height: "3px", transform: "translateY(-50%) scaleX(.2)",
        background: "#fff", boxShadow: "0 0 26px 6px rgba(255,255,255,.9)", opacity: "0", borderRadius: "2px" });
      await Promise.all([
        anim(scan, [{ opacity: 0 }, { opacity: .7 }], { duration: 200 }).finished,
        anim(tint, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 }).finished,
        anim(staticy, [{ opacity: 0 }, { opacity: .14 }], { duration: 200 }).finished,
      ]);
      anim(staticy, [{ opacity: .14 }, { opacity: .06 }, { opacity: .12 }], { duration: 130, iterations: Infinity });
      const collapse = anim(content,
        [{ transform: "scaleY(1)", filter: "brightness(1) contrast(1)" },
         { transform: "scaleY(.004)", filter: "brightness(2.6) contrast(1.3)" }],
        { duration: 260, easing: "cubic-bezier(.7,0,.84,.3)" });
      anim(line, [{ opacity: 0, transform: "translateY(-50%) scaleX(.2)" },
                  { opacity: 0, offset: .55 },
                  { opacity: 1, transform: "translateY(-50%) scaleX(1)" }], { duration: 260 });
      await collapse.finished;
      content.style.opacity = "0"; swap();
      await anim(line, [{ opacity: 1, transform: "translateY(-50%) scaleX(1)" },
                        { opacity: 1, transform: "translateY(-50%) scaleX(.02)", offset: .8 },
                        { opacity: 0, transform: "translateY(-50%) scaleX(.012)" }],
        { duration: 190, easing: "cubic-bezier(.55,0,.8,.45)" }).finished;
      await wait(110);
      await anim(line, [{ opacity: 0, transform: "translateY(-50%) scaleX(.012)" },
                        { opacity: 1, transform: "translateY(-50%) scaleX(.02)", offset: .35 },
                        { opacity: 1, transform: "translateY(-50%) scaleX(1)" }],
        { duration: 170, easing: "cubic-bezier(.2,.6,.3,1)" }).finished;
      content.style.opacity = "1";
      const expand = anim(content,
        [{ transform: "scaleY(.004)", filter: "brightness(2.6)" },
         { transform: "scaleY(1)", filter: "brightness(1)" }],
        { duration: 300, easing: "cubic-bezier(.12,.7,.3,1)" });
      anim(line, [{ opacity: 1, transform: "translateY(-50%) scaleX(1)" }, { opacity: 0, transform: "translateY(-50%) scaleX(.2)" }], { duration: 200 });
      anim(scan, [{ opacity: .7 }, { opacity: 0 }], { duration: 260, delay: 120 });
      anim(tint, [{ opacity: 1 }, { opacity: 0 }], { duration: 260, delay: 120 });
      anim(staticy, [{ opacity: .12 }, { opacity: 0 }], { duration: 260, delay: 120 });
      await expand.finished;
    },
  },

  /* —— Tech Glitch —— */
  glitch: {
    async run({ swap }) {
      content.style.willChange = "transform,filter";
      const red = layer({ background: "rgba(255,40,80,.0)", mixBlendMode: "screen" });
      const cyan = layer({ background: "rgba(40,220,255,.0)", mixBlendMode: "screen" });
      const accent = getComputedStyle(stage).getPropertyValue("--accent").trim() || "#b8a06a";
      const palette = ["#39e7ff", "#ff3ca0", "#9b7bff", accent];
      const bars: HTMLElement[] = [];
      for (let i = 0; i < 6; i++) {
        const top = rand(4, 90), h = rand(3, 10);
        const c = palette[Math.floor(Math.random() * palette.length)] ?? accent;
        const a = Math.floor(rand(26, 56)).toString(16).padStart(2, "0");
        bars.push(layer({ top: top + "%", height: h + "%", left: "0", right: "0", background: c + a, mixBlendMode: "screen", opacity: "0" }));
      }
      const sync = layer({ left: "0", right: "0", top: "0", bottom: "auto", height: "20%",
        background: "linear-gradient(180deg, transparent, rgba(180,225,255,.06) 40%, rgba(0,0,0,.2) 56%, transparent)",
        mixBlendMode: "overlay", transform: "translateY(-110%)" });
      anim(sync, [{ transform: "translateY(-110%)" }, { transform: "translateY(560%)" }], { duration: 430, iterations: Infinity, easing: "linear" });
      const phase = (dur: number, settle: boolean) => {
        const kf: Keyframe[] = [{ filter: "none", transform: "translateX(0)" }];
        const n = 7;
        for (let i = 1; i < n; i++) {
          const o = i / n;
          const heavy = !settle || o < 0.5;
          kf.push({
            offset: o,
            filter: i === 2 ? "invert(1) hue-rotate(180deg) brightness(1.12)"
              : `brightness(${heavy ? rand(.55, 1.4).toFixed(2) : rand(.92, 1.1).toFixed(2)}) saturate(${heavy ? rand(.4, 2.6).toFixed(2) : "1.2"}) hue-rotate(${heavy ? Math.round(rand(-40, 40)) : 0}deg) contrast(${heavy ? rand(1, 1.9).toFixed(2) : "1"})`,
            transform: `translateX(${heavy ? rand(-9, 9).toFixed(1) : "0"}px) skewX(${heavy ? rand(-2.5, 2.5).toFixed(1) : "0"}deg)`,
          });
        }
        kf.push({ filter: "none", transform: "translateX(0)" });
        return anim(content, kf, { duration: dur, easing: "steps(" + (n + 1) + ")" });
      };
      const jitterBars = (dur: number) => bars.forEach((b) => anim(b,
        [{ opacity: 0, transform: "translateX(0)" },
         { opacity: rand(.4, 1), transform: `translateX(${rand(-30, 30)}px)`, offset: rand(.2, .5) },
         { opacity: 0, transform: `translateX(${rand(-20, 20)}px)` }],
        { duration: dur, easing: "steps(5)" }));
      const fringe = (dur: number) => {
        anim(red, [{ opacity: 0, transform: "translateX(0)" }, { opacity: .5, transform: "translateX(-5px)", offset: .4 }, { opacity: 0, transform: "translateX(-3px)" }], { duration: dur, easing: "steps(6)" });
        anim(cyan, [{ opacity: 0, transform: "translateX(0)" }, { opacity: .5, transform: "translateX(5px)", offset: .4 }, { opacity: 0, transform: "translateX(3px)" }], { duration: dur, easing: "steps(6)" });
      };
      fringe(380); jitterBars(380);
      await phase(380, false).finished;
      swap();
      fringe(420); jitterBars(420);
      await phase(420, true).finished;
    },
  },

  /* —— Shadow Veil —— */
  veil: {
    async run({ swap }) {
      const veil = layer({
        top: "-15%", bottom: "-15%",
        background: "radial-gradient(140% 60% at 20% 8%, rgba(123,162,255,.18), transparent 55%)," +
          "radial-gradient(120% 50% at 85% 4%, rgba(180,143,224,.16), transparent 55%)," +
          "linear-gradient(180deg,#06050b 60%,#0b0a14 100%)",
        transform: "translateY(-104%)",
        boxShadow: "0 24px 60px -10px rgba(123,162,255,.25)",
        willChange: "transform",
      });
      veil.style.maskImage = veil.style.webkitMaskImage = "linear-gradient(180deg, transparent 0, #000 8%, #000 92%, transparent 100%)";
      const twinkle = document.createElement("div");
      Object.assign(twinkle.style, { position: "absolute", inset: "0", opacity: ".7",
        backgroundImage: starsURI(95, 660, 540, 21), backgroundSize: "cover", backgroundRepeat: "no-repeat", mixBlendMode: "screen" });
      veil.appendChild(twinkle);
      anim(twinkle, [{ opacity: .45 }, { opacity: .9 }, { opacity: .5 }], { duration: 1400, iterations: Infinity });
      const twinkle2 = document.createElement("div");
      Object.assign(twinkle2.style, { position: "absolute", inset: "0", opacity: ".45",
        backgroundImage: starsURI(150, 660, 540, 47), backgroundSize: "cover", backgroundRepeat: "no-repeat", mixBlendMode: "screen" });
      veil.appendChild(twinkle2);
      anim(twinkle2, [{ transform: "translateY(0)", opacity: .3 }, { transform: "translateY(14px)", opacity: .6 }],
        { duration: 2600, iterations: Infinity, direction: "alternate", easing: "ease-in-out" });
      const aurora = document.createElement("div");
      Object.assign(aurora.style, { position: "absolute", inset: "0", mixBlendMode: "screen",
        background: "linear-gradient(118deg, transparent 20%, rgba(123,162,255,.12) 42%, rgba(180,143,224,.12) 58%, transparent 80%)" });
      veil.appendChild(aurora);
      anim(aurora, [{ transform: "translateX(-18%)" }, { transform: "translateX(18%)" }],
        { duration: 3000, iterations: Infinity, direction: "alternate", easing: "ease-in-out" });
      await anim(veil, [{ transform: "translateY(-104%)" }, { transform: "translateY(0%)" }],
        { duration: 560, easing: "cubic-bezier(.5,0,.18,1)" }).finished;
      swap(); await wait(150);
      await anim(veil, [{ transform: "translateY(0%)" }, { transform: "translateY(104%)" }],
        { duration: 600, easing: "cubic-bezier(.62,0,.3,1)" }).finished;
    },
  },

  /* —— War Fog —— */
  fog: {
    async run({ swap }) {
      const dark = layer({ background: "linear-gradient(180deg, rgba(20,21,27,.72), rgba(10,11,15,.82))", opacity: "0" });
      const centre: Array<{ d: HTMLElement; op: number; drift: number }> = [];
      const mkCentre = (seed: number, freq: number, blur: number, op: number, drift: number) => {
        const bg = cloudBG({ freq, oct: 3, seed, w: 520, h: 480, blur, slope: 1.45, intercept: 0.12,
          light: "rgba(150,154,168,0.97)", dark: "rgba(50,53,66,0.98)" });
        const d = layer({ inset: "-16%", backgroundImage: bg, backgroundSize: "cover", backgroundRepeat: "no-repeat",
          opacity: "0", transform: "translateX(0)", willChange: "opacity,transform" });
        centre.push({ d, op, drift });
      };
      mkCentre(31, 0.010, 12, 0.95, -3);
      mkCentre(53, 0.015, 16, 0.85, 4);
      const banks: Array<{ d: HTMLElement; coverX: number; startX: number; depth: number; side: number }> = [];
      const mkBank = (side: number, depth: number) => {
        const freq = Number((0.009 + depth * 0.005).toFixed(4));
        const bg = cloudBG({ freq, oct: 3, seed: depth * 9 + (side < 0 ? 2 : 6), w: 460, h: 560,
          fade: side < 0 ? "l" : "r", blur: 8 + depth * 4, slope: 1.35, intercept: 0.05,
          light: "rgba(146,150,164,0.96)", dark: "rgba(48,51,64,0.98)" });
        const startX = side < 0 ? -128 : 128;
        const coverX = side < 0 ? (8 + depth * 10) : -(8 + depth * 10);
        const d = layer({ top: "-22%", bottom: "auto", height: "144%", width: "82%",
          left: side < 0 ? "0" : "auto", right: side < 0 ? "auto" : "0",
          backgroundImage: bg, backgroundSize: "cover", backgroundRepeat: "no-repeat",
          opacity: (0.78 + depth * 0.1).toFixed(2),
          transform: `translateX(${startX}%)`, willChange: "transform" });
        banks.push({ d, coverX, startX, depth, side });
        anim(d, [{ transform: "translateX(0%)" }, { transform: `translateX(${side < 0 ? (1.6 + depth) : -(1.6 + depth)}%)` }],
          { duration: 1500 + depth * 350, direction: "alternate", iterations: Infinity, easing: "ease-in-out", composite: "add" });
      };
      [-1, 1].forEach((s) => { mkBank(s, 0); mkBank(s, 1); });
      await Promise.all([
        anim(dark, [{ opacity: 0 }, { opacity: .9 }], { duration: 720, easing: "cubic-bezier(.4,0,.4,1)" }).finished,
        ...centre.map((c, i) => anim(c.d,
          [{ opacity: 0, transform: "translateX(0)" }, { opacity: c.op, transform: `translateX(${c.drift}%)` }],
          { duration: 760 + i * 90, easing: "cubic-bezier(.3,0,.5,1)" }).finished),
        ...banks.map((b) => anim(b.d,
          [{ transform: `translateX(${b.startX}%)` }, { transform: `translateX(${b.coverX}%)` }],
          { duration: 700 + b.depth * 170, easing: "cubic-bezier(.33,0,.3,1)" }).finished),
      ]);
      swap(); await wait(280);
      await Promise.all([
        anim(dark, [{ opacity: .9 }, { opacity: 0 }], { duration: 660, delay: 60, easing: "cubic-bezier(.5,0,.4,1)" }).finished,
        ...centre.map((c, i) => anim(c.d,
          [{ opacity: c.op, transform: `translateX(${c.drift}%)` }, { opacity: 0, transform: `translateX(${(c.drift * 1.8).toFixed(1)}%)` }],
          { duration: 600 + i * 80, easing: "cubic-bezier(.4,0,.5,1)" }).finished),
        ...banks.map((b) => anim(b.d,
          [{ transform: `translateX(${b.coverX}%)` }, { transform: `translateX(${b.startX}%)` }],
          { duration: 640 + b.depth * 160, easing: "cubic-bezier(.5,0,.35,1)" }).finished),
      ]);
    },
  },

  /* —— Arcane Dissolve —— */
  arcane: {
    async run({ swap }) {
      const accent = getComputedStyle(stage).getPropertyValue("--accent").trim() || "#b8a06a";
      content.style.willChange = "transform,filter,opacity";
      content.style.filter = "url(#spire-fx-warp)";
      const cv = document.createElement("canvas");
      Object.assign(cv.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" });
      fx.appendChild(cv);
      const ctx = cv.getContext("2d")!;
      const W = cv.width = stage.clientWidth, H = cv.height = stage.clientHeight;
      const hex = accent.replace("#", ""); const R = parseInt(hex.substr(0, 2), 16), G = parseInt(hex.substr(2, 2), 16), B = parseInt(hex.substr(4, 2), 16);
      const parts = Array.from({ length: 150 }, () => {
        const sp = Math.random() < 0.12;
        return { x: rand(0, W), y: rand(H * 0.4, H), vy: rand(.6, 2.6), vx: rand(-.5, .5), r: sp ? rand(2.4, 4) : rand(.8, 2.6), sp, life: rand(.4, 1) };
      });
      const aveil = layer({ background: "radial-gradient(120% 100% at 50% 50%, rgba(0,0,0,0) 40%, rgba(5,4,10,.55))", opacity: "0" });
      anim(aveil, [{ opacity: 0 }, { opacity: 1 }], { duration: 420 });
      let stop = false;
      const draw = () => {
        ctx.clearRect(0, 0, W, H);
        ctx.globalCompositeOperation = "lighter";
        parts.forEach((p) => {
          p.y -= p.vy; p.x += p.vx; p.life -= 0.008;
          const a = Math.max(0, p.life), rr = p.r * (p.sp ? 6 : 4);
          ctx.beginPath();
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
          g.addColorStop(0, p.sp ? `rgba(255,248,230,${Math.min(1, a * 1.3).toFixed(3)})` : `rgba(${R},${G},${B},${a})`);
          g.addColorStop(1, `rgba(${R},${G},${B},0)`);
          ctx.fillStyle = g; ctx.arc(p.x, p.y, rr, 0, 7); ctx.fill();
          if (p.life <= 0) { p.y = rand(H * 0.6, H); p.x = rand(0, W); p.life = rand(.5, 1); }
        });
        if (!stop && cv.isConnected) requestAnimationFrame(draw);
      };
      draw();
      await anim(content,
        [{ opacity: 1, transform: "translateY(0) scale(1)", filter: "url(#spire-fx-warp) blur(0) brightness(1)" },
         { opacity: 0, transform: "translateY(-14px) scale(1.03)", filter: "url(#spire-fx-warp) blur(7px) brightness(1.5)" }],
        { duration: 460, easing: "cubic-bezier(.5,0,.5,1)" }).finished;
      swap();
      anim(aveil, [{ opacity: 1 }, { opacity: 0 }], { duration: 440, delay: 80 });
      await anim(content,
        [{ opacity: 0, transform: "translateY(14px) scale(.985)", filter: "url(#spire-fx-warp) blur(7px) brightness(1.4)" },
         { opacity: 1, transform: "translateY(0) scale(1)", filter: "url(#spire-fx-warp) blur(0) brightness(1)" }],
        { duration: 480, easing: "cubic-bezier(.2,.7,.3,1)" }).finished;
      stop = true;
    },
  },

  /* —— Scrying Ripple —— */
  ripple: {
    async run({ swap }) {
      content.style.willChange = "filter";
      content.style.filter = "url(#spire-fx-scry)";
      const disp = document.getElementById("spire-fx-scry-disp");
      const ring = layer({ left: "50%", top: "50%", right: "auto", bottom: "auto", width: "40px", height: "40px", borderRadius: "50%",
        border: "2px solid color-mix(in srgb,var(--accent) 70%,#fff)",
        boxShadow: "0 0 30px color-mix(in srgb,var(--accent) 60%,transparent)",
        transform: "translate(-50%,-50%) scale(0)", opacity: "0" });
      const ring2 = layer({ left: "50%", top: "50%", right: "auto", bottom: "auto", width: "40px", height: "40px", borderRadius: "50%",
        border: "1px solid color-mix(in srgb,var(--accent) 55%,#fff)",
        boxShadow: "0 0 18px color-mix(in srgb,var(--accent) 45%,transparent)",
        transform: "translate(-50%,-50%) scale(0)", opacity: "0" });
      anim(ring, [{ transform: "translate(-50%,-50%) scale(0)", opacity: 0 }, { opacity: .7, offset: .5 }, { transform: "translate(-50%,-50%) scale(26)", opacity: 0 }], { duration: 960, easing: "cubic-bezier(.3,.4,.4,1)" });
      anim(ring2, [{ transform: "translate(-50%,-50%) scale(0)", opacity: 0 }, { opacity: .45, offset: .5 }, { transform: "translate(-50%,-50%) scale(19)", opacity: 0 }], { duration: 900, delay: 140, easing: "cubic-bezier(.3,.4,.4,1)" });
      let swapped = false;
      await raf(960, (p) => {
        const env = Math.sin(p * Math.PI);
        disp?.setAttribute("scale", (env * 42).toFixed(2));
        content.style.filter = `url(#spire-fx-scry) blur(${(env * 1.8).toFixed(2)}px) brightness(${(1 + env * 0.12).toFixed(3)})`;
        if (!swapped && p >= 0.5) { swapped = true; swap(); }
      });
      disp?.setAttribute("scale", "0");
    },
  },

  /* —— Ink Bleed —— */
  ink: {
    async run({ swap }) {
      const S = Math.ceil(Math.max(stage.clientWidth, stage.clientHeight) * 1.25);
      const mk = (seed: number, r: number, dx: number, dy: number) => {
        const d = document.createElement("div");
        Object.assign(d.style, { position: "absolute", left: "50%", top: "50%", width: S + "px", height: S + "px",
          marginLeft: (-S / 2 + dx * S) + "px", marginTop: (-S / 2 + dy * S) + "px",
          backgroundImage: inkBlobURI({ seed, r }), backgroundSize: "contain", backgroundRepeat: "no-repeat",
          transform: "scale(0)", willChange: "transform" });
        fx.appendChild(d); return d;
      };
      const sat1 = mk(21, 150, -0.11, 0.07), sat2 = mk(33, 165, 0.12, -0.08), main = mk(9, 210, 0, 0);
      const sheen = layer({ background: "linear-gradient(115deg, transparent 30%, rgba(112,92,165,.10) 50%, transparent 70%)",
        transform: "translateX(-130%)", mixBlendMode: "screen" });
      const e = "cubic-bezier(.6,0,.35,1)";
      await Promise.all([
        anim(main, [{ transform: "scale(.01)" }, { transform: "scale(3.9)" }], { duration: 620, easing: e }).finished,
        anim(sat1, [{ transform: "scale(0)" }, { transform: "scale(3.4)" }], { duration: 540, easing: e }).finished,
        anim(sat2, [{ transform: "scale(0)" }, { transform: "scale(3.2)" }], { duration: 580, delay: 40, easing: e }).finished,
      ]);
      anim(sheen, [{ transform: "translateX(-130%)" }, { transform: "translateX(130%)" }], { duration: 420, easing: "ease-in-out" });
      swap(); await wait(180);
      await Promise.all([
        anim(main, [{ transform: "scale(3.9)" }, { transform: "scale(.01)" }], { duration: 640, easing: e }).finished,
        anim(sat1, [{ transform: "scale(3.4)" }, { transform: "scale(0)" }], { duration: 560, delay: 60, easing: e }).finished,
        anim(sat2, [{ transform: "scale(3.2)" }, { transform: "scale(0)" }], { duration: 600, delay: 30, easing: e }).finished,
      ]);
    },
  },

  /* —— Ember Burn —— */
  burn: {
    async run({ swap }) {
      const seed = 7, scale = 84;
      const sw = stage.clientWidth, sh = stage.clientHeight;
      const W = Math.round(sw * 1.7), H = Math.round(sh * 1.16);
      const charImg = burnSheet({ w: W, h: H, seed, scale });
      const bandImg = emberBandURI({ w: W, h: H, seed, scale });
      const fieldImg = emberFieldURI({ w: W, h: Math.round(sh * 1.3), seed: seed + 3 });
      const base: Record<string, string> = { top: "-8%", bottom: "-8%", left: "0", right: "auto", width: "170%" };
      const char = layer({ ...base, backgroundImage: charImg, backgroundSize: "100% 100%", backgroundRepeat: "no-repeat", willChange: "transform" });
      const band = layer({ ...base, maskImage: bandImg, webkitMaskImage: bandImg, maskSize: "100% 100%", webkitMaskSize: "100% 100%",
        maskRepeat: "no-repeat", webkitMaskRepeat: "no-repeat", mixBlendMode: "screen", willChange: "transform" });
      const field = document.createElement("div");
      Object.assign(field.style, { position: "absolute", inset: "0",
        backgroundImage: fieldImg, backgroundSize: "cover", backgroundRepeat: "no-repeat", willChange: "transform" });
      band.appendChild(field);
      const S = Math.round(sw * 1.3);
      const slide = (el: HTMLElement, from: number, to: number, d: number, e: string) =>
        anim(el, [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], { duration: d, easing: e }).finished;
      const e1 = "cubic-bezier(.42,.04,.26,1)";
      char.style.transform = `translateX(${-S}px)`; band.style.transform = `translateX(${-S}px)`; field.style.transform = `translateX(${S}px)`;
      await Promise.all([slide(char, -S, 0, 600, e1), slide(band, -S, 0, 600, e1), slide(field, S, 0, 600, e1)]);
      swap(); await wait(80);
      const e2 = "cubic-bezier(.5,0,.32,1)";
      await Promise.all([slide(char, 0, -S, 660, e2), slide(band, 0, -S, 660, e2), slide(field, 0, S, 660, e2)]);
    },
  },

  /* —— Candle Snuff —— */
  candle: {
    async run({ swap }) {
      const ov = layer({});
      const flame = layer({ left: "50%", top: "55%", right: "auto", bottom: "auto", width: "92px", height: "92px",
        transform: "translate(-50%,-50%)", mixBlendMode: "screen",
        background: "radial-gradient(circle, rgba(255,212,128,.95), rgba(255,150,55,.5) 34%, rgba(255,120,30,0) 70%)" });
      const setHole = (h: number) => {
        const t = (h * 0.82).toFixed(1), warm = h.toFixed(1), dk = (h + 1.5).toFixed(1), wa = (h < 34 ? 0.55 : 0.22);
        ov.style.background = `radial-gradient(circle at 50% 55%, rgba(0,0,0,0) ${t}%, rgba(70,34,14,${wa}) ${warm}%, #06040c ${dk}%, #03020a 100%)`;
      };
      const flick = anim(flame,
        [{ transform: "translate(-50%,-50%) scale(1)", opacity: 1 },
         { transform: "translate(-50%,-52%) scale(1.12)", opacity: .78 },
         { transform: "translate(-50%,-50%) scale(.96)", opacity: 1 }],
        { duration: 150, iterations: Infinity, direction: "alternate" });
      await raf(540, (p) => setHole(Math.max(0, 82 * (1 - p) + Math.sin(p * 46) * 2.4 * (1 - p))));
      flick.cancel();
      await anim(flame,
        [{ opacity: 1, transform: "translate(-50%,-50%) scale(1)" },
         { opacity: 1, transform: "translate(-50%,-60%) scale(1.3)", offset: .5 },
         { opacity: 0, transform: "translate(-50%,-46%) scale(.2)" }],
        { duration: 240, easing: "ease-in" }).finished;
      setHole(0); swap();
      const wisp = layer({ left: "50%", top: "55%", right: "auto", bottom: "auto", width: "70px", height: "130px",
        transform: "translate(-50%,-94%) scale(.8) rotate(-4deg)", opacity: "0",
        backgroundImage: wispURI({}), backgroundSize: "contain", backgroundRepeat: "no-repeat", mixBlendMode: "screen" });
      anim(wisp, [{ opacity: 0, transform: "translate(-50%,-94%) scale(.8) rotate(-4deg)" },
                  { opacity: .65, offset: .28 },
                  { opacity: 0, transform: "translate(-50%,-135%) scale(1.3) rotate(8deg)" }],
        { duration: 640, easing: "ease-out" });
      await wait(90);
      flame.style.opacity = "0";
      await raf(560, (p) => setHole(82 * p));
    },
  },

  /* —— Stone Vault —— */
  stone: {
    async run({ swap }) {
      const Limg = stonePanelURI({ seed: 3, inner: "r" });
      const Rimg = stonePanelURI({ seed: 8, inner: "l" });
      const left = layer({ top: "-6%", bottom: "-6%", left: "0", right: "auto", width: "51%",
        backgroundImage: Limg, backgroundSize: "100% 100%", backgroundRepeat: "no-repeat",
        boxShadow: "14px 0 34px -10px #000", transform: "translateX(-101%)", willChange: "transform" });
      const right = layer({ top: "-6%", bottom: "-6%", right: "0", left: "auto", width: "51%",
        backgroundImage: Rimg, backgroundSize: "100% 100%", backgroundRepeat: "no-repeat",
        boxShadow: "-14px 0 34px -10px #000", transform: "translateX(101%)", willChange: "transform" });
      const seam = layer({ left: "50%", top: "0", bottom: "0", right: "auto", width: "12px",
        transform: "translateX(-50%)", filter: "blur(2px)", opacity: "0",
        background: "linear-gradient(90deg, rgba(255,235,180,0), rgba(255,235,180,.92) 50%, rgba(255,235,180,0))" });
      const eIn = "cubic-bezier(.38,0,.18,1)";
      anim(seam, [{ opacity: 0 }, { opacity: 0, offset: .55 }, { opacity: .9 }], { duration: 560 });
      await Promise.all([
        anim(left, [{ transform: "translateX(-101%)" }, { transform: "translateX(0%)", offset: .78 }, { transform: "translateX(-1.4%)", offset: .88 }, { transform: "translateX(0%)" }], { duration: 560, easing: eIn }).finished,
        anim(right, [{ transform: "translateX(101%)" }, { transform: "translateX(0%)", offset: .78 }, { transform: "translateX(1.4%)", offset: .88 }, { transform: "translateX(0%)" }], { duration: 560, easing: eIn }).finished,
      ]);
      anim(fx, [{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(5px)" }, { transform: "translateX(-2px)" }, { transform: "translateX(0)" }], { duration: 230, easing: "linear" });
      for (let i = 0; i < 10; i++) {
        const s = rand(22, 54), dir = (i % 2 ? 1 : -1);
        const p = layer({ left: "50%", top: rand(8, 88) + "%", right: "auto", bottom: "auto", width: s + "px", height: s + "px",
          transform: "translate(-50%,-50%) scale(.4)", opacity: "0",
          background: "radial-gradient(circle, rgba(168,160,142,.45), rgba(120,114,100,.18) 55%, rgba(0,0,0,0) 75%)" });
        anim(p, [{ opacity: 0, transform: "translate(-50%,-50%) scale(.4)" },
                 { opacity: .8, offset: .18 },
                 { opacity: 0, transform: `translate(calc(-50% + ${(dir * rand(26, 72)).toFixed(0)}px), calc(-50% + ${rand(-36, 14).toFixed(0)}px)) scale(${rand(1.5, 2.2).toFixed(2)})` }],
          { duration: rand(380, 560), easing: "ease-out" });
      }
      await anim(seam, [{ opacity: .9, filter: "blur(2px)" }, { opacity: 0, filter: "blur(7px)" }], { duration: 160 }).finished;
      swap(); await wait(70);
      anim(seam, [{ opacity: 0 }, { opacity: .85, offset: .22 }, { opacity: 0 }], { duration: 560 });
      await Promise.all([
        anim(left, [{ transform: "translateX(0%)" }, { transform: "translateX(-101%)" }], { duration: 560, easing: "cubic-bezier(.3,0,.3,1)" }).finished,
        anim(right, [{ transform: "translateX(0%)" }, { transform: "translateX(101%)" }], { duration: 560, easing: "cubic-bezier(.3,0,.3,1)" }).finished,
      ]);
    },
  },

  /* —— Summoning Sigil —— */
  sigil: {
    async run({ swap }) {
      const accent = getComputedStyle(stage).getPropertyValue("--accent").trim() || "#b48fe0";
      const veil = layer({ background: "radial-gradient(130% 110% at 50% 50%, rgba(9,7,15,.96), rgba(3,2,8,1))", opacity: "0" });
      const sig = layer({ backgroundImage: sigilURI({ color: accent }), backgroundSize: "contain",
        backgroundRepeat: "no-repeat", backgroundPosition: "center",
        mixBlendMode: "screen", transform: "scale(.2) rotate(-60deg)", opacity: "0", willChange: "transform,opacity" });
      const inner = layer({ backgroundImage: runeRingURI({ color: accent }), backgroundSize: "contain",
        backgroundRepeat: "no-repeat", backgroundPosition: "center",
        mixBlendMode: "screen", transform: "scale(.12) rotate(75deg)", opacity: "0", willChange: "transform,opacity" });
      const flash = layer({ left: "50%", top: "50%", right: "auto", bottom: "auto", width: "40px", height: "40px", borderRadius: "50%",
        background: `radial-gradient(circle, #fff, ${accent} 40%, rgba(0,0,0,0) 70%)`,
        mixBlendMode: "screen", transform: "translate(-50%,-50%) scale(0)", opacity: "0", willChange: "transform,opacity" });
      await Promise.all([
        anim(veil, [{ opacity: 0 }, { opacity: 1 }], { duration: 520 }).finished,
        anim(sig, [{ transform: "scale(.2) rotate(-60deg)", opacity: 0 }, { transform: "scale(1) rotate(0deg)", opacity: 1 }], { duration: 560, easing: "cubic-bezier(.2,.7,.3,1)" }).finished,
        anim(inner, [{ transform: "scale(.12) rotate(75deg)", opacity: 0 }, { transform: "scale(.58) rotate(0deg)", opacity: .95 }], { duration: 560, easing: "cubic-bezier(.2,.7,.3,1)" }).finished,
      ]);
      const flr = anim(flash,
        [{ transform: "translate(-50%,-50%) scale(0)", opacity: 0 },
         { transform: "translate(-50%,-50%) scale(12)", opacity: 1, offset: .6 },
         { transform: "translate(-50%,-50%) scale(20)", opacity: 1 }],
        { duration: 300, easing: "cubic-bezier(.4,0,.6,1)" });
      anim(sig, [{ transform: "scale(1) rotate(0deg)", opacity: 1 }, { transform: "scale(1.4) rotate(40deg)", opacity: 0 }], { duration: 300, easing: "ease-in" });
      anim(inner, [{ transform: "scale(.58) rotate(0deg)", opacity: .95 }, { transform: "scale(.84) rotate(-55deg)", opacity: 0 }], { duration: 300, easing: "ease-in" });
      await flr.finished;
      swap(); await wait(60);
      await Promise.all([
        anim(flash, [{ opacity: 1 }, { opacity: 0 }], { duration: 380, easing: "ease-out" }).finished,
        anim(veil, [{ opacity: 1 }, { opacity: 0 }], { duration: 420, delay: 60 }).finished,
      ]);
    },
  },

  /* —— Eclipse —— */
  eclipse: {
    async run({ swap }) {
      const sw = stage.clientWidth, sh = stage.clientHeight, D = Math.round(Math.max(sw, sh) * 2.4);
      const dim = layer({ background: "#020208", opacity: "0" });
      const disc = document.createElement("div");
      Object.assign(disc.style, { position: "absolute", left: "50%", top: "50%", width: D + "px", height: D + "px",
        marginLeft: (-D / 2) + "px", marginTop: (-D / 2) + "px", borderRadius: "50%", willChange: "transform",
        background: "radial-gradient(circle, #04040a 0%, #04040a 38%, rgba(255,240,205,0) 39.5%, rgba(255,240,205,.95) 41.5%, rgba(190,160,255,.5) 43.5%, rgba(120,110,200,.18) 47%, rgba(0,0,0,0) 53%)" });
      const rays = document.createElement("div");
      Object.assign(rays.style, { position: "absolute", inset: "0",
        backgroundImage: coronaRaysURI({}), backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat",
        mixBlendMode: "screen", willChange: "transform" });
      disc.appendChild(rays);
      anim(rays, [{ transform: "rotate(0deg)" }, { transform: "rotate(17deg)" }], { duration: 1600, easing: "linear" });
      fx.appendChild(disc);
      const star = layer({ backgroundImage: starsURI(110, 700, 560, 33), backgroundSize: "cover",
        backgroundRepeat: "no-repeat", mixBlendMode: "screen", opacity: "0" });
      const from = `translate(${-Math.round(sw * 0.95)}px, ${-Math.round(sh * 0.85)}px)`;
      const mid = "translate(0px,0px)";
      const to = `translate(${Math.round(sw * 0.95)}px, ${Math.round(sh * 0.85)}px)`;
      disc.style.transform = from;
      await Promise.all([
        anim(disc, [{ transform: from }, { transform: mid }], { duration: 680, easing: "cubic-bezier(.45,.05,.4,1)" }).finished,
        anim(star, [{ opacity: 0 }, { opacity: .85 }], { duration: 680, easing: "ease-in" }).finished,
        anim(dim, [{ opacity: 0 }, { opacity: .5 }], { duration: 680, easing: "ease-in" }).finished,
      ]);
      swap(); await wait(110);
      await Promise.all([
        anim(disc, [{ transform: mid }, { transform: to }], { duration: 720, easing: "cubic-bezier(.5,0,.4,1)" }).finished,
        anim(star, [{ opacity: .85 }, { opacity: 0 }], { duration: 520 }).finished,
        anim(dim, [{ opacity: .5 }, { opacity: 0 }], { duration: 600 }).finished,
      ]);
    },
  },

  /* —— Hologram Scan —— */
  hologram: {
    async run({ swap }) {
      const cover = layer({
        background: "linear-gradient(rgba(2,12,18,.94), rgba(2,12,18,.94)), repeating-linear-gradient(0deg, rgba(0,0,0,0) 0 2px, rgba(60,200,235,.16) 2px 3px)",
        opacity: "0", willChange: "opacity,clip-path" });
      const interf = layer({ left: "0", right: "0", top: "0", bottom: "auto", height: "16%",
        background: "linear-gradient(180deg, transparent, rgba(140,235,255,.07) 45%, rgba(0,10,16,.16) 55%, transparent)",
        mixBlendMode: "overlay", transform: "translateY(-110%)" });
      anim(interf, [{ transform: "translateY(-110%)" }, { transform: "translateY(680%)" }], { duration: 900, iterations: Infinity, easing: "linear" });
      const bar = layer({ left: "0", right: "0", top: "0", bottom: "auto", height: "54px",
        transform: "translateY(-60px)", opacity: "0",
        background: "linear-gradient(180deg, rgba(120,240,255,0) 0, rgba(120,240,255,.18) 42%, rgba(215,252,255,.95) 82%, rgba(140,245,255,.3) 92%, rgba(120,240,255,0) 100%)",
        boxShadow: "0 6px 26px 4px rgba(120,235,255,.55)", willChange: "transform" });
      await anim(cover, [{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "ease-out" }).finished;
      anim(cover, [{ opacity: 1 }, { opacity: .86, offset: .16 }, { opacity: 1, offset: .3 }, { opacity: .93, offset: .58 }, { opacity: 1 }], { duration: 640 });
      swap(); await wait(40);
      const H = stage.clientHeight; bar.style.opacity = "1";
      const sweep = anim(bar, [{ transform: "translateY(-60px)" }, { transform: `translateY(${H}px)` }], { duration: 640, easing: "cubic-bezier(.4,.1,.3,1)" });
      anim(cover, [{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(100% 0 0 0)" }], { duration: 640, easing: "cubic-bezier(.4,.1,.3,1)" });
      await sweep.finished;
      await anim(bar, [{ opacity: 1 }, { opacity: 0 }], { duration: 120 }).finished;
    },
  },

  /* —— Transporter Beam —— */
  transporter: {
    async run({ swap }) {
      const veil = layer({ background: "linear-gradient(180deg, rgba(6,20,28,.9), rgba(4,12,20,.92))", opacity: "0" });
      const bandMask = "linear-gradient(180deg, transparent 0, #000 10%, #000 82%, transparent 100%)";
      const bands = layer({ top: "-10%", bottom: "-30%",
        background: "repeating-linear-gradient(90deg, rgba(120,235,255,0) 0 14px, rgba(120,235,255,.5) 18px, rgba(180,250,255,0) 26px)",
        maskImage: bandMask, webkitMaskImage: bandMask, mixBlendMode: "screen", opacity: "0", willChange: "transform,opacity" });
      const bands2 = layer({ top: "-10%", bottom: "-30%",
        background: "repeating-linear-gradient(90deg, rgba(150,240,255,0) 7px 19px, rgba(170,245,255,.35) 24px, rgba(200,252,255,0) 33px)",
        maskImage: bandMask, webkitMaskImage: bandMask, mixBlendMode: "screen", opacity: "0", willChange: "transform,opacity" });
      const core = layer({ left: "33%", right: "33%", top: "0", bottom: "0",
        background: "linear-gradient(90deg, rgba(140,240,255,0), rgba(175,246,255,.28) 50%, rgba(140,240,255,0))",
        mixBlendMode: "screen", opacity: "0", willChange: "opacity" });
      const cv = document.createElement("canvas");
      Object.assign(cv.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" });
      fx.appendChild(cv);
      const ctx = cv.getContext("2d")!, W = cv.width = stage.clientWidth, Hc = cv.height = stage.clientHeight;
      const parts = Array.from({ length: 175 }, () => {
        const sp = Math.random() < 0.14;
        return { x: rand(0, W), y: rand(0, Hc), vy: sp ? rand(2, 4.5) : rand(.8, 3), r: sp ? rand(1.8, 3) : rand(.6, 2.2), sp, life: rand(.3, 1), hue: rand(160, 200) };
      });
      let stop = false;
      const draw = () => {
        ctx.clearRect(0, 0, W, Hc); ctx.globalCompositeOperation = "lighter";
        parts.forEach((p) => {
          p.y -= p.vy; p.life -= 0.01; const a = Math.max(0, p.life);
          const rr = p.r * (p.sp ? 5.5 : 4);
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
          g.addColorStop(0, p.sp ? `hsla(185,100%,94%,${Math.min(1, a * 1.25).toFixed(3)})` : `hsla(${p.hue},100%,80%,${a})`);
          g.addColorStop(1, `hsla(${p.hue},100%,80%,0)`);
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, 7); ctx.fill();
          if (p.life <= 0) { p.y = rand(Hc * 0.2, Hc); p.x = rand(0, W); p.life = rand(.4, 1); }
        });
        if (!stop && cv.isConnected) requestAnimationFrame(draw);
      };
      draw();
      const flash = layer({ opacity: "0" });
      await Promise.all([
        anim(veil, [{ opacity: 0 }, { opacity: 1 }], { duration: 520, easing: "ease-in" }).finished,
        anim(bands, [{ opacity: 0, transform: "translateY(0)" }, { opacity: .9, transform: "translateY(-40px)" }], { duration: 520, easing: "ease-in" }).finished,
        anim(bands2, [{ opacity: 0, transform: "translateY(0)" }, { opacity: .55, transform: "translateY(-68px)" }], { duration: 520, easing: "ease-in" }).finished,
        anim(core, [{ opacity: 0 }, { opacity: .95 }], { duration: 520, easing: "ease-in" }).finished,
      ]);
      flash.style.background = "radial-gradient(circle at 50% 50%, rgba(210,250,255,.92), rgba(150,235,255,.5) 60%, rgba(120,200,255,.2))";
      await anim(flash, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 }).finished;
      swap(); await wait(60);
      await anim(flash, [{ opacity: 1 }, { opacity: 0 }], { duration: 200 }).finished;
      await Promise.all([
        anim(veil, [{ opacity: 1 }, { opacity: 0 }], { duration: 520, easing: "ease-out" }).finished,
        anim(bands, [{ opacity: .9, transform: "translateY(-40px)" }, { opacity: 0, transform: "translateY(-80px)" }], { duration: 480, easing: "ease-out" }).finished,
        anim(bands2, [{ opacity: .55, transform: "translateY(-68px)" }, { opacity: 0, transform: "translateY(-120px)" }], { duration: 480, easing: "ease-out" }).finished,
        anim(core, [{ opacity: .95 }, { opacity: 0 }], { duration: 460, easing: "ease-out" }).finished,
      ]);
      stop = true;
    },
  },

  /* —— Warp Jump —— */
  warp: {
    async run({ swap }) {
      const space = layer({ background: "radial-gradient(circle at 50% 50%, #0a0f20 0%, #05060f 60%, #03030a 100%)", opacity: "0" });
      const streaks = layer({ backgroundImage: warpStreaksURI({}), backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat",
        transform: "scale(.35)", opacity: "0", willChange: "transform,opacity" });
      const streaks2 = layer({ backgroundImage: warpStreaksURI({ seed: 11, n: 90, color: "rgba(150,200,255," }), backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat",
        transform: "scale(.25)", opacity: "0", willChange: "transform,opacity" });
      const flash = layer({ opacity: "0", background: "radial-gradient(circle at 50% 50%, #fff 0%, rgba(220,240,255,.85) 42%, rgba(180,220,255,.3) 72%, rgba(0,0,0,0) 90%)" });
      const black = layer({ background: "#000", opacity: "0", willChange: "opacity" });
      await Promise.all([
        anim(space, [{ opacity: 0 }, { opacity: 1 }], { duration: 360, easing: "ease-in" }).finished,
        anim(streaks, [{ transform: "scale(.35)", opacity: 0 }, { transform: "scale(1)", opacity: .9, offset: .4 }, { transform: "scale(6.5)", opacity: 1 }], { duration: 660, easing: "cubic-bezier(.5,0,.85,.4)" }).finished,
        anim(streaks2, [{ transform: "scale(.25)", opacity: 0 }, { transform: "scale(.7)", opacity: .55, offset: .45 }, { transform: "scale(4.2)", opacity: .7 }], { duration: 660, easing: "cubic-bezier(.5,0,.85,.4)" }).finished,
        anim(flash, [{ opacity: 0, offset: 0 }, { opacity: 0, offset: .55 }, { opacity: .7, offset: .8 }, { opacity: .25, offset: 1 }], { duration: 660, easing: "linear" }).finished,
        anim(black, [{ opacity: 0, offset: 0 }, { opacity: 0, offset: .4 }, { opacity: 1, offset: 1 }], { duration: 660, easing: "cubic-bezier(.5,0,.9,.55)" }).finished,
      ]);
      swap(); await wait(120);
      await Promise.all([
        anim(black, [{ opacity: 1 }, { opacity: 0 }], { duration: 560, easing: "cubic-bezier(.2,.4,.3,1)" }).finished,
        anim(flash, [{ opacity: .25 }, { opacity: 0 }], { duration: 240, easing: "ease-out" }).finished,
        anim(streaks, [{ transform: "scale(6.5)", opacity: 1 }, { transform: "scale(.2)", opacity: 0 }], { duration: 400, easing: "ease-out" }).finished,
        anim(streaks2, [{ transform: "scale(4.2)", opacity: .7 }, { transform: "scale(.2)", opacity: 0 }], { duration: 440, easing: "ease-out" }).finished,
        anim(space, [{ opacity: 1 }, { opacity: 0 }], { duration: 520, delay: 140 }).finished,
      ]);
    },
  },

  /* —— Wormhole —— */
  wormhole: {
    async run({ swap }) {
      const space = layer({ background: "radial-gradient(circle at 50% 50%, #0a0c1e 0%, #050610 55%, #020208 100%)", opacity: "0" });
      const tunnel = layer({ backgroundImage: vortexURI({}), backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat",
        transform: "scale(.6) rotate(0deg)", transformOrigin: "50% 50%", opacity: "0", willChange: "transform,opacity" });
      await Promise.all([
        anim(space, [{ opacity: 0 }, { opacity: 1 }], { duration: 380, easing: "ease-in" }).finished,
        anim(tunnel, [{ transform: "scale(.6) rotate(0deg)", opacity: 0 }, { transform: "scale(1.8) rotate(17deg)", opacity: 1, offset: .45 }, { transform: "scale(6.5) rotate(42deg)", opacity: 1 }], { duration: 820, easing: "cubic-bezier(.5,0,.75,.45)" }).finished,
      ]);
      swap(); await wait(110);
      await Promise.all([
        anim(tunnel, [{ transform: "scale(6.5) rotate(42deg)", opacity: 1 }, { transform: "scale(11) rotate(64deg)", opacity: 0 }], { duration: 600, easing: "cubic-bezier(.3,.5,.4,1)" }).finished,
        anim(space, [{ opacity: 1 }, { opacity: 0 }], { duration: 480, delay: 140 }).finished,
      ]);
    },
  },
};

export function getRite(key: string): Rite | undefined {
  return RITES[key];
}
