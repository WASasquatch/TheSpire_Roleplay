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
import { useSyncExternalStore } from "react";

const LS_KEY = "tk.reduceMotion";

type Listener = () => void;
const listeners = new Set<Listener>();

let toggle = readToggle();
/** Cached so getSnapshot returns a stable value between real changes
 *  (useSyncExternalStore requires snapshot stability or it loops). */
let snapshot = compute();

function readToggle(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === "1";
  } catch {
    return false;
  }
}

function osPrefersReduced(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function compute(): boolean {
  return toggle || osPrefersReduced();
}

function applyRootClass(): void {
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("reduce-motion", snapshot);
  }
}

function refresh(): void {
  const next = compute();
  if (next === snapshot) return;
  snapshot = next;
  applyRootClass();
  for (const l of listeners) l();
}

/** Non-reactive read for plain modules (the room-transition orchestrator,
 *  imperative carousel timers). */
export function reduceMotionEnabled(): boolean {
  return snapshot;
}

/** The in-app toggle's own state (independent of the OS setting), for the
 *  settings checkbox to reflect what the user themselves chose. */
export function getReduceMotionToggle(): boolean {
  return toggle;
}

/** Whether the OS is forcing reduced motion (so the UI can show the toggle as
 *  "locked on by your system" rather than something the user can turn off). */
export function osReduceMotionForced(): boolean {
  return osPrefersReduced();
}

/** Flip the in-app toggle (persists per-device, updates <html> + subscribers). */
export function setReduceMotionToggle(on: boolean): void {
  toggle = on;
  try {
    localStorage.setItem(LS_KEY, on ? "1" : "0");
  } catch {
    /* private mode / storage disabled — honored for this session only */
  }
  refresh();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// React to OS-level changes live (a user toggling Reduce Motion in their OS
// while the tab is open).
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onChange = () => refresh();
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
  else if (typeof mq.addListener === "function") mq.addListener(onChange); // older Safari
}

// Stamp the initial class as soon as this module loads.
applyRootClass();

/** Reactive hook for React components. Re-renders when Reduce Motion flips
 *  (OS change or in-app toggle). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, reduceMotionEnabled, reduceMotionEnabled);
}
