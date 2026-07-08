/**
 * Factory for the localStorage-backed, `useSyncExternalStore` preference stores
 * that gate global root-class effects (Reduce Motion, Performance Mode, Calm
 * Cosmetics). Each of those modules kept its own hand-rolled copy of the same
 * skeleton — a persisted toggle, a cached boolean snapshot, a listener set, a
 * `<html>` class stamp, and a React hook — differing only in:
 *
 *   - the value shape / serde (a boolean `"1"/"0"` vs a three-state
 *     `'auto'|'on'|'off'`), via {@link PersistedToggleConfig.read} /
 *     {@link PersistedToggleConfig.serialize};
 *   - how the boolean verdict is derived from the toggle, via
 *     {@link PersistedToggleConfig.compute} (a live media-query re-read, a
 *     one-shot hardware verdict, or an OR of two upstream stores);
 *   - the root class it stamps, via {@link PersistedToggleConfig.rootClass}.
 *
 * The factory reproduces each copy's exact behavior; module-load side effects
 * (media-query listeners, upstream subscriptions, the initial class stamp) and
 * the typed public accessors stay in the individual modules so nothing about
 * their observable behavior changes.
 */
import { useSyncExternalStore } from "react";

export interface PersistedToggleConfig<T> {
  /** localStorage key the toggle persists under. */
  storageKey: string;
  /** Class toggled on `<html>` to mirror the current boolean snapshot. */
  rootClass: string;
  /** Parse the stored raw string (or `null` when absent) into the toggle
   *  value. Also used as the fallback when reading storage throws (private
   *  mode) — it is called with `null` in that case. */
  read: (raw: string | null) => T;
  /** Serialize the toggle value for persistence. */
  serialize: (value: T) => string;
  /** Derive the boolean verdict from the current toggle value. Called live on
   *  every {@link PersistedToggleStore.refresh}, so it may read external state
   *  (a media query, other stores) that changes independently of the toggle. */
  compute: (toggle: T) => boolean;
}

export interface PersistedToggleStore<T> {
  /** The user's own toggle value (independent of any derived signals). */
  getToggle: () => T;
  /** Set the toggle (persists per-device, then refreshes). */
  setToggle: (value: T) => void;
  /** Non-reactive read of the cached boolean snapshot. */
  enabled: () => boolean;
  /** Recompute the snapshot; if it changed, stamp the class + notify. */
  refresh: () => void;
  /** Plain-module subscription; returns an unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Stamp the root class from the current snapshot (module-load init). */
  applyRootClass: () => void;
  /** Reactive hook: re-renders when the snapshot flips. */
  use: () => boolean;
}

export function createPersistedToggleStore<T>(
  config: PersistedToggleConfig<T>,
): PersistedToggleStore<T> {
  const listeners = new Set<() => void>();

  function readToggle(): T {
    try {
      return config.read(localStorage.getItem(config.storageKey));
    } catch {
      return config.read(null);
    }
  }

  let toggle = readToggle();
  // Cached so getSnapshot returns a stable value between real changes
  // (useSyncExternalStore requires snapshot stability or it loops).
  let snapshot = config.compute(toggle);

  function enabled(): boolean {
    return snapshot;
  }

  function applyRootClass(): void {
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle(config.rootClass, snapshot);
    }
  }

  function refresh(): void {
    const next = config.compute(toggle);
    if (next === snapshot) return;
    snapshot = next;
    applyRootClass();
    for (const l of listeners) l();
  }

  function getToggle(): T {
    return toggle;
  }

  function setToggle(value: T): void {
    toggle = value;
    try {
      localStorage.setItem(config.storageKey, config.serialize(value));
    } catch {
      /* private mode / storage disabled — honored for this session only */
    }
    refresh();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function use(): boolean {
    return useSyncExternalStore(subscribe, enabled, enabled);
  }

  return { getToggle, setToggle, enabled, refresh, subscribe, applyRootClass, use };
}
