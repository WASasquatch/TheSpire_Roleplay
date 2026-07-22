/**
 * Cosmetic animation phase sync.
 *
 * A CSS animation's clock starts when it first applies to its element, so
 * every chat line / userlist row / profile card renders its OWN copy of an
 * equipped name-style or border-frame animation at a different phase —
 * three messages from the same user pulse on three different beats.
 * Pinning every looping cosmetic animation's Web-Animations `startTime`
 * to 0 (the document timeline origin) makes phase a pure function of
 * document time: every copy of the same keyframes computes the same
 * phase forever, no matter when it mounted. A newly mounted element
 * snaps from phase 0 to the shared phase on its first frame, which is
 * invisible for a loop. Per-animation `animation-delay` is preserved,
 * so deliberately staggered particle pseudo-elements keep their
 * relative offsets — the whole ensemble just shares one epoch.
 *
 * Guards — each is load-bearing:
 *   - CSSAnimation only: retiming a CSSTransition would break hover /
 *     fade transitions mid-flight.
 *   - infinite iterations only: a one-shot animation (room transition,
 *     whisper flash) would skip toward its end state.
 *   - running only: setting startTime on a PAUSED animation RESUMES it,
 *     which would defeat `animation-play-state` gates.
 *   - Calm-cosmetics / Reduce Motion freezes need no special handling
 *     here: they remove the animation (`animation: none`), so there is
 *     nothing to pin. The module re-syncs when the gate lifts (see the
 *     subscription at the bottom) because the unfrozen cohort recreates
 *     with a fresh shared start time that ISN'T the origin — a row
 *     mounted later would pin to origin and drift out of phase with it.
 *
 * Batching: `getAnimations()` forces a style flush, so per-element
 * requests are queued and processed once per frame (same rationale as
 * the chat feed's rAF-coalesced bottom re-pin).
 */

import { onCalmCosmeticsChange } from "./calmCosmetics.js";

/** Attribute stamped on non-StyledName cosmetic roots (template-mode
 *  border wrappers) so the catalog-wide sweep can find them. StyledName
 *  elements are covered by their `keep-styled-name` class. */
export const COSMETIC_SYNC_ATTR = "data-cosmetic-anim-sync";

const SWEEP_SELECTOR = `.keep-styled-name, [${COSMETIC_SYNC_ATTR}]`;

const pending = new Set<Element>();
let rafHandle: number | null = null;

function supported(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof CSSAnimation !== "undefined" &&
    typeof Element !== "undefined" &&
    typeof Element.prototype.getAnimations === "function"
  );
}

function syncSubtree(root: Element): void {
  let animations: Animation[];
  try {
    animations = root.getAnimations({ subtree: true });
  } catch {
    return; // an implementation without subtree support: skip, don't break
  }
  for (const anim of animations) {
    if (!(anim instanceof CSSAnimation)) continue;
    if (anim.playState !== "running") continue;
    const timing = anim.effect?.getTiming();
    if (!timing || timing.iterations !== Infinity) continue;
    if (anim.startTime !== 0) anim.startTime = 0;
  }
}

function flush(): void {
  rafHandle = null;
  const targets = [...pending];
  pending.clear();
  for (const el of targets) {
    if (el.isConnected) syncSubtree(el);
  }
}

/**
 * Queue an element (and its subtree, pseudo-elements included) to have
 * its looping cosmetic animations pinned to the document-timeline
 * origin on the next frame. Idempotent and cheap to over-call: repeat
 * requests for the same element in one frame collapse to one sync.
 */
export function requestCosmeticAnimationSync(el: Element | null | undefined): void {
  if (!el || !supported()) return;
  pending.add(el);
  if (rafHandle == null) rafHandle = requestAnimationFrame(flush);
}

/**
 * Queue every cosmetic root currently in the document. Called when the
 * animations themselves (re)come into existence AFTER their elements
 * mounted — the catalog stylesheet landing on a cold load, or the
 * calm-cosmetics freeze lifting — cases the per-component mount sync
 * has already run for and missed.
 */
export function requestCosmeticSweep(): void {
  if (!supported()) return;
  for (const el of document.querySelectorAll(SWEEP_SELECTOR)) pending.add(el);
  if (pending.size > 0 && rafHandle == null) rafHandle = requestAnimationFrame(flush);
}

// Re-pin after any calm-cosmetics flip. Lifting the freeze recreates every
// cosmetic animation with a "now" start time; the sweep re-anchors them to
// the origin so later mounts stay in phase with them. The freeze direction
// finds no running animations and no-ops. Tab-lifetime subscription, same
// as the gate itself.
if (typeof window !== "undefined") {
  onCalmCosmeticsChange(() => requestCosmeticSweep());
}
