/**
 * Room-transition orchestrator. Plays the equipped "rite" over the chat area
 * when the user switches rooms, using a snapshot-clone overlay so the demo
 * rites run unchanged against the app's async room switch:
 *
 *   1. clone the live chat wrapper into an absolute overlay (`content`) and
 *      add an `fx` layer, positioned exactly over the real wrapper;
 *   2. fire the real room switch (`swap`) immediately — it updates the live
 *      chat underneath while the overlay hides it;
 *   3. run the rite; at its midpoint it calls our re-clone callback, which
 *      snapshots the now-live (new-room) chat into the overlay;
 *   4. remove the overlay → the real, live new room is revealed (pixel match).
 *
 * The room switch happens regardless of whether the animation succeeds, so a
 * thrown rite, reduced-motion, or an unknown key all degrade to an instant
 * switch. Only one transition runs at a time.
 */
import { getRoomTransition } from "@thekeep/shared";
import { getRite, setRiteCtx } from "./rites.js";

let busy = false;

/** Hidden SVG filter defs used by the `arcane` (warp) + `ripple` (scry) rites.
 *  Injected once; ids are namespaced so they can't collide with app filters. */
function injectFilters(): void {
  if (document.getElementById("spire-fx-defs")) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("id", "spire-fx-defs");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  svg.innerHTML =
    "<defs>" +
    "<filter id=\"spire-fx-warp\"><feTurbulence type=\"fractalNoise\" baseFrequency=\"0.018\" numOctaves=\"2\" seed=\"7\" result=\"n\"/><feDisplacementMap in=\"SourceGraphic\" in2=\"n\" scale=\"16\" xChannelSelector=\"R\" yChannelSelector=\"G\"/></filter>" +
    "<filter id=\"spire-fx-scry\"><feTurbulence type=\"fractalNoise\" baseFrequency=\"0.011 0.016\" numOctaves=\"2\" seed=\"3\" result=\"n\"/><feDisplacementMap id=\"spire-fx-scry-disp\" in=\"SourceGraphic\" in2=\"n\" scale=\"0\" xChannelSelector=\"R\" yChannelSelector=\"G\"/></filter>" +
    "</defs>";
  document.body.appendChild(svg);
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The rites theme some flourishes off `--accent`, and `arcane` parses it as a
 *  HEX color, so this must return `#rrggbb`. The app stores `--keep-action` as
 *  space-separated RGB channels ("212 168 87"); convert to hex (fallback gold). */
function accentColor(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--keep-action").trim();
  const m = v.match(/(\d+)\s+(\d+)\s+(\d+)/);
  if (m) {
    const hx = (n: string) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, "0");
    return `#${hx(m[1]!)}${hx(m[2]!)}${hx(m[3]!)}`;
  }
  return "#b8a06a";
}

export interface PlayOptions {
  /** The stable chat wrapper to overlay + clone. */
  wrapperEl: HTMLElement | null;
  /** Performs the actual room switch (e.g. socket join). Always called once. */
  swap: () => void;
  /** Bypass the reduced-motion / busy skip (used by the shop Preview button). */
  force?: boolean;
  /** Overlay z-index. Default sits above chat but below modals; the shop
   *  preview raises it above the (open) dashboard modal. */
  zIndex?: number;
  /** Returns true once the NEW room has actually rendered. The join is async,
   *  so the rite's midpoint re-clone polls this to avoid snapshotting a stale
   *  / half-loaded room. Omitted for previews (no real switch). */
  isReady?: () => boolean;
}

