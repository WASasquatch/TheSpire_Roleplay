/**
 * Reduce Motion — the single source of truth for "calm mode".
 *
 * Motion-sensitive users (vestibular / motion sickness) need the app to stop
 * auto-playing and continuous motion and to ease changes in gently. We treat
 * Reduce Motion as ON when EITHER:
 *   - the OS/browser `prefers-reduced-motion: reduce` setting is on, OR
 *   - the in-app toggle is on (per-device, localStorage — so a user whose OS
 *     setting they can't change still gets relief, mirroring the per-device
 *     NSFW censor preference).
 *
 * When ON we add a `reduce-motion` class to <html> so CSS animations can opt
 * out too, and JS surfaces (modals, tab/content fades, room transitions, the
 * splash carousels) read {@link reduceMotionEnabled} / {@link useReducedMotion}
 * to soften or freeze their motion. When OFF nothing changes — the app keeps
 * its current snappy feel.
 */
import { createPersistedToggleStore } from "./persistedToggleStore.js";

const LS_KEY = "tk.reduceMotion";

function osPrefersReduced(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const store = createPersistedToggleStore<boolean>({
  storageKey: LS_KEY,
  rootClass: "reduce-motion",
  read: (raw) => raw === "1",
  serialize: (on) => (on ? "1" : "0"),
  // Reduce Motion is on when the in-app toggle OR the live OS setting is on.
  compute: (toggle) => toggle || osPrefersReduced(),
});

/** Non-reactive read for plain modules (the room-transition orchestrator,
 *  imperative carousel timers). */
export const reduceMotionEnabled = store.enabled;

/** The in-app toggle's own state (independent of the OS setting), for the
 *  settings checkbox to reflect what the user themselves chose. */
export const getReduceMotionToggle = store.getToggle;

/** Whether the OS is forcing reduced motion (so the UI can show the toggle as
 *  "locked on by your system" rather than something the user can turn off). */
export function osReduceMotionForced(): boolean {
  return osPrefersReduced();
}

/** Flip the in-app toggle (persists per-device, updates <html> + subscribers). */
export const setReduceMotionToggle = store.setToggle;

/** Plain-module subscription to Reduce Motion changes (OS flip or in-app
 *  toggle), so combiners like {@link import('./calmCosmetics')} can re-derive
 *  without React. Returns an unsubscribe. */
export const onReduceMotionChange = store.subscribe;

// React to OS-level changes live (a user toggling Reduce Motion in their OS
// while the tab is open).
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onChange = () => store.refresh();
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
  else if (typeof mq.addListener === "function") mq.addListener(onChange); // older Safari
}

// Stamp the initial class as soon as this module loads.
store.applyRootClass();

/** Reactive hook for React components. Re-renders when Reduce Motion flips
 *  (OS change or in-app toggle). */
export function useReducedMotion(): boolean {
  return store.use();
}
