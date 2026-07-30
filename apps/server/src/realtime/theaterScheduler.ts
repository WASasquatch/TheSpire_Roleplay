/**
 * Server-side theater (watch-party) advance timer.
 *
 * The playlist otherwise only advances when a real browser's react-player
 * fires `onEnded` and reports it. That means an EMPTY room (no client, hence
 * no player) freezes on one source forever while the server keeps
 * extrapolating its position past the real end - the "come back a day later
 * and the playlist is wedged" bug. The server has no idea how long a video is
 * on its own, so we cache each source's length (`TheaterSource.durationSec`,
 * learned from the YouTube Data API or a controller's `onDuration`) and run a
 * single per-room timer that fires `ended` when the extrapolated position
 * crosses that length - independent of whether anyone is watching.
 *
 * Deliberately a BACKSTOP, not the primary advancer: the timer is set a hair
 * PAST the true end ({@link SCHEDULE_SAFETY_SEC}), so when someone IS watching
 * their player's `onEnded` fires first and advances; this timer then sees the
 * index already moved and no-ops (the `ended` state machine validates the
 * reported index + debounces). It only actually bites for an empty room, or a
 * backgrounded tab whose player the browser paused. Live sources and sources
 * of unknown length carry no timer and are left to client reports.
 *
 * The timer is reconciled (cancelled + recomputed) after every state change -
 * play/pause/seek/select/advance, a playlist edit, a newly-learned duration,
 * and each periodic sweep - so a manual pause stops it and a manual seek
 * re-aims it from the new position.
 */
import { eq } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { rooms } from "../db/schema.js";
import { broadcastTheaterSync, persistTheaterCheckpoint } from "./broadcast/presence.js";
import { applyControl, getTheater, parsePlaylist, serializePlaylist, theaterRoomIds } from "./theaterState.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** Fire the auto-advance this many seconds AFTER the source's true end, so a
 *  watching client's `onEnded` (the ground truth when someone is present) wins
 *  the race and this timer only backstops the empty / backgrounded case. */
const SCHEDULE_SAFETY_SEC = 2;
/** In `fire`, only advance when the extrapolated position is genuinely within
 *  this of the end - guards a stale timer that outlived a backward seek. */
const END_GRACE_SEC = 1.5;
/** Ignore absurdly short "durations": a sub-5s source would fight the 2s
 *  ended-debounce in the state machine and could hot-loop. Real playlist
 *  entries are far longer; this only screens out bad/degenerate values. */
const MIN_TIMER_DURATION_SEC = 5;
/** Clamp a cached duration so a bogus value can't schedule a runaway timer
 *  (and can't overflow setTimeout's 32-bit delay). 24h covers any real video. */
const MAX_DURATION_SEC = 24 * 3600;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Stop the room's pending auto-advance, if any. */
export function cancelTheaterTimer(roomId: string): void {
  const t = timers.get(roomId);
  if (t) {
    clearTimeout(t);
    timers.delete(roomId);
  }
}

/** Extrapolated playback position (seconds) right now while playing. */
function livePosition(st: { isPlaying: boolean; positionSec: number; updatedAtMs: number }, now: number): number {
  if (!st.isPlaying) return st.positionSec;
  return st.positionSec + (now - st.updatedAtMs) / 1000;
}

interface TheaterRoomRow {
  theaterMode: boolean;
  theaterLoop: "off" | "one" | "all";
  theaterPlaylist: string | null;
}

async function loadRoom(db: Db, roomId: string): Promise<TheaterRoomRow | null> {
  const row = (
    await db
      .select({ theaterMode: rooms.theaterMode, theaterLoop: rooms.theaterLoop, theaterPlaylist: rooms.theaterPlaylist })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1)
  )[0];
  return row ?? null;
}

/**
 * The seconds until the CURRENT source should auto-advance, or null when no
 * timer applies (paused, live, unknown/short length, or loop-off on the last
 * source with nothing after it). Shared by schedule + fire so their notion of
 * "should this advance, and when" can't drift apart.
 */
