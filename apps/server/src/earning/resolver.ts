/**
 * XP → (rankKey, tier) resolver and rank-placement helpers.
 *
 * The award engine calls `resolveRankForXp` after every XP credit to
 * decide whether the pool just crossed a tier boundary. Resolver
 * reads the live `rank_tiers` table on every call, admins can edit
 * thresholds, swap assets, or disable a rank from the panel and the
 * next earn respects the change without a deploy.
 *
 * Disabled-rank semantics ("soft close" per plan.md): a rank with
 * `ranks.enabled = 0` is skipped by the resolver. A user climbing
 * past that rank's thresholds lands at the next *enabled* rank's
 * lowest qualifying tier. Existing rank-holders in a now-disabled
 * rank stay put, `maxRankKeyEverHeld` is only ever bumped UP, never
 * recomputed from the live table.
 */

import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  characterEarning,
  rankTiers,
  ranks,
  userEarning,
  type DbRank,
  type DbRankTier,
} from "../db/schema.js";

export interface ResolvedRank {
  /** null when the user is below the lowest enabled tier (e.g. fresh account, no XP yet). */
  rankKey: string | null;
  tier: number | null;
}

export interface RankCrossing {
  fromRankKey: string | null;
  fromTier: number | null;
  toRankKey: string;
  toTier: number;
  /** Rank keys whose Tier IV the user just crossed into for the first time (border eligibility unlocks). */
  newlyEligibleBorderKeys: string[];
}

/**
 * Look up the highest enabled (rank, tier) row whose `xpThreshold <= xp`.
 * Returns `{ rankKey: null, tier: null }` when no row qualifies (every
 * row has a threshold above the input XP, or the catalog is empty).
 *
 * One indexed query, cheap to call on every award. The compound
 * filter joins to `ranks` so disabled ranks fall out without a second
 * roundtrip.
 */
export async function resolveRankForXp(db: Db, xp: number): Promise<ResolvedRank> {
  if (xp < 0) return { rankKey: null, tier: null };
  const row = (await db
    .select({
      rankKey: rankTiers.rankKey,
      tier: rankTiers.tier,
      threshold: rankTiers.xpThreshold,
      rankOrder: ranks.order,
    })
    .from(rankTiers)
    .innerJoin(ranks, eq(ranks.key, rankTiers.rankKey))
    .where(and(eq(rankTiers.enabled, true), eq(ranks.enabled, true)))
    // Highest threshold the XP qualifies for. Order DESC on threshold
    // first (so we pick the strongest tier), break ties on rank order
    // DESC so a duplicate threshold at the same rank picks the higher
    // tier deterministically. The `<=` filter is applied as a `having`
    // alternative via the limit-1 ORDER BY here because better-sqlite3 +
    // drizzle can't express a parametrized `WHERE col <= ?` plus an
    // `ORDER BY ... LIMIT 1` more efficiently than this when the
    // column is indexed.
    .orderBy(desc(rankTiers.xpThreshold), desc(ranks.order), desc(rankTiers.tier))
    .all())
    .find((r) => r.threshold <= xp);
  if (!row) return { rankKey: null, tier: null };
  return { rankKey: row.rankKey, tier: row.tier };
}

/**
 * Given a user's prior peak (`maxRankKeyEverHeld` / `maxTierEverHeld`)
 * and a candidate new placement, return the merged peak. Never
 * decreases. The ordering is `(ranks.order asc, tier asc)`, a higher
 * rank always trumps a lower one regardless of tier, and within the
 * same rank a higher tier trumps a lower tier.
 *
 * Called after `resolveRankForXp` so callers can persist both
 * `rankKey`/`tier` and the new peak in one update.
 */
export async function mergeMaxEverHeld(
  db: Db,
  prior: { maxRankKeyEverHeld: string | null; maxTierEverHeld: number | null },
  candidate: ResolvedRank,
): Promise<{ maxRankKeyEverHeld: string | null; maxTierEverHeld: number | null }> {
  if (!candidate.rankKey || candidate.tier == null) return prior;
  if (!prior.maxRankKeyEverHeld || prior.maxTierEverHeld == null) {
    return {
      maxRankKeyEverHeld: candidate.rankKey,
      maxTierEverHeld: candidate.tier,
    };
  }
  // Look up both ranks' display order to compare. Two-row in batch.
  const rows = await db
    .select({ key: ranks.key, order: ranks.order })
    .from(ranks)
    .all();
  const orderByKey = new Map(rows.map((r) => [r.key, r.order]));
  const priorOrder = orderByKey.get(prior.maxRankKeyEverHeld) ?? -1;
  const candOrder = orderByKey.get(candidate.rankKey) ?? -1;
  if (candOrder > priorOrder) {
    return { maxRankKeyEverHeld: candidate.rankKey, maxTierEverHeld: candidate.tier };
  }
  if (candOrder === priorOrder && candidate.tier > prior.maxTierEverHeld) {
    return { maxRankKeyEverHeld: prior.maxRankKeyEverHeld, maxTierEverHeld: candidate.tier };
  }
  return prior;
}

