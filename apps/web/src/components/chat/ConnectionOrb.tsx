import { useEffect, useRef, useState } from "react";
import { getSocket } from "../../lib/socket.js";

/**
 * Visible heartbeat / connection indicator.
 *
 *   - GREEN, pulses once each heartbeat (every ~30s, see the presence
 *     heartbeat in App.tsx which dispatches `tk:heartbeat`): live + healthy.
 *   - RED, pulsing: the socket dropped and we're trying to reconnect.
 *   - GREY, steady: no connection for a while / browser offline (timed out).
 *
 * Clicking it forces a resync: reconnect the socket (which re-authenticates
 * from the stored session token, so it restores the live connection WITHOUT
 * logging the user out) and ping presence so the session + userlist refresh.
 */

type Status = "online" | "reconnecting" | "offline";

// How long a disconnect persists before we downgrade red → grey ("timed out").
const OFFLINE_AFTER_MS = 15_000;

export function ConnectionOrb() {
  const socket = getSocket();
  const [status, setStatus] = useState<Status>(socket.connected ? "online" : "reconnecting");
  // Bumped on each heartbeat to retrigger the one-shot green pulse animation.
  const [beat, setBeat] = useState(0);
  const offlineTimer = useRef<number | null>(null);

  useEffect(() => {
    const clearOfflineTimer = () => {
      if (offlineTimer.current != null) {
        window.clearTimeout(offlineTimer.current);
        offlineTimer.current = null;
      }
    };
    const armOfflineTimer = () => {
      clearOfflineTimer();
      offlineTimer.current = window.setTimeout(() => setStatus("offline"), OFFLINE_AFTER_MS);
    };

    const onConnect = () => { clearOfflineTimer(); setStatus("online"); };
    const onDisconnect = () => { setStatus("reconnecting"); armOfflineTimer(); };
    const onBeat = () => setBeat((n) => n + 1);
    const onWindowOffline = () => { clearOfflineTimer(); setStatus("offline"); };
    const onWindowOnline = () => { if (!socket.connected) { setStatus("reconnecting"); socket.connect(); armOfflineTimer(); } };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    window.addEventListener("tk:heartbeat", onBeat);
    window.addEventListener("offline", onWindowOffline);
    window.addEventListener("online", onWindowOnline);
    if (!socket.connected) armOfflineTimer();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      window.removeEventListener("tk:heartbeat", onBeat);
      window.removeEventListener("offline", onWindowOffline);
      window.removeEventListener("online", onWindowOnline);
      clearOfflineTimer();
    };
  }, [socket]);

  function resync() {
    // Re-establish the live connection without touching the session token,
    // so a transient drop recovers in place instead of bouncing to login.
    if (!socket.connected) {
      setStatus("reconnecting");
      socket.connect();
    }
    socket.emit("presence:active");
    // Let the app re-pull room state / userlist on demand.
    window.dispatchEvent(new Event("tk:resync"));
    setBeat((n) => n + 1);
  }

  const label =
    status === "online" ? "Connected, click to resync"
    : status === "reconnecting" ? "Reconnecting… click to retry now"
    : "Offline, click to reconnect";

  return (
    <button
      type="button"
      onClick={resync}
      title={label}
      aria-label={label}
      className="flex h-5 w-5 items-center justify-center rounded hover:bg-keep-panel/60"
    >
      {/* key={beat} remounts the dot each heartbeat so the green one-shot
          pulse keyframe replays; red/grey states are driven by the class. */}
      <span key={beat} className={`conn-orb conn-orb--${status}`} aria-hidden />
    </button>
  );
}
