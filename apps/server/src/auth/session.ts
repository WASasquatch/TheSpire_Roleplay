import { eq } from "drizzle-orm";
import { characters, sessions, users } from "../db/schema.js";
import type { Db } from "../db/index.js";
import type { SessionUser } from "../commands/types.js";
import { getSettings } from "../settings.js";

/** Resolve the current display name for a user (active char name or master username). */
export async function resolveDisplayName(db: Db, userId: string): Promise<string> {
  const u = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!u) throw new Error(`user not found: ${userId}`);
  if (!u.activeCharacterId) return u.username;
  const c = (await db
    .select()
    .from(characters)
    .where(eq(characters.id, u.activeCharacterId))
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
  };
}
