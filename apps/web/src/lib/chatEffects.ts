/**
 * Short visual effects triggered by the server via `chat:effect`.
 * Currently ships one effect (`runStruckEffect`); the file exists as
 * a registry so future target-based commands can plug in another
 * runner without scattering DOM manipulation across the app.
 *
 * Every runner is idempotent, calling it again while the previous
 * cycle is still mid-animation cancels the lingering classes,
 * forces a reflow, and re-applies, so a double-tap of /throw
 * doesn't compound transforms or leave classes stuck on a node.
 *
 * Accessibility: every runner respects `prefers-reduced-motion: reduce`
 * by short-circuiting at the top. Users on that preference get the
 * chat-line system message but no shake / flash. This matches the
 * project's existing ethos on quiet UX (see `feedback_*` memories
 * about not bombarding users with motion).
 */

import { playDropStrike, playThrowStrike } from "./sound.js";

const STRUCK_DURATION_MS = 500;

let activeStruckTimeout: number | null = null;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Fire the "struck" reaction:
 *   1. `keep-struck-shake` class on `document.body`, shake + tiny
 *      scale-up so the translate offsets never reveal viewport edges.
 *   2. `keep-struck-flash` class on `.keep-composer`, pale-red
 *      overlay pulse via the `::after` pseudo-element on the
 *      composer surface.
 *   3. Audio cue, `throw` (whoosh-impact) or `drop` (thud), routed
 *      through the existing sound infrastructure so the user's
 *      sound preferences + /away mute apply consistently with every
 *      other in-app sound.
 *
 * `variant` selects the audio. Missing variant (older server build,
 * or a future struck-flavored effect that doesn't fit either bucket)
 * skips audio entirely and only runs the visual reaction.
 *
 * Classes auto-remove after the animation duration. Reentrancy: a
 * second call mid-cycle cancels and re-triggers cleanly, we strip
 * the class, force a reflow, then re-add so the keyframes restart
 * from frame zero instead of resuming mid-animation.
 *
 * Reduced-motion respects: visual classes are skipped, but the
 * audio cue still fires, users who've asked the OS to reduce
 * motion typically don't want every other sensory signal stripped
 * too, and a strike sound without the shake reads as "something
 * happened" rather than "the screen had a seizure."
 */
export function runStruckEffect(variant?: "throw" | "drop"): void {
  if (typeof document === "undefined") return;

  // Audio fires regardless of reduced-motion. sound.ts handles its
  // own preference / away-mute gating internally, we just route
  // by variant. Skip when variant is missing (older server build
  // that doesn't ship the field) so we don't double up with a
  // generic "tap" or default sound on top of the visual reaction.
  if (variant === "throw") playThrowStrike();
  else if (variant === "drop") playDropStrike();

  if (prefersReducedMotion()) return;

  const body = document.body;
  const composer = document.querySelector<HTMLElement>(".keep-composer");

  // Restart trick: remove → force reflow → add.
  body.classList.remove("keep-struck-shake");
  // Reading offsetWidth synchronously forces layout, which flushes
  // the class removal. Without this, applying the same class twice
  // in succession is a no-op (the browser sees "class already there"
  // and doesn't restart the animation).
  void body.offsetWidth;
  body.classList.add("keep-struck-shake");

  if (composer) {
    composer.classList.remove("keep-struck-flash");
    void composer.offsetWidth;
    composer.classList.add("keep-struck-flash");
  }

  if (activeStruckTimeout !== null) window.clearTimeout(activeStruckTimeout);
  activeStruckTimeout = window.setTimeout(() => {
    body.classList.remove("keep-struck-shake");
    composer?.classList.remove("keep-struck-flash");
    activeStruckTimeout = null;
  }, STRUCK_DURATION_MS);
}
