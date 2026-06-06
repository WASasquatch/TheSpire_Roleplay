/**
 * Theater mode (synchronized watch-party) shared types.
 *
 * A room with `theaterMode` on shows a video panel above the chat. The
 * owner/mods drive playback (play/pause/seek/advance) and every other
 * occupant's player follows in lockstep. The room carries an ordered
 * PLAYLIST of sources plus a LOOP setting; when a source ends the
 * controller's player auto-advances (the server owns the index).
 *
 * Split of responsibilities:
 *   - CONFIG  (mode on/off, playlist, loop) persists as columns on the
 *     `rooms` table and rides along on `RoomSummary`.
 *   - LIVE    (current index, isPlaying, position) lives only in server
 *     memory (see realtime/theaterState.ts) and is pushed to clients via
 *     the `theater:sync` socket event. It is intentionally NOT persisted -
 *     per-tick playback position must never touch SQLite.
 */

/**
 * How a source URL is played:
 *   "video"   - direct file (mp4/webm) or HLS (.m3u8); precise seek sync.
 *   "youtube" - YouTube watch/share/embed URL; synced via the iframe API.
 *   "vimeo"   - Vimeo URL; synced via the Vimeo player.
 *   "embed"   - anything else; rendered display-only (no fine sync /
 *               auto-advance) as a best-effort fallback.
 */
export type TheaterSourceKind = "video" | "youtube" | "vimeo" | "embed";

export interface TheaterSource {
  /** Stable id so the client can key list rows across reorders. */
  id: string;
  /** The media address, shown to everyone so they can copy/bookmark it. */
  url: string;
  kind: TheaterSourceKind;
  /** Optional owner-supplied label; falls back to the URL in the UI. */
  title?: string;
}

/**
 * Continuous-playback behavior when a source ends:
 *   "off" - stop at the end of the current source.
 *   "one" - repeat the current source forever.
 *   "all" - advance through the playlist and loop back to the start
 *           (the default; "continuous playback" the user asked for).
 */
export type TheaterLoop = "off" | "one" | "all";

/**
 * Live playback state broadcast to every client in the room. `positionSec`
 * is anchored at `serverTimeMs`; while `isPlaying` is true clients
 * extrapolate the expected position as
 *   positionSec + (Date.now() - serverTimeMs) / 1000
 * and only seek when local drift exceeds the tolerance (~1.5s).
 */
export interface TheaterSync {
  /** Index into the room's playlist that is currently loaded. */
  index: number;
  isPlaying: boolean;
  positionSec: number;
  /** Server clock (ms epoch) at which `positionSec` was captured. */
  serverTimeMs: number;
}
