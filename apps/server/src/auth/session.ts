import { eq } from "drizzle-orm";
import { characters, users } from "../db/schema.js";
import type { Db } from "../db/index.js";
import type { SessionUser } from "../commands/types.js";

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
  };
}
