/**
 * In-app sound effects.
 *
 * Four discrete sound files, each bound to a class of event:
 *   - ping    → inbound DM (any conversation). Cross-room 1:1.
 *   - whisper → inbound whisper directed at the viewer in a room.
 *     Distinct from DM so the two feel different even when both
 *     are 1:1 attention requests — DM is "someone is reaching out
 *     from outside this room", whisper is "someone in this room is
 *     speaking just to you."
 *   - tap     → inbound chat / action in a room (excluding whispers)
 *   - alert   → admin announcement / system event
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

type SoundEvent = "ping" | "whisper" | "tap" | "alert";

const SOUND_FILES: Record<SoundEvent, string> = {
  ping: "/audio/ping.mp3",
  whisper: "/audio/whisper.mp3",
  tap: "/audio/tap.mp3",
  alert: "/audio/alert.mp3",
};

const VOLUMES: Record<SoundEvent, number> = {
  ping: 0.5,
  whisper: 0.5,
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

/**
 * True when the current user has marked themselves /away in any room
 * they're currently parked in. We read the occupant rows for the
 * current room rather than tracking a separate "am I away" flag in
 * the store — there's no UI to toggle it outside of /away, and the
 * occupant row already carries the canonical `away` boolean (set by
 * `broadcastPresence` after the slash command writes to `users
 * .awayMessage`). When the user moves rooms the new room's
 * broadcastPresence emits an occupant list that still carries their
 * away flag, so this stays correct.
 */
function isUserAway(): boolean {
  const s = useChat.getState();
  const myId = s.me?.id;
  if (!myId) return false;
  const roomId = s.currentRoomId;
  if (!roomId) return false;
  const occ = s.occupants[roomId];
  if (!occ) return false;
  // Multiple occupant rows may share a userId now (one per identity —
  // see broadcast.ts currentOccupants). Any row matching = the user
  // is /away on at least one identity, which is all we need.
  return occ.some((o) => o.userId === myId && o.away);
}

function isEnabled(event: SoundEvent): boolean {
  // Hard mute when the user has set themselves /away. The whole
  // point of /away is "don't disturb me right now", and a pinged
  // sound effect undermines that promise even when the per-event
  // preference is on. /back (or `/away` to toggle off) re-enables
  // the sounds via this same gate.
  if (isUserAway()) return false;
  const prefs = useChat.getState().soundPrefs;
  if (event === "ping") return prefs.dm;
  if (event === "whisper") return prefs.whisper;
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
export function playWhisper(): void { play("whisper"); }
export function playTap(): void { play("tap"); }
export function playAlert(): void { play("alert"); }