function secondsUntilAdvanceFor(
  st: NonNullable<ReturnType<typeof getTheater>>,
  room: TheaterRoomRow,
  now: number,
): number | null {
  if (!room.theaterMode || !st.isPlaying) return null;
  const playlist = parsePlaylist(room.theaterPlaylist);
  if (playlist.length === 0) return null;
  const src = playlist[st.index];
  if (!src) return null;
  if (src.live || src.kind === "live") return null; // no fixed end
  const dur = Math.min(src.durationSec ?? 0, MAX_DURATION_SEC);
  if (!Number.isFinite(dur) || dur < MIN_TIMER_DURATION_SEC) return null;
  // loop "off" on the last source stops rather than advancing - no timer.
  if (room.theaterLoop === "off" && st.index >= playlist.length - 1) return null;
  const remaining = dur - livePosition(st, now) + SCHEDULE_SAFETY_SEC;
  return Math.max(0, remaining);
}

/**
 * Cancel and (re)arm the room's auto-advance timer to match current state.
 * Cheap and idempotent - safe to call after any theater state change.
 */
export async function reconcileTheaterTimer(io: Io, db: Db, roomId: string): Promise<void> {
  cancelTheaterTimer(roomId);
  const st = getTheater(roomId);
  if (!st || !st.isPlaying) return;
  const room = await loadRoom(db, roomId);
  if (!room) return;
  const now = Date.now();
  const secs = secondsUntilAdvanceFor(st, room, now);
  if (secs === null) return;
  const delayMs = Math.min(secs * 1000, MAX_DURATION_SEC * 1000);
  const timer = setTimeout(() => {
    void fire(io, db, roomId).catch(() => {
      /* swallow: a failed advance shouldn't crash the process; the next
         control event (or sweep) reconciles the timer again. */
    });
  }, delayMs);
  timer.unref?.();
  timers.set(roomId, timer);
}

/** Timer callback: advance the playlist as if a client reported `ended`. */
async function fire(io: Io, db: Db, roomId: string): Promise<void> {
  timers.delete(roomId);
  const st = getTheater(roomId);
  if (!st || !st.isPlaying) return;
  const room = await loadRoom(db, roomId);
  if (!room || !room.theaterMode) return;
  const playlist = parsePlaylist(room.theaterPlaylist);
  const src = playlist[st.index];
  if (!src || src.live || src.kind === "live") return;
  const dur = Math.min(src.durationSec ?? 0, MAX_DURATION_SEC);
  if (!Number.isFinite(dur) || dur < MIN_TIMER_DURATION_SEC) return;
  const now = Date.now();
  // Defensive: if a backward seek left the real position well short of the end
  // (and somehow didn't reschedule), don't advance early - just re-aim.
  if (livePosition(st, now) < dur - END_GRACE_SEC) {
    await reconcileTheaterTimer(io, db, roomId);
    return;
  }
  applyControl(roomId, "ended", { index: st.index, len: playlist.length, loop: room.theaterLoop, now });
  await broadcastTheaterSync(io, roomId);
  await persistTheaterCheckpoint(db, roomId);
  // Arm the next source's timer (or clear it, if we just stopped on loop-off).
  await reconcileTheaterTimer(io, db, roomId);
}

/**
 * Cache a learned length onto a playlist source and reconcile the timer. Called
 * from a controller's `duration` report and the YouTube backfill. Keyed by the
 * live playlist index; bounds-checked and a no-op for live sources or a value
 * that matches what we already have.
 */
export async function recordTheaterSourceDuration(
  io: Io,
  db: Db,
  roomId: string,
  index: number,
  durationSec: number,
): Promise<void> {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return;
  const dur = Math.min(Math.round(durationSec), MAX_DURATION_SEC);
  const room = await loadRoom(db, roomId);
  if (!room || !room.theaterMode) return;
  const list = parsePlaylist(room.theaterPlaylist);
  const src = list[index];
  if (!src || src.live || src.kind === "live") return;
  const existing = src.durationSec;
  // Set when unknown; refine only when the new reading differs by > 1s.
  if (typeof existing === "number" && Math.abs(existing - dur) <= 1) return;
  list[index] = { ...src, durationSec: dur };
  await db.update(rooms).set({ theaterPlaylist: serializePlaylist(list) }).where(eq(rooms.id, roomId));
  await reconcileTheaterTimer(io, db, roomId);
}

/**
 * Reconcile every live theater room's timer. Run at boot (after checkpoints
 * rehydrate) and on each periodic sweep, so a room picks up a duration the
 * async backfill learned after boot, and any timer lost to a transient error
 * self-heals within one sweep interval.
 */
export async function reconcileAllTheaterTimers(io: Io, db: Db): Promise<void> {
  for (const roomId of theaterRoomIds()) {
    await reconcileTheaterTimer(io, db, roomId);
  }
}
