import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactPlayer from "react-player";
import type { Socket } from "socket.io-client";
import type { ClientToServerEvents, RoomSummary, ServerToClientEvents } from "@thekeep/shared";
import { useChat } from "../state/store.js";

/**
 * Theater (watch-party) panel.
 *
 * Renders the room's shared video above the chat. The server owns the
 * authoritative playback state (which playlist index, playing/paused,
 * position) and pushes it via `theater:sync`; this component makes the
 * local player follow it, correcting drift. Owners/mods (`canControl`)
 * get a control bar that emits `theater:control`; everyone else watches.
 * Any occupant can fire floating emoji reactions.
 *
 * The panel is vertically resizable via a drag handle on its bottom edge;
 * the height persists per-device and the chat below takes the rest.
 */

type ControlAction = "play" | "pause" | "seek" | "next" | "prev" | "select" | "ended" | "error" | "progress";

interface Props {
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  roomId: string;
  room: RoomSummary;
  /** True for room owner/mods (and the site-wide grant): drives playback. */
  canControl: boolean;
  /** Opens the Help modal to the Theater streaming guide (owner/mod link). */
  onShowStreamGuide?: () => void;
}

const HEIGHT_KEY = "tk:theaterHeight:v1";
const MIN_HEIGHT = 160;
const DEFAULT_HEIGHT = 340;
// Re-seek only when the local player drifts past this from the expected
// position. Small enough to feel synced, loose enough to ignore the
// sub-second jitter of normal playback + network latency.
const DRIFT_TOLERANCE_SEC = 1.5;
// After issuing a seek, ignore drift for this long so the player (YouTube
// especially) can finish buffering and report an accurate time before we
// judge it again. Without this, a seek that's slow to land reads as fresh
// drift on the next tick and we seek again, thrashing near the start.
const SEEK_COOLDOWN_MS = 3000;
// Automatic drift-correction never seeks into the final N seconds of a source.
// Seeking to the very end trips the player's `ended` and skips the video; only
// natural playback reaching the end should advance the playlist.
const DRIFT_END_MARGIN_SEC = 10;
// How often the controlling client reports its REAL playback position so the
// server re-anchors instead of extrapolating from wall-clock alone (which
// drifts ahead over a long video as buffering accumulates).
const POSITION_HEARTBEAT_MS = 10_000;
// Live streams have no shared timeline; instead of converging on a
// position anchor we keep each player near the broadcast's live edge.
// Only re-seek to the edge when more than this far behind, so normal
// HLS buffer jitter doesn't cause constant re-seeks.
const LIVE_EDGE_TOLERANCE_SEC = 6;
// A genuine end-of-source means the player is actually NEAR the end. react-
// player (YouTube especially) fires `onEnded` spuriously near the START on a
// buffering hiccup, an embed/playback error, or right after a programmatic
// seek. Acting on those makes the server advance/repeat the playlist every
// couple seconds, which is exactly the "stuck looping the first few seconds,
// never actually playing through" bug. We only forward `ended` when the
// reported position is within this of the duration; genuine ends (and very
// short clips, where duration <= this) still pass, the false alarms don't.
const END_REACHED_GRACE_SEC = 2.5;
const QUICK_REACTIONS = ["❤️", "😂", "🔥", "👏", "😮", "👍", "😭", "🎉"];

