/**
 * Per-room in-memory theater (watch-party) playback state.
 *
 * Sibling of `moodState.ts` / `awayState.ts`: live, in-process, wiped on
 * server restart. We keep the constantly-changing playback position OUT
 * of SQLite on purpose - only the room's CONFIG (mode, playlist, loop)
 * persists (see schema `rooms.theater_*`). This module owns the volatile
 * bits: which playlist index is loaded, whether it's playing, and the
 * position anchor used for drift extrapolation on the clients.
 *
 * Keyed by roomId (theater playback is room-scoped, not per-identity).
 * Cleared via `clearTheater` when a room is archived or theater mode is
 * turned off.
 */
import type { TheaterLoop, TheaterSource, TheaterSync } from "@thekeep/shared";

export interface TheaterState {
  /** Index into the room's persisted playlist that is loaded. */
  index: number;
  isPlaying: boolean;
  /** Position (seconds) captured at `updatedAtMs`. */
  positionSec: number;
  /** Server clock (ms epoch) when `positionSec`/`isPlaying` were set. */
  updatedAtMs: number;
  /**
   * When the loaded index last changed. Used to debounce duplicate
   * `ended` reports: several owner/mod tabs can each fire `ended` for
   * the same source, and a stale `ended` can land just after a manual
   * skip. Any `ended` arriving within ENDED_DEBOUNCE_MS of the last
   * index change is ignored so the playlist advances exactly once.
   */
  lastIndexChangeAt: number;
  /**
   * Consecutive sources skipped via `error` (dead / unembeddable) without a
   * successful play in between. Reset to 0 whenever a source plays to its end
   * (`ended`) or a human issues any control. If it reaches the playlist length
   * the whole list is effectively dead, so we STOP rather than hot-loop
   * skipping forever.
   */
  errorSkips: number;
}

export type TheaterAction = "play" | "pause" | "seek" | "next" | "prev" | "select" | "ended" | "error" | "progress";

const ENDED_DEBOUNCE_MS = 2000;

const byRoom = new Map<string, TheaterState>();

function defaultState(now: number): TheaterState {
  return { index: 0, isPlaying: false, positionSec: 0, updatedAtMs: now, lastIndexChangeAt: now, errorSkips: 0 };
}

export function getTheater(roomId: string): TheaterState | null {
  return byRoom.get(roomId) ?? null;
}

/**
 * Build the wire payload for `theater:sync` from the room's live state,
 * or null when there is no live state yet (nothing has played). The
 * position anchor `serverTimeMs` is the stored `updatedAtMs`, so a client
 * receiving this minutes later still extrapolates the correct position.
 * Shared by the room-wide broadcast and the per-socket emit on join.
 */
export function theaterSyncPayload(roomId: string): ({ roomId: string } & TheaterSync) | null {
  const st = byRoom.get(roomId);
  if (!st) return null;
  return {
    roomId,
    index: st.index,
    isPlaying: st.isPlaying,
    positionSec: st.positionSec,
    serverTimeMs: st.updatedAtMs,
  };
}

/** Defensively parse the persisted `rooms.theater_playlist` JSON column. */
export function parsePlaylist(json: string | null | undefined): TheaterSource[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (s): s is TheaterSource =>
        !!s && typeof s.id === "string" && typeof s.url === "string" && typeof s.kind === "string",
    );
  } catch {
    return [];
  }
}

export function serializePlaylist(list: TheaterSource[]): string {
  return JSON.stringify(list);
}

/* ============================================================
 *  Persisted playback checkpoint (rooms.theater_playback).
 *
 *  The live state above is in-memory and dies with the process. To
 *  survive a restart we periodically (and on each control) snapshot the
 *  current EXTRAPOLATED position into the room row, and rehydrate it on
 *  boot. Crucially, hydrate() re-anchors `updatedAtMs` to boot time so
 *  the server-down window is treated as a PAUSE - playback resumes from
 *  the checkpointed position rather than being fast-forwarded by the
 *  outage length ("continue relatively where people were").
 * ============================================================ */

export interface TheaterCheckpoint {
  index: number;
  positionSec: number;
  isPlaying: boolean;
  /** When this checkpoint was taken (server clock, ms). */
  updatedAtMs: number;
}

/** Current live position of a state, extrapolated while playing. */
function livePosition(st: TheaterState, now: number): number {
  if (!st.isPlaying) return st.positionSec;
  return st.positionSec + (now - st.updatedAtMs) / 1000;
}

/** Snapshot the room's current (extrapolated) playback for persistence,
 *  or null when there's no live state to save. */
export function checkpointFor(roomId: string, now: number): TheaterCheckpoint | null {
  const st = byRoom.get(roomId);
  if (!st) return null;
  return {
    index: st.index,
    positionSec: Math.max(0, livePosition(st, now)),
    isPlaying: st.isPlaying,
    updatedAtMs: now,
  };
}

/** Room ids that currently have live state (drives the periodic sweep). */
export function theaterRoomIds(): string[] {
  return [...byRoom.keys()];
}

/** Load a persisted checkpoint into the live map on boot. Re-anchors the
 *  clock to `now` so resume is from the checkpointed position, not
 *  fast-forwarded by however long the process was down. */
export function hydrate(roomId: string, cp: TheaterCheckpoint, now: number): void {
  byRoom.set(roomId, {
    index: cp.index,
    positionSec: Math.max(0, cp.positionSec),
    isPlaying: cp.isPlaying,
    updatedAtMs: now,
    lastIndexChangeAt: now,
    errorSkips: 0,
  });
}

