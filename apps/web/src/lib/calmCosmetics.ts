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
import { createPersistedToggleStore } from "./persistedToggleStore.js";
import { onReduceMotionChange, reduceMotionEnabled } from "./reducedMotion.js";
import { onPerfModeChange, perfModeEnabled } from "./perfMode.js";

const LS_KEY = "tk.reduceCosmetics";

const store = createPersistedToggleStore<boolean>({
  storageKey: LS_KEY,
  rootClass: "calm-cosmetics",
  read: (raw) => raw === "1",
  serialize: (on) => (on ? "1" : "0"),
  // ON when either upstream gate is on, or the cosmetics-only toggle is on.
  compute: (cosmeticToggle) =>
    reduceMotionEnabled() || perfModeEnabled() || cosmeticToggle,
});

/** Non-reactive read for plain modules. */
export const calmCosmeticsEnabled = store.enabled;

/** The cosmetics-only toggle's own state (independent of the upstream gates),
 *  for the settings control to reflect what the user themselves chose. */
export const getReduceCosmeticsToggle = store.getToggle;

/** Flip the cosmetics-only toggle (persists per-device, refreshes the gate). */
export const setReduceCosmeticsToggle = store.setToggle;

/** Plain-module subscription to calm-cosmetics flips (any of the three
 *  signals), mirroring {@link onReduceMotionChange}. Returns an
 *  unsubscribe. Used by the cosmetic animation-phase sync to re-anchor
 *  animations recreated when the freeze lifts. */
export const onCalmCosmeticsChange = store.subscribe;

// Re-derive whenever either upstream gate flips. These subscriptions live for
// the lifetime of the tab (the gate is global), so we never unsubscribe.
onReduceMotionChange(store.refresh);
onPerfModeChange(store.refresh);

// Stamp the initial class as soon as this module loads.
store.applyRootClass();

/** Reactive hook for React components. Re-renders when the calm-cosmetics gate
 *  flips (Reduce Motion, Performance Mode, or the cosmetics-only toggle). */
export function useCalmCosmetics(): boolean {
  return store.use();
}
