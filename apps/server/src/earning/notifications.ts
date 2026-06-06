/**
 * Rank-up notifications.
 *
 * Per the project ethos memory: no video-game toasts. Rank/tier
 * crossings still need to be discoverable, so we persist them in
 * `earning_notifications` and the chat ribbon UI reads + ack's them.
 *
 *   - `record()` is called by the award pipeline when a tier boundary
 *     is crossed.
 *   - `listUnacknowledged()` powers the ribbon + dashboard "What's new"
 *     pin.
 *   - `ack()` clears a single rank-up.
 *   - `ackAllForUser()` clears the entire backlog (used by a
 *     "dismiss all" affordance).
 *
 * Notifications outlive socket sessions deliberately, a user who
 * ranks up while offline (e.g. via an admin grant) sees the ribbon
 * the next time they sign in.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../db/index.js";
import { earningNotifications } from "../db/schema.js";
import type { RankCrossing } from "./resolver.js";

export interface PersistedRankUpInput {
  userId: string;
  scope: "user" | "character";
  /** characterId when scope = 'character'. Required by callers; the column allows null only for scope = 'user'. */
  characterId: string | null;
  crossing: RankCrossing;
}

export interface RankUpRecord {
  id: string;
  scope: "user" | "character";
  characterId: string | null;
  fromRankKey: string | null;
  fromTier: number | null;
  toRankKey: string;
  toTier: number;
  newlyEligibleBorderKeys: string[];
  createdAt: number;
}

/**
 * Persist a rank-up event for the user. Idempotency: a single user can
 * accumulate multiple rank-ups (rapid burst, admin grant, etc.) and each
 * one is a separate row so the ribbon can iterate through them.
 */
export async function recordRankUp(db: Db, input: PersistedRankUpInput): Promise<RankUpRecord> {
  const id = nanoid();
  const now = new Date();
  const joinedBorders = input.crossing.newlyEligibleBorderKeys.join(",");
  await db.insert(earningNotifications).values({
    id,
    userId: input.userId,
    kind: "rankup",
    scope: input.scope,
    characterId: input.scope === "character" ? input.characterId : null,
    fromRankKey: input.crossing.fromRankKey,
    fromTier: input.crossing.fromTier,
    toRankKey: input.crossing.toRankKey,
    toTier: input.crossing.toTier,
    newlyEligibleBorderKeys: joinedBorders,
    createdAt: now,
  });
  return {
    id,
    scope: input.scope,
    characterId: input.scope === "character" ? input.characterId : null,
    fromRankKey: input.crossing.fromRankKey,
    fromTier: input.crossing.fromTier,
    toRankKey: input.crossing.toRankKey,
    toTier: input.crossing.toTier,
    newlyEligibleBorderKeys: [...input.crossing.newlyEligibleBorderKeys],
    createdAt: +now,
  };
}

/**
 * Unacknowledged rank-ups for a user, newest first. Capped to a sane
 * amount so a user who let the ribbon pile up doesn't blow out the
 * ribbon payload.
 */
export async function listUnacknowledged(
  db: Db,
  userId: string,
  limit = 25,
): Promise<RankUpRecord[]> {
  const rows = await db
    .select()
    .from(earningNotifications)
    .where(and(eq(earningNotifications.userId, userId), isNull(earningNotifications.acknowledgedAt)))
    .orderBy(desc(earningNotifications.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope as "user" | "character",
    characterId: r.characterId,
    fromRankKey: r.fromRankKey,
    fromTier: r.fromTier,
    toRankKey: r.toRankKey,
    toTier: r.toTier,
    newlyEligibleBorderKeys: r.newlyEligibleBorderKeys
      ? r.newlyEligibleBorderKeys.split(",").filter(Boolean)
      : [],
    createdAt: +r.createdAt,
  }));
}

/**
 * Acknowledge a single notification by id. No-op when the id is
 * unknown or already acknowledged (idempotent, clients can safely
 * retry on flaky connections).
 */
export async function ack(db: Db, userId: string, notificationId: string): Promise<void> {
  await db
    .update(earningNotifications)
    .set({ acknowledgedAt: new Date() })
    .where(and(
      eq(earningNotifications.id, notificationId),
      eq(earningNotifications.userId, userId),
      isNull(earningNotifications.acknowledgedAt),
    ));
}

/**
 * Acknowledge every unacknowledged notification for the user. Used by
 * the "dismiss all" button on the dashboard.
 */
export async function ackAllForUser(db: Db, userId: string): Promise<number> {
  const result = await db
    .update(earningNotifications)
    .set({ acknowledgedAt: new Date() })
    .where(and(eq(earningNotifications.userId, userId), isNull(earningNotifications.acknowledgedAt)));
  return result.changes ?? 0;
}
