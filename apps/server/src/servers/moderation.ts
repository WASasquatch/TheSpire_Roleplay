/**
 * Global-admin server moderation — the shared, side-effect-free predicates for
 * the suspend/ban feature (migration 0306). Every place that reads a server's
 * moderation state (serverAuthority.canParticipate, the /servers catalog +
 * discovery filters, the /visit gate, the admin console) routes through here so
 * "is this server currently moderated?" and "what do we tell a blocked user?"
 * are answered in exactly one place.
 *
 * LAZY EXPIRY: a 'banned' server whose moderation_until has passed behaves
 * EXACTLY like 'none' everywhere — enterable, discoverable, no notice. We never
 * cron-clean the row (the console keeps the history until a manual lift),
 * mirroring the serverBans / bannedIps expiry pattern (`!until || +until > now`).
 * 'suspended' never expires on its own — it is lifted manually.
 *
 * These helpers are intentionally pure (a plain DbServer row in, a boolean /
 * notice out) so they can be called both server-side and against any already
 * loaded row without another DB hit.
 */
import type { DbServer } from "../db/schema.js";

/**
 * The two active moderation kinds surfaced to a blocked user. `none` is never a
 * notice — it is the absence of moderation.
 */
export type ServerModerationCode = "suspended" | "banned";

/** The blocked-user notice shape returned by {@link serverModerationNotice}. */
export interface ServerModerationNotice {
  code: ServerModerationCode;
  message: string;
}

/**
 * Whether `server`'s moderation is CURRENTLY active.
 *
 * - 'suspended' → always active (no expiry; lifted only by a manual admin lift).
 * - 'banned'    → active while indefinite (moderation_until NULL) or not yet
 *                 expired (moderation_until > now). A ban past its until is
 *                 treated as inactive (lazy expiry — the row is never deleted).
 * - 'none'      → never active.
 *
 * Mirrors the existing serverBans expiry check (`!until || +until > Date.now()`),
 * where the unary `+` normalizes the timestamp_ms `Date`/number to a number.
 */
export function isServerModerationActive(server: DbServer): boolean {
  if (server.moderationState === "suspended") return true;
  if (server.moderationState === "banned") {
    // Indefinite (no until) or not yet expired ⇒ still active. Once the until
    // has passed the ban behaves exactly like 'none' (lazy expiry).
    return !server.moderationUntil || +server.moderationUntil > Date.now();
  }
  return false;
}

/**
 * The user-facing notice for a moderated server, or `null` when the server is
 * not currently moderated (state 'none', or a 'banned' state whose until has
 * passed). The optional {@link DbServer.moderationNote} is appended after the
 * base line so the copy stays the confirmed wording:
 *   "This server is temporarily suspended"  (+ ": <note>")
 *   "This server has been banned"           (+ ": <note>")
 */
export function serverModerationNotice(server: DbServer): ServerModerationNotice | null {
  if (!isServerModerationActive(server)) return null;

  const note = server.moderationNote?.trim();

  if (server.moderationState === "suspended") {
    return {
      code: "suspended",
      message: note
        ? `This server is temporarily suspended: ${note}`
        : "This server is temporarily suspended",
    };
  }

  // Only 'banned' can still be active here (isServerModerationActive guarded).
  return {
    code: "banned",
    message: note ? `This server has been banned: ${note}` : "This server has been banned",
  };
}
