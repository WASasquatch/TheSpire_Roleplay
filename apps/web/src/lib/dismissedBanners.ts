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
 * suffix makes every existing entry inert and forces re-dismissal,
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

/** key → dismissedAt (ms epoch). The timestamp powers optional TTL
 *  expiry: a caller that passes `ttlMs` (e.g. the announcement marquee's
 *  24h) re-shows once the dismissal ages past it; callers that omit it
 *  keep the old "dismissed forever" behavior. */
type Dismissals = Record<string, number>;

function read(): Dismissals {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Legacy shape was a `string[]` of keys with no timestamp. Migrate
    // each to epoch 0: permanent (no-TTL) banners stay dismissed (key
    // present), TTL banners read as long-expired and re-show once.
    if (Array.isArray(parsed)) {
      const out: Dismissals = {};
      for (const s of parsed) if (typeof s === "string") out[s] = 0;
      return out;
    }
    if (parsed && typeof parsed === "object") {
      const out: Dismissals = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === "number") out[k] = v;
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function write(map: Dismissals): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / private-mode, silently degrade to per-mount only */
  }
}

function notify(): void {
  for (const l of listeners) l();
}

/**
 * Pure imperative read, useful for non-React call sites (one-shot
 * checks before mounting heavy chrome). React components should
 * prefer `useDismissed` so they re-render when a sibling tab or a
 * different banner dispatches a dismissal.
 *
 * `ttlMs`: when given, a dismissal older than this counts as expired
 * (returns false). Omit for a permanent dismissal.
 */
export function isDismissed(key: string, ttlMs?: number): boolean {
  const ts = read()[key];
  if (ts === undefined) return false;
  if (ttlMs === undefined) return true;
  return Date.now() - ts < ttlMs;
}

/** Raw dismissal timestamp (ms epoch) for `key`, or null when not
 *  dismissed. Lets a TTL caller schedule a re-show at the exact expiry
 *  boundary instead of waiting for the next reload. */
export function dismissedAt(key: string): number | null {
  const ts = read()[key];
  return ts === undefined ? null : ts;
}

export function dismiss(key: string): void {
  const map = read();
  // Always (re)stamp now, so re-dismissing a TTL banner refreshes its
  // window rather than keeping a stale timestamp.
  map[key] = Date.now();
  write(map);
  notify();
}

/** Remove a key from the dismissed set (resurrect / "show this again"
 *  flows, and TTL-expiry cleanup). */
export function undismiss(key: string): void {
  const map = read();
  if (!(key in map)) return;
  delete map[key];
  write(map);
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
 * React hook, returns `true` iff `key` is in the persisted set.
 * Re-renders the calling component when a dismissal lands (from
 * this tab OR a sibling tab via the `storage` event).
 */
export function useDismissed(key: string, ttlMs?: number): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isDismissed(key, ttlMs),
    () => false, // SSR default, banners stay visible until hydration
  );
}

function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  // Cross-tab sync via the `storage` event, only fires for OTHER
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
