import { eq } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { characters, sessions, users } from "../db/schema.js";
import type { Db } from "../db/index.js";
import type { SessionUser } from "../commands/types.js";
import { getSettings } from "../settings.js";

/**
 * Force a user out of the site, authoritatively:
 *
 *   1. DELETE every session row they hold — the keystone. Without this,
 *      the client's socket auto-reconnects with its still-valid token and
 *      lands straight back in chat (the original "disabled users aren't
 *      logged out" bug).
 *   2. Emit `session:kicked` with the human-readable reason (shown on the
 *      login splash) plus the legacy `auth:expired` for older clients.
 *   3. Disconnect each socket AFTER a short flush delay — a synchronous
 *      `disconnect(true)` right after `emit` races the transport and the
 *      reason packet can be dropped before it's sent.
 *
 * Used by account disable and by the admin-tier /kick (site kick).
 */
export async function forceLogoutUser(
  io: IoServer<ClientToServerEvents, ServerToClientEvents>,
  db: Db,
  userId: string,
  message: string,
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
  const socks = await io.fetchSockets();
  for (const s of socks) {
    if ((s.data as { userId?: string }).userId !== userId) continue;
    s.emit("session:kicked", { message });
    s.emit("auth:expired");
    setTimeout(() => { try { s.disconnect(true); } catch { /* already gone */ } }, 250);
  }
}

/**
 * Resolve the current display name for a user. By default reads
 * `users.activeCharacterId` from the DB; pass `overrideCharId` to resolve
 * against a different character (or null for master/OOC) without touching
 * the DB row. Used by per-tab character routing so each socket can have
 * its own active identity independent of the user-level default.
 */
export async function resolveDisplayName(
  db: Db,
  userId: string,
  overrideCharId?: string | null,
): Promise<string> {
  const u = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!u) throw new Error(`user not found: ${userId}`);
  // `undefined` means "no override, use DB". An explicit `null` means
  // "master, even if DB has an active char".
  const charId = overrideCharId === undefined ? u.activeCharacterId : overrideCharId;
  if (!charId) return u.username;
  const c = (await db
    .select()
    .from(characters)
    .where(eq(characters.id, charId))
    .limit(1))[0];
  return c && !c.deletedAt ? c.name : u.username;
}

/**
 * Sliding-expiration: push the session's `expiresAt` forward by the configured
 * idle window. Called on every user-initiated interaction (socket events,
 * non-poll HTTP routes) so an active user never gets kicked. A no-op if the
 * session row no longer exists (already swept).
 *
 * Deliberately NOT called from /auth/me or other background polls - those
 * are silent reachability checks and shouldn't keep an idle tab logged in.
 */
export async function extendSession(db: Db, sid: string): Promise<void> {
  const { sessionTtlMs } = await getSettings(db);
  const newExpiry = new Date(Date.now() + sessionTtlMs);
  await db.update(sessions).set({ expiresAt: newExpiry }).where(eq(sessions.id, sid));
}

export async function loadSessionUser(db: Db, userId: string): Promise<SessionUser | null> {
  const u = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!u || u.disabledAt) return null;
  const displayName = await resolveDisplayName(db, u.id);
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    activeCharacterId: u.activeCharacterId,
    displayName,
    chatColor: u.chatColor,
    awayMessage: u.awayMessage,
    currentMood: u.currentMood,
    incognitoMode: u.incognitoMode,
    incognitoAlias: u.incognitoAlias,
    incognitoExitMessage: u.incognitoExitMessage,
    incognitoReturnMessage: u.incognitoReturnMessage,
  };
}
