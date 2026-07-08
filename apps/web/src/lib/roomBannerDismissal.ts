import { useCallback, useEffect, useState } from "react";

/**
 * Per-room banner-dismissal memory. Keyed on (roomId, kind) in
 * localStorage; the stored value is the exact world id or topic text
 * the user dismissed, so the banner reappears automatically when the
 * admin edits either one (a fresh value won't match the stored
 * dismissal). When the user leaves the room and comes back the
 * decision persists, sessionStorage would lose it on refresh, which
 * we explicitly don't want for chrome the user has actively hidden.
 *
 * Returns `[dismissed, dismiss]`, `dismissed` is true only when
 * `currentValue` is present AND matches the cached value, so a null
 * `currentValue` (no world linked, no topic set) never reads as
 * dismissed and rendering the banner conditionally on
 * `value && !dismissed` is correct.
 */
export function useRoomBannerDismissal(
  roomId: string | null,
  kind: "world" | "topic",
  currentValue: string | null,
): readonly [boolean, () => void] {
  const storageKey = roomId ? `tk:dismissed:room-${kind}:${roomId}` : null;
  const [stored, setStored] = useState<string | null>(() => {
    if (!storageKey) return null;
    try {
      if (typeof localStorage === "undefined") return null;
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  // Re-read on roomId change so navigating between rooms picks up
  // each room's own dismissal independently.
  useEffect(() => {
    if (!storageKey) {
      setStored(null);
      return;
    }
    try {
      setStored(typeof localStorage !== "undefined" ? localStorage.getItem(storageKey) : null);
    } catch {
      setStored(null);
    }
  }, [storageKey]);
  const dismissed = !!currentValue && stored === currentValue;
  const dismiss = useCallback(() => {
    if (!storageKey || !currentValue) return;
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(storageKey, currentValue);
    } catch {
      // Quota or private-mode, best effort; the dismissal still
      // sticks for the current session via the React state below.
    }
    setStored(currentValue);
  }, [storageKey, currentValue]);
  return [dismissed, dismiss] as const;
}
