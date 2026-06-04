/**
 * localStorage-backed close-state for chat banners. Every closeable
 * banner / toast / notice in the shell should route its close button
 * through here so the dismissal persists across reloads and tab
 * swaps for as long as the viewer's browser keeps localStorage.
 *
 * Each dismissable surface picks a stable string key (e.g.
 * `"announcement-marquee"`, `"stale-version:0.20.4"`,
 * `"earning:rankup:tier-3"`); calling `dismiss(key)` writes it into
 * the persisted set and `isDismissed(key)` reads it. The set itself
 * lives at one localStorage entry (`tk:dismissedBanners:v1`) keyed
 * by an array of strings, so a tab whose set has been edited by a
 * sibling tab picks up the change on the next read.
 *
 * Versioned key prefix (`v1`): if the dismissal vocabulary ever
 * needs a reset (e.g. we add structured payloads), bumping the
 * suffix makes every existing entry inert and forces re-dismissal —
 * the same posture `tk:lastActiveTheme:v2` already uses.
 *
 * Subscribing components can re-read via `useDismissed(key)`; the
 * helper is a thin wrapper around `useSyncExternalStore` so a
 * dismissal lands across every mounted banner on the same tick.
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "tk:dismissedBanners:v1";

type Listener = () => void;
const listeners = new Set<Listener>();

function read(): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((s): s is string => typeof s === "string"));
  } catch {
    return new Set();
  }
}

function write(set: Set<string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    /* quota / private-mode — silently degrade to per-mount only */
  }
}

function notify(): void {
  for (const l of listeners) l();
}

/**
 * Pure imperative read — useful for non-React call sites (one-shot
 * checks before mounting heavy chrome). React components should
 * prefer `useDismissed` so they re-render when a sibling tab or a
 * different banner dispatches a dismissal.
 */
export function isDismissed(key: string): boolean {
  return read().has(key);
}

export function dismiss(key: string): void {
  const set = read();
  if (set.has(key)) return;
  set.add(key);
  write(set);
  notify();
}

/** Remove a key from the dismissed set (rare — admin tooling, "show
 *  this banner again" flows). */
export function undismiss(key: string): void {
  const set = read();
  if (!set.delete(key)) return;
  write(set);
  notify();
}

/** Wipe the entire dismissed set. Reserved for the user-settings
 *  "reset all banner dismissals" affordance. */
export function clearAllDismissed(): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* swallow */ }
  notify();
}

/**
 * React hook — returns `true` iff `key` is in the persisted set.
 * Re-renders the calling component when a dismissal lands (from
 * this tab OR a sibling tab via the `storage` event).
 */
export function useDismissed(key: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isDismissed(key),
    () => false, // SSR default — banners stay visible until hydration
  );
}

function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  // Cross-tab sync via the `storage` event — only fires for OTHER
  // tabs (the firing tab gets notified by `notify()` above), and
  // only when the value actually changed.
  function onStorage(e: StorageEvent) {
    if (e.key === STORAGE_KEY) cb();
  }
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(cb);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}
