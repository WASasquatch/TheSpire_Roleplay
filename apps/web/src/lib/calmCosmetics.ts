/**
 * Calm Cosmetics — the single gate that quiets expensive equipped cosmetics.
 *
 * Animated name styles and avatar borders (background-position pans on
 * background-clip:text, spinning conic-gradients, animated blurred box-shadows,
 * particle pseudo-elements) force non-compositable per-frame repaints. On a
 * busy room that can be ~150 concurrent infinite animations re-running oklab /
 * gradient color math every frame. The static gradient/stroke/color still reads
 * fine frozen — it's only the motion that's costly — so we freeze (not remove)
 * them under one gate.
 *
 * The gate is ON when ANY of:
 *   - Reduce Motion is on (OS setting or the in-app toggle), OR
 *   - Performance Mode is on (auto-detected low-end device or the manual
 *     override), OR
 *   - the user's explicit "Reduce cosmetic effects" toggle is on.
 *
 * This unifies three independent signals into one `calm-cosmetics` class on
 * <html>; the additive CSS overrides in styles.css key on that class (plus the
 * `.ns-*` / `.b-*` catalog selectors) to freeze animations and swap expensive
 * filters/shadows for cheap ones. Glass / backdrop-filter is intentionally
 * NOT touched here — it stays sacred.
 *
 * The cosmetic-only toggle is its own per-device preference (localStorage), so
 * a user can quiet cosmetics for performance without taking on Reduce Motion's
 * broader "freeze auto-playing motion" behavior, and vice-versa.
 */
import { useSyncExternalStore } from "react";
import { onReduceMotionChange, reduceMotionEnabled } from "./reducedMotion.js";
import { onPerfModeChange, perfModeEnabled } from "./perfMode.js";

const LS_KEY = "tk.reduceCosmetics";

type Listener = () => void;
const listeners = new Set<Listener>();

/** The cosmetics-only manual toggle (independent of Reduce Motion / Perf Mode). */
let cosmeticToggle = readToggle();
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

function compute(): boolean {
  return reduceMotionEnabled() || perfModeEnabled() || cosmeticToggle;
}

function applyRootClass(): void {
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("calm-cosmetics", snapshot);
  }
}

function refresh(): void {
  const next = compute();
  if (next === snapshot) return;
  snapshot = next;
  applyRootClass();
  for (const l of listeners) l();
}

/** Non-reactive read for plain modules. */
export function calmCosmeticsEnabled(): boolean {
  return snapshot;
}

/** The cosmetics-only toggle's own state (independent of the upstream gates),
 *  for the settings control to reflect what the user themselves chose. */
export function getReduceCosmeticsToggle(): boolean {
  return cosmeticToggle;
}

/** Flip the cosmetics-only toggle (persists per-device, refreshes the gate). */
export function setReduceCosmeticsToggle(on: boolean): void {
  cosmeticToggle = on;
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

// Re-derive whenever either upstream gate flips. These subscriptions live for
// the lifetime of the tab (the gate is global), so we never unsubscribe.
onReduceMotionChange(refresh);
onPerfModeChange(refresh);

// Stamp the initial class as soon as this module loads.
applyRootClass();

/** Reactive hook for React components. Re-renders when the calm-cosmetics gate
 *  flips (Reduce Motion, Performance Mode, or the cosmetics-only toggle). */
export function useCalmCosmetics(): boolean {
  return useSyncExternalStore(subscribe, calmCosmeticsEnabled, calmCosmeticsEnabled);
}
