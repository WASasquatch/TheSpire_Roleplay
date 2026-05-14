/**
 * In-app sound effects.
 *
 * Three discrete events, each bound to its own bundled mp3 in
 * /public/audio/:
 *   - ping  → inbound DM (any conversation)
 *   - tap   → inbound chat message / action in a room
 *   - alert → admin announcement / system event
 *
 * Per-user prefs live in the Zustand store (`soundPrefs`) and are
 * persisted server-side via /me/profile. A disabled event short-
 * circuits play() without even instantiating the Audio element, so
 * preferences are honored immediately on toggle.
 *
 * Browser autoplay policies require a prior user gesture before any
 * `Audio.play()` resolves. We don't try to satisfy that ourselves —
 * by the time a sound fires, the user has signed in, picked a room,
 * and (almost certainly) clicked something. The play() promise's
 * AbortError / NotAllowedError rejection is swallowed silently; we'd
 * rather drop a sound than spam the console.
 *
 * Volume is set per-event: ping/tap are subtle (0.5), alert is louder
 * (0.7) since it's user-summoning. These match the medium-density,
 * "ambient chat" feel — the app isn't a slot machine.
 */
import { useChat } from "../state/store.js";

type SoundEvent = "ping" | "tap" | "alert";

const SOUND_FILES: Record<SoundEvent, string> = {
  ping: "/audio/ping.mp3",
  tap: "/audio/tap.mp3",
  alert: "/audio/alert.mp3",
};

const VOLUMES: Record<SoundEvent, number> = {
  ping: 0.5,
  tap: 0.5,
  alert: 0.7,
};

/**
 * Cached <audio> elements, one per event. Lazily created on first
 * play. Reusing the element across plays is cheaper than `new Audio`
 * each time, but we reset `currentTime` so back-to-back triggers don't
 * silently drop (HTMLAudioElement won't restart a still-playing clip
 * on its own).
 */
const audioCache: Partial<Record<SoundEvent, HTMLAudioElement>> = {};

function getAudio(event: SoundEvent): HTMLAudioElement {
  let el = audioCache[event];
  if (!el) {
    el = new Audio(SOUND_FILES[event]);
    el.volume = VOLUMES[event];
    el.preload = "auto";
    audioCache[event] = el;
  }
  return el;
}

function isEnabled(event: SoundEvent): boolean {
  const prefs = useChat.getState().soundPrefs;
  if (event === "ping") return prefs.dm;
  if (event === "tap") return prefs.chat;
  return prefs.alert;
}

function play(event: SoundEvent): void {
  if (!isEnabled(event)) return;
  // SSR guard — module is imported by code that runs during the Vite
  // dev pre-bundle in some setups; bail before touching the Audio API.
  if (typeof window === "undefined") return;
  try {
    const el = getAudio(event);
    // Restart from the top if a previous play is still running.
    // Otherwise the browser ignores the second trigger entirely.
    el.currentTime = 0;
    // play() returns a Promise; rejected when the user-gesture rule
    // hasn't been met yet, or when the audio file failed to load.
    // Either way there's nothing useful to do, so swallow.
    void el.play().catch(() => { /* autoplay blocked / decode error */ });
  } catch {
    /* element construction or volume set failed — non-fatal */
  }
}

export function playPing(): void { play("ping"); }
export function playTap(): void { play("tap"); }
export function playAlert(): void { play("alert"); }