/**
 * Diff a pool's rank state before and after an XP credit. Returns a
 * RankCrossing payload when the user has moved up, or null when nothing
 * changed (including the no-op case where the resolved rank is the same).
 *
 * The `newlyEligibleBorderKeys` list captures Tier IV crossings the
 * user wasn't already eligible for. Drives the rank-up notification's
 * "you can now buy the X border" line in the dashboard + /exp output.
 */
export function diffCrossing(
  before: { rankKey: string | null; tier: number | null; maxTierEverHeld: number | null; maxRankKeyEverHeld: string | null },
  after: ResolvedRank,
  newPeak: { maxRankKeyEverHeld: string | null; maxTierEverHeld: number | null },
): RankCrossing | null {
  if (!after.rankKey || after.tier == null) return null;
  const movedRank = before.rankKey !== after.rankKey;
  const movedTier = before.rankKey === after.rankKey && before.tier !== after.tier;
  if (!movedRank && !movedTier) return null;
  const newlyEligibleBorderKeys: string[] = [];
  // Tier IV (the capstone) is what unlocks border eligibility. We
  // declare a crossing newly-eligible when the *peak* tier-4 status
  // for the destination rank wasn't already recorded.
  const reachedCapstone = after.tier >= 4;
  const peakKeyWasSame = before.maxRankKeyEverHeld === after.rankKey;
  const peakWasAlreadyCapstone =
    peakKeyWasSame && (before.maxTierEverHeld ?? 0) >= 4;
  if (reachedCapstone && !peakWasAlreadyCapstone) {
    newlyEligibleBorderKeys.push(after.rankKey);
  }
  // Cross-check against the merged peak so we never claim a "newly eligible"
  // border that the peak already knows about (defensive, diff is the source
  // of truth, peak just confirms).
  if (newPeak.maxRankKeyEverHeld === after.rankKey && (newPeak.maxTierEverHeld ?? 0) >= 4 && reachedCapstone && peakWasAlreadyCapstone) {
    // Already eligible, drop from list if somehow added.
    newlyEligibleBorderKeys.length = 0;
  }
  return {
    fromRankKey: before.rankKey,
    fromTier: before.tier,
    toRankKey: after.rankKey,
    toTier: after.tier,
    newlyEligibleBorderKeys,
  };
}

/**
 * Bulk re-resolve every earning row (user + character scopes) against
 * the current rank_tiers table. Called from the admin Ranks tab after a
 * threshold edit, keeps denormalized `rankKey` / `tier` in sync with
 * the new placements without forcing every user to send a message
 * before their displayed rank updates.
 *
 * Cost: O(rows × log(tiers)) for the resolver lookups. Acceptable at
 * Keep scale (a few thousand users); if it grows we can move to a single
 * SQL pass with a window function.
 */
export async function backfillAllRankPlacements(db: Db): Promise<{ users: number; characters: number }> {
  const userRows = await db.select().from(userEarning).all();
  for (const row of userRows) {
    const placed = await resolveRankForXp(db, row.xp);
    const peak = await mergeMaxEverHeld(db, {
      maxRankKeyEverHeld: row.maxRankKeyEverHeld,
      maxTierEverHeld: row.maxTierEverHeld,
    }, placed);
    await db
      .update(userEarning)
      .set({
        rankKey: placed.rankKey,
        tier: placed.tier,
        maxRankKeyEverHeld: peak.maxRankKeyEverHeld,
        maxTierEverHeld: peak.maxTierEverHeld,
        updatedAt: new Date(),
      })
      .where(eq(userEarning.userId, row.userId));
  }
  const charRows = await db.select().from(characterEarning).all();
  for (const row of charRows) {
    const placed = await resolveRankForXp(db, row.xp);
    const peak = await mergeMaxEverHeld(db, {
      maxRankKeyEverHeld: row.maxRankKeyEverHeld,
      maxTierEverHeld: row.maxTierEverHeld,
    }, placed);
    await db
      .update(characterEarning)
      .set({
        rankKey: placed.rankKey,
        tier: placed.tier,
        maxRankKeyEverHeld: peak.maxRankKeyEverHeld,
        maxTierEverHeld: peak.maxTierEverHeld,
        updatedAt: new Date(),
      })
      .where(eq(characterEarning.characterId, row.characterId));
  }
  return { users: userRows.length, characters: charRows.length };
}