export async function playRoomTransition(key: string | null | undefined, opts: PlayOptions): Promise<void> {
  const { wrapperEl, swap, force = false, zIndex = 45, isReady } = opts;
  const transition = key ? getRoomTransition(key) : null;
  const rite = key ? getRite(key) : undefined;
  const rect = wrapperEl?.getBoundingClientRect();
  // Degrade to an instant switch on: no/unknown transition, missing or
  // zero-size wrapper, a transition already in flight, or reduced motion.
  // `busy` always blocks (concurrent runs would clash on the shared rite
  // context); `force` (preview) only overrides reduced-motion.
  if (
    !transition || !rite || !wrapperEl || !rect || rect.width < 10 || rect.height < 10 ||
    busy || (!force && prefersReducedMotion())
  ) {
    swap();
    return;
  }
  busy = true;
  injectFilters();

  const stage = document.createElement("div");
  Object.assign(stage.style, {
    position: "fixed",
    left: `${rect.left}px`, top: `${rect.top}px`,
    width: `${rect.width}px`, height: `${rect.height}px`,
    overflow: "hidden", pointerEvents: "none", zIndex: String(zIndex),
    perspective: "1900px", perspectiveOrigin: "50% 50%",
  } as Partial<CSSStyleDeclaration>);
  stage.style.setProperty("--accent", accentColor());

  // Backdrop: a fade-to-dark layer BEHIND the content. The rites' alpha effects
  // were authored against a near-black canvas; without this they composite over
  // the active theme's background (notably the glass themes' container images)
  // and read muddy. Fades in at the start, back out at the end (see finally) so
  // the room's real themed background returns without a hard pop.
  const backdrop = document.createElement("div");
  Object.assign(backdrop.style, { position: "absolute", inset: "0", background: "#06050b", opacity: "0" } as Partial<CSSStyleDeclaration>);
  const content = document.createElement("div");
  Object.assign(content.style, { position: "absolute", inset: "0", backfaceVisibility: "hidden" } as Partial<CSSStyleDeclaration>);
  const fx = document.createElement("div");
  Object.assign(fx.style, { position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden", zIndex: "2" } as Partial<CSSStyleDeclaration>);
  stage.appendChild(backdrop);   // behind content + fx (DOM order = paint order)
  stage.appendChild(content);
  stage.appendChild(fx);

  const cloneInto = (host: HTMLElement) => {
    host.textContent = "";
    const clone = wrapperEl.cloneNode(true) as HTMLElement;
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.margin = "0";
    // The live wrapper gets hidden below; a clone taken while it's hidden would
    // inherit that, so force the clone visible.
    clone.style.visibility = "visible";
    clone.style.opacity = "1";
    host.appendChild(clone);
  };
  cloneInto(content);              // snapshot the OLD room
  document.body.appendChild(stage);
  // Hide the real content for the duration. The chat sits on the page's
  // background (the clone itself is transparent), so without this the live
  // content shows straight through the clone — two rooms overlaid. Restored in
  // `finally`. visibility:hidden keeps layout so the overlay rect stays put.
  const prevVisibility = wrapperEl.style.visibility;
  wrapperEl.style.visibility = "hidden";
  // Bring up the dark canvas (overlaps the rite's opening beats).
  backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: "ease-out", fill: "both" });

  // Fire the real switch now; the live chat updates underneath the overlay.
  try { swap(); } catch { /* caller's join may throw; the overlay is cosmetic */ }

  // The rite's swap = re-clone the now-live room into the overlay. Because the
  // join is async, if the new room hasn't rendered by the rite's midpoint we
  // poll `isReady` briefly and re-clone once it's there. The "in" animation
  // runs on `content`, so swapping its children mid-animation is seamless.
  const reclone = () => {
    cloneInto(content);
    if (!isReady || isReady()) return;
    const t0 = performance.now();
    const poll = () => {
      if (!content.isConnected) return;            // overlay already torn down
      if (isReady()) { requestAnimationFrame(() => { if (content.isConnected) cloneInto(content); }); return; }
      if (performance.now() - t0 > 700) { cloneInto(content); return; }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  };

  setRiteCtx(stage, content, fx);
  try {
    await rite.run({ swap: reclone });
  } catch {
    /* the room already switched; just clean up */
  } finally {
    // Fade the dark canvas back out so the new room's themed background returns
    // smoothly rather than popping from black on overlay removal.
    try {
      await backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-in", fill: "both" }).finished;
    } catch { /* ignore */ }
    wrapperEl.style.visibility = prevVisibility;   // reveal the (now-new) live content
    try { stage.getAnimations({ subtree: true }).forEach((a) => a.cancel()); } catch { /* older browsers */ }
    stage.remove();
    busy = false;
  }
}

/** Play a transition in place (no room change) for the shop preview. Raised
 *  above the open dashboard modal so it's actually visible. */
export function previewRoomTransition(key: string, wrapperEl: HTMLElement | null): Promise<void> {
  return playRoomTransition(key, { wrapperEl, swap: () => {}, force: true, zIndex: 9998 });
}
