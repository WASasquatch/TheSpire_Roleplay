import { useCallback, useEffect, useRef, useState } from "react";
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

type ControlAction = "play" | "pause" | "seek" | "next" | "prev" | "select" | "ended";

interface Props {
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  roomId: string;
  room: RoomSummary;
  /** True for room owner/mods (and the site-wide grant): drives playback. */
  canControl: boolean;
}

const HEIGHT_KEY = "tk:theaterHeight:v1";
const MIN_HEIGHT = 160;
const DEFAULT_HEIGHT = 340;
// Re-seek only when the local player drifts past this from the expected
// position. Small enough to feel synced, loose enough to ignore the
// sub-second jitter of normal playback + network latency.
const DRIFT_TOLERANCE_SEC = 1.5;
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

export function TheaterPanel({ socket, roomId, room, canControl }: Props) {
  const playlist = room.theaterPlaylist;
  const sync = useChat((s) => s.theaterSyncByRoom[roomId]);
  const reactions = useChat((s) => s.theaterReactions);
  const dropTheaterReaction = useChat((s) => s.dropTheaterReaction);

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

  // Expected playback position right now: the anchored position plus the
  // elapsed wall-clock since the server captured it (while playing).
  const expectedPosition = useCallback((): number => {
    if (!sync) return 0;
    if (!sync.isPlaying) return sync.positionSec;
    return sync.positionSec + (Date.now() - sync.serverTimeMs) / 1000;
  }, [sync]);

  // Persist the resize height (cheap; localStorage write per drag tick).
  useEffect(() => {
    try {
      localStorage.setItem(HEIGHT_KEY, String(height));
    } catch {
      /* private mode - height just won't persist */
    }
  }, [height]);

  // New source loading → wait for the fresh onReady before seeking.
  useEffect(() => {
    setReady(false);
    setDuration(0);
    setPlayed(0);
  }, [current?.url]);

  // Reconcile to the authoritative position whenever a control lands
  // (each control bumps serverTimeMs) or the source just became ready.
  useEffect(() => {
    if (!ready || isEmbed || !playerRef.current) return;
    const target = expectedPosition();
    const cur = playerRef.current.getCurrentTime() ?? 0;
    if (Math.abs(cur - target) > DRIFT_TOLERANCE_SEC) {
      playerRef.current.seekTo(target, "seconds");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync?.serverTimeMs, safeIndex, ready, isEmbed]);

  // While playing, poll for drift and snap back if we slip. Covers the
  // slow accumulation a single seek can't (a viewer whose tab throttled
  // in the background, a slow decoder).
  useEffect(() => {
    if (!isPlaying || !ready || isEmbed) return;
    const id = window.setInterval(() => {
      if (!playerRef.current) return;
      const target = expectedPosition();
      const cur = playerRef.current.getCurrentTime() ?? 0;
      if (Math.abs(cur - target) > DRIFT_TOLERANCE_SEC) {
        playerRef.current.seekTo(target, "seconds");
      }
    }, 1500);
    return () => window.clearInterval(id);
  }, [isPlaying, ready, isEmbed, expectedPosition]);

  const emitControl = useCallback(
    (action: ControlAction, extra?: { positionSec?: number; index?: number }) => {
      socket.emit("theater:control", { roomId, action, ...(extra ?? {}) });
    },
    [socket, roomId],
  );

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
  const sliderValue = scrub ?? played;

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
                onProgress={(st) => setPlayed(st.playedSeconds)}
                onEnded={() => {
                  // Only controllers report end-of-source; the server
                  // debounces duplicate reports and owns the advance.
                  if (canControl) emitControl("ended");
                }}
                config={{
                  youtube: { playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0 } },
                }}
              />
            </div>
          )
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-white/60">
            {canControl
              ? "No video queued. Add one with /theater add <url>."
              : "The host hasn't queued a video yet."}
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
            onClick={() => setMuted(false)}
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