/**
 * Convenience: list every rank ordered for display. Cached by callers
 * (the dashboard and admin tab) since the catalog is small and rarely
 * changes. Kept here so the ordering rule (ASC by `order`, then
 * `name`) lives next to the resolver that depends on it.
 */
export async function listRanksOrdered(db: Db) {
  return db
    .select()
    .from(ranks)
    .orderBy(asc(ranks.order), asc(ranks.name))
    .all();
}

/**
 * Sync rank-placement helper. Operates on pre-loaded `ranks` and
 * `rank_tiers` rows so the caller can run the resolver inside a
 * `db.transaction((tx) => {...})` callback where the async query
 * builders don't apply.
 *
 * Same skip-disabled-ranks semantics as `resolveRankForXp`, a user
 * climbing past a disabled rank's threshold lands in the next-higher
 * enabled rank's lowest tier.
 */
export function placeRankForXpSync(
  rankRows: readonly DbRank[],
  tierRows: readonly DbRankTier[],
  xp: number,
): ResolvedRank {
  if (xp < 0) return { rankKey: null, tier: null };
  const enabledRanks = new Set(rankRows.filter((r) => r.enabled).map((r) => r.key));
  const rankOrder = new Map(rankRows.map((r) => [r.key, r.order]));
  // Pick the highest-threshold enabled tier whose threshold <= xp.
  // Tie-break: rank order DESC, then tier DESC, matching the
  // resolveRankForXp behavior.
  let best: DbRankTier | null = null;
  for (const t of tierRows) {
    if (!t.enabled) continue;
    if (!enabledRanks.has(t.rankKey)) continue;
    if (t.xpThreshold > xp) continue;
    if (!best) { best = t; continue; }
    if (t.xpThreshold > best.xpThreshold) { best = t; continue; }
    if (t.xpThreshold === best.xpThreshold) {
      const oA = rankOrder.get(t.rankKey) ?? -1;
      const oB = rankOrder.get(best.rankKey) ?? -1;
      if (oA > oB || (oA === oB && t.tier > best.tier)) best = t;
    }
  }
  if (!best) return { rankKey: null, tier: null };
  return { rankKey: best.rankKey, tier: best.tier };
}

/**
 * Sync version of `mergeMaxEverHeld`, same semantics, accepts the
 * pre-loaded ranks list for inside-transaction use.
 */
export function mergeMaxEverHeldSync(
  rankRows: readonly DbRank[],
  prior: { maxRankKeyEverHeld: string | null; maxTierEverHeld: number | null },
  candidate: ResolvedRank,
): { maxRankKeyEverHeld: string | null; maxTierEverHeld: number | null } {
  if (!candidate.rankKey || candidate.tier == null) return prior;
  if (!prior.maxRankKeyEverHeld || prior.maxTierEverHeld == null) {
    return { maxRankKeyEverHeld: candidate.rankKey, maxTierEverHeld: candidate.tier };
  }
  const orderByKey = new Map(rankRows.map((r) => [r.key, r.order]));
  const priorOrder = orderByKey.get(prior.maxRankKeyEverHeld) ?? -1;
  const candOrder = orderByKey.get(candidate.rankKey) ?? -1;
  if (candOrder > priorOrder) {
    return { maxRankKeyEverHeld: candidate.rankKey, maxTierEverHeld: candidate.tier };
  }
  if (candOrder === priorOrder && candidate.tier > prior.maxTierEverHeld) {
    return { maxRankKeyEverHeld: prior.maxRankKeyEverHeld, maxTierEverHeld: candidate.tier };
  }
  return prior;
}

/**
 * Read the denormalized rank for a single pool. Cheap one-row lookup;
 * returns nulls when the row doesn't exist yet (fresh account) so the
 * caller can render gracefully (no sigil).
 *
 * `(scope, ownerId)` is the same shape used everywhere else in the
 * Earning engine, `user` scope keys on userId, `character` scope
 * keys on characterId.
 */
export async function readPoolRank(
  db: Db,
  scope: "user" | "character",
  ownerId: string,
): Promise<ResolvedRank> {
  if (scope === "user") {
    const row = (await db
      .select({ rankKey: userEarning.rankKey, tier: userEarning.tier })
      .from(userEarning)
      .where(eq(userEarning.userId, ownerId))
      .limit(1))[0];
    return { rankKey: row?.rankKey ?? null, tier: row?.tier ?? null };
  }
  const row = (await db
    .select({ rankKey: characterEarning.rankKey, tier: characterEarning.tier })
    .from(characterEarning)
    .where(eq(characterEarning.characterId, ownerId))
    .limit(1))[0];
  return { rankKey: row?.rankKey ?? null, tier: row?.tier ?? null };
}
