import { and, eq, isNull, sql, type SQL, type AnyColumn } from "drizzle-orm";

/**
 * Identity = (userId, characterId|null). NULL characterId means the
 * master OOC handle. Friend rows and DM conversations are keyed on
 * identity pairs, so two characters of the same player keep separate
 * friends lists and inboxes.
 */
export interface Identity {
  userId: string;
  characterId: string | null;
}

/**
 * Build a drizzle WHERE condition that matches a (userIdCol,
 * characterIdCol) pair against a given identity. We have to special-
 * case NULL characterId because SQL `col = NULL` is always false,
 * drizzle's `eq()` doesn't fold to `IS NULL` automatically, so the
 * master-side comparison needs `isNull(col)` instead.
 */
export function eqIdentity(
  userIdCol: AnyColumn,
  charIdCol: AnyColumn,
  id: Identity,
): SQL {
  const userMatch = eq(userIdCol, id.userId);
  const charMatch = id.characterId === null
    ? isNull(charIdCol)
    : eq(charIdCol, id.characterId);
  return and(userMatch, charMatch)!;
}

/**
 * Read `?characterId=<id>` off an HTTP request and normalize. Empty
 * string and missing both resolve to null (master OOC identity).
 * Caller is responsible for validating the character belongs to the
 * authenticated user, typically by also checking that `me.id` owns
 * the character row, since otherwise a user could spoof another
 * player's character id and read their inbox.
 */
export function characterIdFromQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Verify the caller actually owns the character they claim to be acting
 * as. Returns true when ok, false when the character doesn't exist /
 * is soft-deleted / belongs to a different user. Callers should treat
 * a false here as a 403 (don't 401, the user IS authenticated; they
 * just can't act as someone else's character).
 */
export async function ownsCharacter(
  db: import("../db/index.js").Db,
  userId: string,
  characterId: string,
): Promise<boolean> {
  const { characters } = await import("../db/schema.js");
  const c = (await db
    .select({ userId: characters.userId, deletedAt: characters.deletedAt })
    .from(characters)
    .where(sql`${characters.id} = ${characterId}`)
    .limit(1))[0];
  return !!c && c.userId === userId && c.deletedAt === null;
}
