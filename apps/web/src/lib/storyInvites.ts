import { useEffect, useState } from "react";
import { getSocket } from "./socket.js";

/**
 * Tracks the caller's pending Scriptorium invite count. Fetches once
 * on mount, then listens to the `story:invite` socket event to
 * increment in real time. Used to drive the small "you have invites"
 * dot on the Banner's Scriptorium link + the Tools menu's My Stories
 * entry.
 *
 * Self-decrementing isn't socket-driven (the recipient acts on the
 * invite via REST and the local component already clears its card);
 * callers can pass a `refreshKey` to force a refetch after they
 * accept / decline so the count stays accurate.
 */
export function useStoryInviteCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetch("/me/story-invites", { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<{ invites: unknown[] }>) : null))
      .then((j) => { if (!cancelled && j) setCount(j.invites.length); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const socket = getSocket();
    function onInvite() { setCount((c) => c + 1); }
    socket.on("story:invite", onInvite);
    return () => { socket.off("story:invite", onInvite); };
  }, []);

  return count;
}
