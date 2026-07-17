/**
 * App-wide display-timezone preference (migration 0365) — the timezone sibling
 * of lib/i18n.ts's locale switch. A user's choice is mirrored into three
 * places: the intlFormat formatter (so every date/time across the app renders
 * in the chosen zone), this device's localStorage (so the choice survives a
 * reload before /me/profile returns), and the chat store (so the Settings
 * picker reflects it). When signed in it also PUTs to /me/profile so the
 * choice follows the account across devices. Null = "System default": the
 * browser's own timezone, i.e. the prior behavior.
 */
import { useChat } from "../state/store.js";
import { i18n } from "./i18n.js";
import { activeTimeZone, setDisplayTimeZone } from "./intlFormat.js";

const TZ_STORAGE_KEY = "tk:timezone";

/** This device's remembered choice, read at boot before /me/profile lands. */
export function readStoredTimeZone(): string | null {
  try {
    return localStorage.getItem(TZ_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredTimeZone(tz: string | null): void {
  try {
    if (tz) localStorage.setItem(TZ_STORAGE_KEY, tz);
    else localStorage.removeItem(TZ_STORAGE_KEY);
  } catch {
    /* private mode / disabled storage — the in-memory value still applies */
  }
}

let explicitChangesInFlight = 0;

/** Apply a timezone to THIS device (formatter + localStorage + store) without
 *  touching the account. Used to seed from localStorage at boot. When the zone
 *  actually changes, repaint every already-mounted time display: the plain
 *  `formatDate/Time` helpers aren't reactive, but every user-facing surface
 *  uses `useTranslation`, so firing i18next's `languageChanged` (the same bus
 *  a language switch rides — there are no other listeners) forces them all to
 *  re-render live, no reload. No-op at boot before anything has mounted. */
export function applyTimeZoneLocally(tz: string | null): void {
  const next = tz || null;
  const changed = (next ?? undefined) !== activeTimeZone();
  setDisplayTimeZone(next);
  writeStoredTimeZone(next);
  useChat.getState().setTimeZonePref(next);
  if (changed) {
    (i18n as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit("languageChanged", i18n.language);
  }
}

/** Seed from the /me/profile payload (users.timezone). The account value is
 *  authoritative for a signed-in user; an explicit null clears any residue a
 *  previous account left on this device. `undefined` means the field was
 *  ABSENT (an older/rolling server build) — leave the local choice untouched
 *  rather than wiping it. Defers to an in-flight explicit change so a
 *  concurrent refetch can't revert a just-made pick. */
export function applyServerTimeZone(saved: string | null | undefined): void {
  if (explicitChangesInFlight > 0) return;
  if (saved === undefined) return;
  applyTimeZoneLocally(saved);
}

/** Explicit change from the UI (profile editor): apply locally, then persist
 *  to the account when signed in. Null = "System default". */
export async function changeTimeZone(tz: string | null): Promise<void> {
  explicitChangesInFlight += 1;
  try {
    applyTimeZoneLocally(tz);
    if (useChat.getState().me) {
      try {
        await fetch("/me/profile", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ timezone: tz }),
        });
      } catch {
        /* offline / expired session — the local change already applied */
      }
    }
  } finally {
    explicitChangesInFlight -= 1;
  }
}
