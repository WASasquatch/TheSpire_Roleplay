/**
 * Room slug derivation + backfill (migration 0260).
 *
 * A room's `slug` is a short, URL-safe handle used to deep-link the room
 * from chat / announcements (`{room:<slug>}` UI-route chip) and as a
 * stable id-independent reference. Mirrors world slugs: derived from the
 * name with the SHARED `deriveSlug`, then disambiguated with a numeric
 * suffix so the global (case-insensitive) unique index never trips.
 *
 * Two entry points:
 *   - deriveUniqueRoomSlug: called at every room-create site so a new
 *     room gets a handle immediately.
 *   - backfillRoomSlugs: one-shot boot sweep that fills any room left
 *     with a NULL slug (existing rooms at migration time, plus a safety
 *     net for any create path that forgot to set one).
 */

import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { deriveSlug } from "@thekeep/shared";
import { rooms } from "../db/schema.js";
import type { Db } from "../db/index.js";

/**
 * Produce a globally-unique room slug from `name`. Starts from
 * `deriveSlug(name)` (falling back to "room" when the name slugifies to
 * empty, e.g. an all-symbol name) and appends `-2`, `-3`, … until no
 * existing row (other than `exceptId`) holds it. The 60-char cap matches
 * `deriveSlug`; the suffix is re-trimmed to stay within it.
 */
export async function deriveUniqueRoomSlug(
  db: Db,
  name: string,
  exceptId?: string,
): Promise<string> {
  const base = deriveSlug(name) || "room";
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base.slice(0, 56)}-${n}`;
    const lc = candidate.toLowerCase();
    const where = exceptId
      ? and(sql`lower(${rooms.slug}) = ${lc}`, ne(rooms.id, exceptId))
      : sql`lower(${rooms.slug}) = ${lc}`;
    const clash = (await db.select({ id: rooms.id }).from(rooms).where(where).limit(1))[0];
    if (!clash) return candidate;
  }
}

/**
 * Fill a slug for every room that lacks one. Idempotent and cheap when
 * there's nothing to do (a single SELECT returning no rows). Run once at
 * boot after migrations. Returns the number of rooms backfilled.
 */
export async function backfillRoomSlugs(db: Db): Promise<number> {
  const missing = await db
    .select({ id: rooms.id, name: rooms.name })
    .from(rooms)
    .where(isNull(rooms.slug));
  let filled = 0;
  for (const r of missing) {
    const slug = await deriveUniqueRoomSlug(db, r.name, r.id);
    await db.update(rooms).set({ slug }).where(eq(rooms.id, r.id));
    filled++;
  }
  return filled;
}