function loadHeight(): number {
  try {
    const raw = localStorage.getItem(HEIGHT_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? Math.max(MIN_HEIGHT, n) : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

// Deterministic pseudo-random in [0,1) from an integer id. Each reaction
// gets a STABLE scatter offset / wobble / duration keyed on its id, so it
// looks random across a burst but doesn't re-roll (and jump) on every
// render. Classic sine-hash; the multipliers just decorrelate the three
// derived values from one another.
function hashUnit(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function TheaterPanel({ socket, roomId, room, canControl, onShowStreamGuide }: Props) {
  const playlist = room.theaterPlaylist;
  const sync = useChat((s) => s.theaterSyncByRoom[roomId]);
  const reactions = useChat((s) => s.theaterReactions);
  const dropTheaterReaction = useChat((s) => s.dropTheaterReaction);
  // The streaming guide is gated to theater hosts in the Help modal, so
  // only surface the links to it for users who'd actually see the guide.
  const canSeeStreamGuide = useChat((s) => s.me?.permissions.includes("use_theater_mode") ?? false);

  const playerRef = useRef<ReactPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [played, setPlayed] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  // Start muted so the browser allows autoplay; the viewer opts into
  // audio with the one-tap unmute overlay. (Autoplay WITH sound is
  // blocked until a user gesture, which would otherwise leave late
  // joiners on a silently-paused player.)
  const [muted, setMuted] = useState(true);
  const [height, setHeight] = useState(loadHeight);

  const safeIndex = playlist.length > 0 ? Math.min(sync?.index ?? 0, playlist.length - 1) : 0;
  const current = playlist[safeIndex] ?? null;
  const isPlaying = sync?.isPlaying ?? false;
  const isEmbed = current?.kind === "embed";
  // Live streams: no shared timeline (no seek bar, no drift-to-position,
  // no auto-advance on a momentary drop); everyone tracks the live edge.
  // Two flavors: a raw HLS stream (`kind: "live"`, hls.js backend) and a
  // YouTube/Vimeo live broadcast (`live` flag, iframe-API backend). Both want
  // live BEHAVIOR; only the raw-stream one wants the hls BACKEND (see
  // `needsHls`). A YouTube live that lacks this flag (added via `/theater add`)
  // falls through to the VOD position-sync path and bounces around — the bug.
  const isLive = current?.kind === "live" || !!current?.live;

  // Expected playback position right now: the anchored position plus the
  // elapsed wall-clock since the server captured it (while playing).
  //
  // The elapsed term is clamped to >= 0: a playing source can never be
  // BEFORE the position the server anchored it at. A viewer whose local
  // clock runs behind the server's would otherwise compute a negative
  // elapsed (target below the anchor / near zero), and the drift loop
  // would "correct" toward it by seeking back to the start over and over,
  // which is the "stuck repeating the first few seconds" bug.
  const expectedPosition = useCallback((): number => {
    if (!sync) return 0;
    const base = !sync.isPlaying
      ? Math.max(0, sync.positionSec)
      : sync.positionSec + Math.max(0, (Date.now() - sync.serverTimeMs) / 1000);
    // Never extrapolate past the video's length. Over a long video, buffering
    // stalls make the wall-clock term outrun the real frame; without this cap
    // the drift logic would seek toward a position beyond the end (mis-drawing
    // the bar and tripping a premature auto-advance). The controller heartbeat
    // below keeps `positionSec` itself honest; this is the belt-and-suspenders.
    return duration > 0 ? Math.min(base, duration) : base;
  }, [sync, duration]);

  // Whether the current source has produced real playback (a progress tick
  // past 0). Distinguishes a DEAD source (errors before ever playing → we
  // skip it) from a transient mid-playback error (don't skip for everyone
  // over one viewer's network hiccup). Reset on every source change.
  const startedRef = useRef(false);

  // All seeks route through here so we can stamp the time (for the
  // post-seek cooldown) and never seek to a negative position.
  const lastSeekAtRef = useRef(0);
  const seekTo = useCallback((sec: number) => {
    const p = playerRef.current;
    if (!p) return;
    p.seekTo(Math.max(0, sec), "seconds");
    lastSeekAtRef.current = Date.now();
  }, []);

  // Stable config identity. A fresh object here on every render (and the
  // panel re-renders ~once/sec from onProgress + reactions) made
  // react-player re-init the YouTube iframe, which reloads the video to
  // the start - one of the ways playback got stuck at the first seconds.
  //
  // `playsinline` / `playsInline` are load-bearing on iOS (iPad/iPhone
  // Safari): WITHOUT them iOS hijacks the video into its native fullscreen
  // player, where our shared-position seeks don't reach the element, so each
  // iPad plays its own timeline and drifts out of sync. Android Chrome plays
  // inline by default, which is why it already syncs. We set both the YouTube
  // playerVar (`playsinline: 1`) and the underlying <video> attribute used by
  // the file/HLS player (`playsInline: true`) so direct files + live HLS get
  // it too.
  const playerConfig = useMemo(
    () => ({
      youtube: { playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1 } },
      file: { attributes: { playsInline: true } },
    }),
    [],
  );

  // Use our BUNDLED hls.js for live/HLS sources instead of letting
  // react-player fetch it from a CDN at runtime. Setting `window.Hls` makes
  // react-player's SDK loader find it and skip the network load entirely, no
  // CDN dependency, no script-src ambiguity. Loaded lazily (only when a live
  // or .m3u8 source is actually shown) so non-theater users don't pay the
  // ~400KB. Live HLS still needs the CSP connect-src/media-src allowance for
  // the stream's origin AND CORS headers from that origin to actually play.
  // Only the RAW-stream live (`kind: "live"`) or an explicit .m3u8 needs hls.js.
  // A YouTube/Vimeo live (the `live` flag) plays through its own iframe API, so
  // it must NOT be routed to hls.js (doing so is what broke `/theater live
  // <youtube>` before) — hence `kind === "live"`, not the broader `isLive`.
  const needsHls = !isEmbed && (current?.kind === "live" || /\.m3u8(?:[?#]|$)/i.test(current?.url ?? ""));
  useEffect(() => {
    if (!needsHls || typeof window === "undefined") return;
    if ((window as { Hls?: unknown }).Hls) return;
    let cancelled = false;
    void import("hls.js")
      .then((m) => {
        if (cancelled) return;
        const w = window as { Hls?: unknown };
        if (!w.Hls) w.Hls = m.default;
      })
      .catch(() => { /* react-player falls back to its own CDN load */ });
    return () => { cancelled = true; };
  }, [needsHls]);

  // Persist the resize height (cheap; localStorage write per drag tick).
  useEffect(() => {
    try {
      localStorage.setItem(HEIGHT_KEY, String(height));
    } catch {
      /* private mode - height just won't persist */
    }
  }, [height]);

  // New source loading → wait for the fresh onReady before seeking, and reset
  // the "has it played?" flag so a dead new source can be detected.
  useEffect(() => {
    setReady(false);
    setDuration(0);
    setPlayed(0);
    startedRef.current = false;
  }, [current?.url]);

  // Reconcile to the authoritative position whenever a control lands
  // (each control bumps serverTimeMs) or the source just became ready.
  // This fires on a real control (serverTimeMs bumps) or when a fresh
  // source becomes ready, so a deliberate seek/select IS honored in both
  // directions - this is the only place we ever seek backward.
  useEffect(() => {
    if (!ready || isEmbed || isLive || !playerRef.current) return;
    const target = expectedPosition();
    const cur = playerRef.current.getCurrentTime() ?? 0;
    if (Math.abs(cur - target) > DRIFT_TOLERANCE_SEC) {
      seekTo(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync?.serverTimeMs, safeIndex, ready, isEmbed, isLive]);

  // While playing, poll for drift and pull a LAGGING player forward
  // (buffer/stall recovery). Two guards make this safe:
  //   - forward only: we never seek backward here. A player slightly
  //     ahead is harmless; yanking it back to an earlier point is what
  //     produced the repeat-the-first-few-seconds loop. Genuine backward
  //     seeks come from a controller via the reconcile effect above.
  //   - cooldown: skip for a few seconds after any seek so a slow YouTube
  //     seek can land before we re-measure (no thrash). This also lets a
  //     stuck player auto-recover - it gets pulled forward to the right
  //     spot without anyone clicking the playlist.
  useEffect(() => {
    if (!isPlaying || !ready || isEmbed || isLive) return;
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      if (Date.now() - lastSeekAtRef.current < SEEK_COOLDOWN_MS) return;
      // Cap automatic drift-correction short of the very end. Seeking into the
      // final stretch would trip the player's `ended` and skip the video, the
      // "advanced ~10 min early" bug. Genuine advancement comes from natural
      // playback reaching the end (onEnded), never from drift.
      const dur = p.getDuration() ?? duration;
      const cap = dur > 0 ? dur - DRIFT_END_MARGIN_SEC : Infinity;
      const target = Math.min(expectedPosition(), cap);
      const cur = p.getCurrentTime() ?? 0;
      if (cur < target - DRIFT_TOLERANCE_SEC) {
        seekTo(target);
      }
    }, 1500);
    return () => window.clearInterval(id);
  }, [isPlaying, ready, isEmbed, isLive, expectedPosition, seekTo]);

  // Drive the seek bar from a local poll of the player's ACTUAL position
  // instead of relying solely on react-player's onProgress. onProgress can go
  // quiet on some players/states (notably YouTube right after a join-seek, or
  // while buffering) even as playback advances, which leaves the bar frozen
  // ("playing but the timer isn't counting up"). Polling getCurrentTime every
  // 500ms keeps the bar tracking reality. Skipped for live (no shared
  // timeline / seek bar) and embeds (no player handle).
  useEffect(() => {
    if (!isPlaying || !ready || isEmbed || isLive) return;
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      const cur = p.getCurrentTime();
      if (typeof cur === "number" && Number.isFinite(cur) && cur >= 0) {
        setPlayed(cur);
        if (cur > 0.1) startedRef.current = true;
      }
      // Backstop for a missed onDuration so the bar's track + readout aren't
      // stuck at 0:00 if the duration callback never fired.
      const dur = p.getDuration();
      if (typeof dur === "number" && Number.isFinite(dur) && dur > 0) {
        setDuration((d) => (d !== dur ? dur : d));
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [isPlaying, ready, isEmbed, isLive]);

  // Live-edge tracking. A live source has no position anchor; instead we
  // pin the player to the broadcast's live edge. hls.js reports the
  // seekable end as getDuration(), so seeking there drops any buffered
  // delay accumulated from a slow start, a pause/resume, or a stall.
  // Runs on (re)play of a live source and nudges every few seconds.
  useEffect(() => {
    if (!isLive || !ready || !isPlaying) return;
    const snapToLive = () => {
      const p = playerRef.current;
      if (!p) return;
      const end = p.getDuration();
      if (Number.isFinite(end) && end > 0 && end - (p.getCurrentTime() ?? 0) > LIVE_EDGE_TOLERANCE_SEC) {
        seekTo(end);
      }
    };
    snapToLive();
    const id = window.setInterval(snapToLive, 5000);
    return () => window.clearInterval(id);
  }, [isLive, ready, isPlaying, sync?.serverTimeMs, seekTo]);

  const emitControl = useCallback(
    (action: ControlAction, extra?: { positionSec?: number; index?: number }) => {
      socket.emit("theater:control", { roomId, action, ...(extra ?? {}) });
    },
    [socket, roomId],
  );

  // Position heartbeat. The controlling client reports its ACTUAL playback
  // position so the server re-anchors to reality rather than extrapolating
  // from a fixed start-of-video timestamp. Without this, accumulated buffering
  // over a long movie makes the server's position run minutes ahead of the
  // real frame, which mis-draws everyone's seek bar and prematurely "ends"
  // the video. Gated on tab visibility so a backgrounded host (whose player
  // the browser paused) doesn't pin the room to a frozen position; on return
  // its own drift logic catches it up to the live edge before it reports.
  useEffect(() => {
    if (!canControl || !isPlaying || !ready || isEmbed || isLive) return;
    const report = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const p = playerRef.current;
      if (!p) return;
      const cur = p.getCurrentTime();
      if (typeof cur === "number" && Number.isFinite(cur) && cur >= 0) {
        emitControl("progress", { positionSec: cur, index: safeIndex });
      }
    };
    const id = window.setInterval(report, POSITION_HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [canControl, isPlaying, ready, isEmbed, isLive, emitControl, safeIndex]);

  // Recover from joining a source that already ran PAST its end while the room
  // sat empty. The server has no per-video durations, so it keeps a finished
  // source `isPlaying` and extrapolates its position from wall-clock forever;
  // advancement otherwise depends on a client's onEnded, which never re-fires
  // for a player loaded AT the end (a seeked-to-end load isn't a "played
  // through" end). Net effect: come back a day later and the playlist is
  // wedged at the end of one video and never moves on (the reported bug).
  //
  // Once we know the duration, if the shared position is already at/beyond it,
  // nudge the list forward. The server debounces + validates the index, so
  // several joiners advance it only once. A video that finishes while someone
  // is actually watching still advances the normal way (onEnded); this only
  // covers the no-one-was-here case onEnded can't. Loop "off" on the last
  // source stops (isPlaying false), so this won't fire there.
  useEffect(() => {
    if (!ready || isEmbed || isLive || !isPlaying || duration <= 0) return;
    if (expectedPosition() >= duration - END_REACHED_GRACE_SEC) {
      emitControl("ended", { index: safeIndex });
    }
    // Keyed on source readiness/duration, NOT the per-second position, so
    // normal mid-video playback never re-triggers a premature advance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, safeIndex, duration, isPlaying, isEmbed, isLive]);

  const togglePlay = () => {
    const positionSec = playerRef.current?.getCurrentTime() ?? expectedPosition();
    emitControl(isPlaying ? "pause" : "play", { positionSec });
  };

  const react = (emoji: string) => socket.emit("theater:react", { roomId, emoji });

  const copyUrl = async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked - the URL is still shown for manual copy */
    }
  };

  /* ---- resize drag ---- */
  const drag = useRef<{ startY: number; startH: number } | null>(null);
  const onHandleDown = (e: React.PointerEvent) => {
    drag.current = { startY: e.clientY, startH: height };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onHandleMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dy = e.clientY - drag.current.startY;
    const maxH = Math.round(window.innerHeight * 0.8);
    setHeight(Math.max(MIN_HEIGHT, Math.min(maxH, drag.current.startH + dy)));
  };
  const onHandleUp = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  const roomReactions = reactions.filter((r) => r.roomId === roomId);
  const sliderMax = duration > 0 ? duration : 0;
  // Clamp to the track so a transient over-extrapolated `played` can't push
  // the thumb past the end / mislabel the time readout.
  const rawSliderValue = scrub ?? played;
  const sliderValue = duration > 0 ? Math.min(Math.max(0, rawSliderValue), duration) : Math.max(0, rawSliderValue);

  return (
    <div className="flex flex-col border-b border-keep-border/60" style={{ height }}>
      {/* Video stage: dark, fills available space, reactions float over it. */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        {current ? (
          isEmbed ? (
            // Display-only fallback for arbitrary embeds: no shared seek
            // or auto-advance (we can't observe their playback).
            <iframe
              key={current.url}
              src={current.url}
              title={current.title || "Theater video"}
              className="h-full w-full border-0"
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          ) : (
            // The player itself is pointer-inert: all control runs through
            // our bar so a stray click can't desync one viewer. Wrapped in
            // a centering box so letterboxed content sits on the black bg.
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <ReactPlayer
                ref={playerRef}
                url={current.url}
                playing={isPlaying}
                muted={muted}
                controls={false}
                width="100%"
                height="100%"
                onReady={() => setReady(true)}
                onDuration={(d) => setDuration(d)}
                onProgress={(st) => {
                  setPlayed(st.playedSeconds);
                  // Real playback happened → this source isn't dead.
                  if (st.playedSeconds > 0.1) startedRef.current = true;
                }}
                onEnded={() => {
                  // End-of-source is a PASSIVE signal ANY viewer reports, so
                  // the playlist advances even with no mod present. The server
                  // validates against the live index + debounces, so duplicate
                  // reports from many viewers advance only once. Live streams
                  // are exempt: a momentary drop/reconnect shouldn't skip on.
                  if (isLive) return;
                  // Guard against react-player firing `onEnded` spuriously
                  // near the start (buffering / error / post-seek). Acting on
                  // those resets playback every couple seconds, the stuck-at-
                  // the-start loop. Take whichever position estimate is
                  // furthest along: getCurrentTime() can snap to 0 the moment
                  // 'ended' fires on some players, while `played` (last
                  // onProgress) still holds the near-end value; a lagging
                  // `played` is covered by the live getCurrentTime(). Only a
                  // position genuinely near the end advances the playlist.
                  const p = playerRef.current;
                  const dur = p?.getDuration() ?? duration;
                  const pos = Math.max(p?.getCurrentTime() ?? 0, played);
                  if (dur > 0 && pos < dur - END_REACHED_GRACE_SEC) return;
                  emitControl("ended", { index: safeIndex });
                }}
                onError={() => {
                  // A source that FAILS is auto-skipped so the playlist keeps
                  // going with no mod intervention. Restrict the auto-skip to
                  // sources that never actually played (dead / removed /
                  // unembeddable): a mid-playback error after real progress is
                  // likely a transient or viewer-local hiccup and shouldn't
                  // skip the source for everyone. Passive signal, so any
                  // viewer may report it; the server validates the index +
                  // caps consecutive skips so an all-dead list can't hot-loop.
                  if (isLive || startedRef.current) return;
                  emitControl("error", { index: safeIndex });
                }}
                config={playerConfig}
              />
            </div>
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center text-sm text-white/60">
            {canControl ? (
              <>
                <span>
                  No video queued. Add one with <span className="font-mono">/theater add &lt;url&gt;</span>, or stream
                  your own with <span className="font-mono">/theater live &lt;url&gt;</span>.
                </span>
                {onShowStreamGuide && canSeeStreamGuide ? (
                  <button
                    type="button"
                    onClick={onShowStreamGuide}
                    className="text-keep-action underline-offset-2 hover:underline"
                  >
                    How to stream your desktop →
                  </button>
                ) : null}
              </>
            ) : (
              "The host hasn't queued a video yet."
            )}
          </div>
        )}

        {/* Floating reactions drift up both edges, scattered on X so a
            burst spreads out instead of stacking in one column. */}
        {roomReactions.map((r) => {
          const left = r.side === "left";
          const offset = 14 + hashUnit(r.id) * 110; // 14..124px in from the edge
          const wobble = (hashUnit(r.id * 7 + 1) - 0.5) * 44; // +/-22px mid-flight drift
          const dur = 2.6 + hashUnit(r.id * 13 + 5) * 1.6; // 2.6..4.2s
          const style = {
            left: left ? `${offset}px` : "auto",
            right: left ? "auto" : `${offset}px`,
            "--theater-wobble": `${wobble}px`,
            "--theater-dur": `${dur}s`,
          } as React.CSSProperties;
          return (
            <span
              key={r.id}
              className="theater-float"
              style={style}
              title={r.displayName}
              onAnimationEnd={() => dropTheaterReaction(r.id)}
            >
              {r.emoji}
            </span>
          );
        })}

        {/* One-tap unmute overlay (audio starts muted for autoplay). */}
        {current && !isEmbed && muted ? (
          <button
            type="button"
            onClick={() => {
              setMuted(false);
              // iOS Safari gates programmatic seeks behind a user gesture, so
              // a muted-autoplay iPad can be stuck on its own timeline. This
              // tap IS a gesture, use it to snap to the shared position (live
              // edge for streams) so the viewer joins in sync. Harmless on
              // other platforms (it just re-aligns to where it already is).
              if (isLive) {
                const p = playerRef.current;
                const end = p?.getDuration() ?? 0;
                if (Number.isFinite(end) && end > 0) seekTo(end);
              } else {
                seekTo(expectedPosition());
              }
            }}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-4 py-1.5 text-sm font-medium text-white shadow-lg ring-1 ring-white/20 hover:bg-black/85"
          >
            🔇 Tap to unmute
          </button>
        ) : null}
      </div>

      {/* Media-address bar + reaction buttons (visible to everyone). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-keep-panel/70 px-3 py-1.5 text-xs text-keep-text">
        {playlist.length > 0 ? (
          <span className="shrink-0 font-mono text-keep-muted">
            {safeIndex + 1} / {playlist.length}
          </span>
        ) : null}
        {isLive ? (
          <span className="shrink-0 rounded bg-red-600/90 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            ● Live
          </span>
        ) : null}
        {current ? (
          <>
            <span className="min-w-0 flex-1 truncate" title={current.url}>
              {current.title ? <span className="font-medium">{current.title} · </span> : null}
              <span className="text-keep-muted">{current.url}</span>
            </span>
            <button
              type="button"
              onClick={copyUrl}
              className="shrink-0 rounded border border-keep-border/60 px-2 py-0.5 text-keep-action hover:bg-keep-action/10"
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </>
        ) : (
          <span className="flex-1 text-keep-muted">No source set.</span>
        )}
        {!muted && current && !isEmbed ? (
          <button
            type="button"
            onClick={() => setMuted(true)}
            className="shrink-0 rounded border border-keep-border/60 px-2 py-0.5 text-keep-muted hover:bg-keep-action/10"
            title="Mute audio (local only)"
          >
            🔊
          </button>
        ) : null}
        {canControl && canSeeStreamGuide && onShowStreamGuide ? (
          <button
            type="button"
            onClick={onShowStreamGuide}
            className="shrink-0 rounded border border-keep-border/60 px-2 py-0.5 text-keep-muted hover:bg-keep-action/10"
            title="How to stream your own video (VLC / OBS + a tunnel)"
          >
            Stream help
          </button>
        ) : null}

        {/* Reaction palette - anyone can cheer. */}
        <span className="flex shrink-0 items-center gap-1">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => react(emoji)}
              className="rounded px-1 text-base leading-none hover:scale-125 hover:bg-keep-action/10 transition-transform"
              aria-label={`React ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </span>
      </div>

      {/* Control bar - owners/mods only. Everyone else just watches. */}
      {canControl && current ? (
        <div className="flex items-center gap-2 bg-keep-panel/40 px-3 py-1.5 text-keep-text">
          <button
            type="button"
            onClick={() => emitControl("prev")}
            disabled={playlist.length < 2}
            className="rounded px-1.5 py-0.5 text-sm hover:bg-keep-action/10 disabled:opacity-40"
            title="Previous"
          >
            ⏮
          </button>
          <button
            type="button"
            onClick={togglePlay}
            disabled={isEmbed}
            className="rounded px-2 py-0.5 text-sm hover:bg-keep-action/10 disabled:opacity-40"
            title={isPlaying ? "Pause for everyone" : "Play for everyone"}
          >
            {isPlaying ? "⏸ Pause" : "▶ Play"}
          </button>
          <button
            type="button"
            onClick={() => emitControl("next")}
            disabled={playlist.length < 2}
            className="rounded px-1.5 py-0.5 text-sm hover:bg-keep-action/10 disabled:opacity-40"
            title="Next"
          >
            ⏭
          </button>
          {isLive ? (
            // Live has no timeline: no seek bar, just a live-edge indicator.
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-red-400">
              <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
              Live - everyone watching the live edge
            </span>
          ) : (
            <>
              <span className="shrink-0 font-mono text-[11px] text-keep-muted">
                {fmtTime(sliderValue)} / {fmtTime(duration)}
              </span>
              <input
                type="range"
                min={0}
                max={sliderMax}
                step="any"
                value={sliderValue}
                disabled={isEmbed || sliderMax === 0}
                onChange={(e) => setScrub(Number(e.target.value))}
                onPointerUp={() => {
                  if (scrub != null) {
                    emitControl("seek", { positionSec: scrub });
                    setScrub(null);
                  }
                }}
                onMouseUp={() => {
                  if (scrub != null) {
                    emitControl("seek", { positionSec: scrub });
                    setScrub(null);
                  }
                }}
                className="min-w-0 flex-1 accent-keep-action disabled:opacity-40"
                aria-label="Seek"
              />
            </>
          )}
          <span className="shrink-0 text-[11px] uppercase tracking-wide text-keep-muted" title="Loop mode (set with /theater loop)">
            loop: {room.theaterLoop}
          </span>
        </div>
      ) : null}

      {/* Playlist selector - owners/mods, only when there's more than one. */}
      {canControl && playlist.length > 1 ? (
        <div className="flex items-center gap-1 overflow-x-auto bg-keep-panel/20 px-3 py-1 text-[11px]">
          {playlist.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => emitControl("select", { index: i })}
              className={`shrink-0 rounded px-1.5 py-0.5 ${
                i === safeIndex ? "bg-keep-action/25 text-keep-action" : "text-keep-muted hover:bg-keep-action/10"
              }`}
              title={s.url}
            >
              {i + 1}. {s.title || s.url}
            </button>
          ))}
        </div>
      ) : null}

      {/* Resize handle along the bottom edge. */}
      <div
        className="theater-resize-handle flex h-2 w-full shrink-0 items-center justify-center bg-keep-panel/40"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize video panel"
      >
        <div className="theater-resize-grip h-0.5 w-10 rounded-full bg-keep-border/70" />
      </div>
    </div>
  );
}
