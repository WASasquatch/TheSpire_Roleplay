/**
 * Performance Mode — auto-detection of low-end devices for cosmetic relief.
 *
 * Elaborate equipped cosmetics (animated name styles, spinning/blurred avatar
 * borders) repaint every frame and can pin a weak GPU/CPU at 100%. Capable
 * machines run them fine, so we never degrade the default look there; instead
 * we detect when the *device* is likely to struggle and let the cosmetic gate
 * (lib/calmCosmetics.ts) freeze the worst offenders.
 *
 * Performance Mode is ON when EITHER:
 *   - the user's manual override is 'on', OR
 *   - the override is 'auto' (the default) AND the hardware looks low-end
 *     (few CPU cores or little RAM, via the navigator hints).
 *
 * Unlike Reduce Motion this is a THREE-state preference ('auto' | 'on' | 'off')
 * so a user on a capable machine can still force it on, or a user on a flagged
 * machine can force it off if they'd rather keep the full visuals. 'auto' is the
 * default because most users won't touch the setting and the detection should
 * just work.
 *
 * When ON we add a `low-perf` class to <html>; the cosmetic gate reads
 * {@link perfModeEnabled} / {@link usePerfMode} to fold this into the unified
 * `calm-cosmetics` class. The hardware probe runs once on module load — there's
 * no OS/browser API to listen to for changes, so there's nothing to re-evaluate
 * live the way Reduce Motion listens to the media query.
 */
import { createPersistedToggleStore } from "./persistedToggleStore.js";

const LS_KEY = "tk.perfMode";

/** Manual override states. 'auto' (the default) defers to hardware detection. */
export type PerfToggle = "auto" | "on" | "off";

/**
 * One-shot, side-effect-free read of the device's capability hints. Both
 * `navigator.hardwareConcurrency` and `navigator.deviceMemory` are coarse and
 * may be undefined (older/locked-down browsers), so we guard with capable
 * defaults — when we can't tell, assume the machine is fine and keep full
 * visuals rather than degrading a device that might be perfectly capable.
 *
 *   - hardwareConcurrency <= 4 logical cores  → likely a weak/low-power CPU
 *   - deviceMemory <= 4 GB                     → likely a low-RAM device
 *
 * Either signal flips the verdict. We deliberately keep this to static hints
 * (no rAF FPS probe): a probe at module-load time races app boot and other
 * one-time main-thread work, so it would misread a busy-but-capable machine as
 * low-end. The manual override covers the cases the hints miss.
 */
function detectLowEndDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const cores = navigator.hardwareConcurrency;
  if (typeof cores === "number" && cores > 0 && cores <= 4) return true;
  // `deviceMemory` is non-standard (Chromium-only) and typed loosely; read it
  // defensively so the heuristic just no-ops where the hint is absent.
  const ram = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof ram === "number" && ram > 0 && ram <= 4) return true;
  return false;
}

/** Hardware verdict, computed once on load (see {@link detectLowEndDevice}). */
const lowEndDevice = detectLowEndDevice();

const store = createPersistedToggleStore<PerfToggle>({
  storageKey: LS_KEY,
  rootClass: "low-perf",
  read: (raw) => (raw === "on" || raw === "off" ? raw : "auto"),
  serialize: (val) => val,
  // 'on'/'off' force the verdict; 'auto' defers to the one-shot hardware probe.
  compute: (toggle) => {
    if (toggle === "on") return true;
    if (toggle === "off") return false;
    return lowEndDevice; // 'auto'
  },
});

/** Non-reactive read for plain modules (the cosmetic-gate combiner). */
export const perfModeEnabled = store.enabled;

/** The user's own three-state choice, for the settings control to reflect. */
export const getPerfModeToggle = store.getToggle;

/** Whether the hardware probe flagged this device as low-end (independent of
 *  the manual override), so the UI can explain why 'auto' is active. */
export function lowEndDeviceDetected(): boolean {
  return lowEndDevice;
}

/** Set the manual override (persists per-device, updates <html> + subscribers). */
export const setPerfModeToggle = store.setToggle;

/** Plain-module subscription to Performance Mode changes (the user changing
 *  the override), so combiners like {@link import('./calmCosmetics')} can
 *  re-derive without React. Returns an unsubscribe. */
export const onPerfModeChange = store.subscribe;

// Stamp the initial class as soon as this module loads.
store.applyRootClass();

/** Reactive hook for React components. Re-renders when Performance Mode flips
 *  (the user changing the override). */
export function usePerfMode(): boolean {
  return store.use();
}