export function parseCheckpoint(json: string | null | undefined): TheaterCheckpoint | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    if (!v || typeof v !== "object") return null;
    if (typeof v.index !== "number" || typeof v.positionSec !== "number" || typeof v.isPlaying !== "boolean") {
      return null;
    }
    return {
      index: v.index,
      positionSec: v.positionSec,
      isPlaying: v.isPlaying,
      updatedAtMs: typeof v.updatedAtMs === "number" ? v.updatedAtMs : 0,
    };
  } catch {
    return null;
  }
}

export function serializeCheckpoint(cp: TheaterCheckpoint): string {
  return JSON.stringify(cp);
}

/** Force a specific state (used when a playlist edit shifts the active index). */
export function setTheater(roomId: string, state: TheaterState): void {
  byRoom.set(roomId, state);
}

export function clearTheater(roomId: string): void {
  byRoom.delete(roomId);
}

function clampIndex(index: number, len: number): number {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(index, len - 1));
}

/**
 * Apply a controller action to the room's live playback state and return
 * the new state. Pure index/position math lives here so the socket
 * handler stays thin. `len` is the current playlist length; `loop` the
 * room's loop setting (governs `ended` advancement).
 *
 * Returns the unchanged/initialized state when there is nothing to play
 * (empty playlist) or when an `ended` is debounced away.
 */
export function applyControl(
  roomId: string,
  action: TheaterAction,
  opts: { positionSec?: number | undefined; index?: number | undefined; len: number; loop: TheaterLoop; now: number },
): TheaterState {
  const { len, loop, now } = opts;
  const prev = byRoom.get(roomId) ?? defaultState(now);
  const next: TheaterState = { ...prev };

  const advance = (delta: number) => {
    if (len <= 0) return;
    if (loop === "all") next.index = ((prev.index + delta) % len + len) % len;
    else next.index = clampIndex(prev.index + delta, len);
    next.positionSec = 0;
    next.isPlaying = true;
    next.updatedAtMs = now;
    next.lastIndexChangeAt = now;
  };

  // A human control or a clean end-of-source means playback is healthy again,
  // so the dead-source skip chain resets. (The `error` branch is the only one
  // that grows it.)
  const resetErrorChain = () => { next.errorSkips = 0; };

  switch (action) {
    case "play":
      next.isPlaying = true;
      next.positionSec = opts.positionSec ?? prev.positionSec;
      next.updatedAtMs = now;
      resetErrorChain();
      break;
    case "pause":
      next.isPlaying = false;
      next.positionSec = opts.positionSec ?? prev.positionSec;
      next.updatedAtMs = now;
      resetErrorChain();
      break;
    case "seek":
      next.positionSec = Math.max(0, opts.positionSec ?? 0);
      next.updatedAtMs = now;
      resetErrorChain();
      break;
    case "progress": {
      // Re-anchor to the controller's REAL position so wall-clock
      // extrapolation can't drift ahead of the actual frame over a long
      // video. No index / play-state change. Ignore a stale report for a
      // source that's already been advanced past.
      if (opts.index !== undefined && opts.index !== prev.index) break;
      if (opts.positionSec === undefined) break;
      next.positionSec = Math.max(0, opts.positionSec);
      next.updatedAtMs = now;
      break;
    }
    case "select": {
      next.index = clampIndex(opts.index ?? 0, len);
      next.positionSec = 0;
      next.isPlaying = true;
      next.updatedAtMs = now;
      next.lastIndexChangeAt = now;
      resetErrorChain();
      break;
    }
    case "next":
      advance(1);
      resetErrorChain();
      break;
    case "prev":
      advance(-1);
      resetErrorChain();
      break;
    case "ended": {
      // Ignore a report about a source that is no longer the live one
      // (stale / duplicate from another viewer after we already advanced).
      if (opts.index !== undefined && opts.index !== prev.index) break;
      // Debounce duplicate / stale end-of-source reports (also covers the
      // loop-"one" repeat case, where the index never changes to self-dedup).
      if (now - prev.lastIndexChangeAt < ENDED_DEBOUNCE_MS) break;
      // A source played through cleanly → the dead-skip chain is broken.
      resetErrorChain();
      if (loop === "one") {
        next.positionSec = 0;
        next.isPlaying = true;
        next.updatedAtMs = now;
        next.lastIndexChangeAt = now;
      } else if (loop === "all") {
        advance(1);
      } else {
        // loop "off": advance until the end, then stop on the last source.
        if (prev.index + 1 < len) {
          advance(1);
        } else {
          next.isPlaying = false;
          next.updatedAtMs = now;
        }
      }
      break;
    }
    case "error": {
      if (len <= 0) break;
      // Only the live source's failure matters; a stale report for an
      // already-skipped index is ignored (this also dedups multiple viewers
      // reporting the same dead source, the first advances the index).
      if (opts.index !== undefined && opts.index !== prev.index) break;
      const skips = prev.errorSkips + 1;
      if (skips >= len) {
        // Every source failed in a row → the whole playlist is dead. Stop
        // instead of hot-looping through dead sources forever; a human can
        // re-queue / hit play to retry (which resets the chain).
        next.isPlaying = false;
        next.updatedAtMs = now;
        next.errorSkips = 0;
        break;
      }
      // Skip the dead source. Always step FORWARD regardless of loop mode,
      // repeating a dead source under loop "one" would wedge playback.
      if (loop === "all") {
        next.index = ((prev.index + 1) % len + len) % len;
      } else if (prev.index + 1 < len) {
        next.index = prev.index + 1;
      } else {
        // loop "off"/"one" on the last source with nothing after it → stop.
        next.isPlaying = false;
        next.updatedAtMs = now;
        next.errorSkips = 0;
        break;
      }
      next.positionSec = 0;
      next.isPlaying = true;
      next.updatedAtMs = now;
      next.lastIndexChangeAt = now;
      next.errorSkips = skips;
      break;
    }
  }

  byRoom.set(roomId, next);
  return next;
}
