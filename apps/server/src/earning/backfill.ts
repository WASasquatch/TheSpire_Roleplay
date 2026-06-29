/**
 * One-shot historical XP backfill.
 *
 * On boot the server checks `earningConfig.backfill.completedAt`. If
 * null AND `xpPerHistoricalMessage > 0`, this function aggregates
 * every existing message row, applies the same IC / OOC routing rule
 * the live engine uses, and credits the resulting XP onto each pool.
 *
 * Currency is NOT backfilled, only XP. The rationale (per plan.md):
 * historical contribution is a fair signal of how far up the rank
 * ladder someone should land, but minting Currency from scratch
 * hands long-tenured users a buying war chest on day one and breaks
 * the economy.
 *
 * Body floor: messages with `length(trim(body)) < bodyFloorChars`
 * are excluded. Short throwaway lines shouldn't have earned XP
 * historically, so backfill skips them too.
 *
 * Idempotency: the migration / first-boot path stamps
 * `earningConfig.backfill.completedAt` after a successful run.
 * Subsequent boots see the timestamp and skip, even if the
 * `_migrations` ledger forgets the seed migration ever ran.
 */

import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../db/index.js";
import {
  characterEarning,
  earningLedger,
  userEarning,
} from "../db/schema.js";
import { getSettings, updateSettings } from "../settings.js";
import { mergeMaxEverHeld, resolveRankForXp } from "./resolver.js";
import { DEFAULT_SERVER_ID } from "./pool.js";

/** Per (scope, ownerId) pool accumulator. */
type Pool = { scope: "user" | "character"; ownerId: string; xp: number; messageCount: number };

/**
 * Run the backfill if it hasn't run yet. Returns a summary describing
 * what happened. Safe to call on every boot, the guard checks below
 * short-circuit cleanly when the work is already done or disabled.
 *
 * The function logs progress at info level; failures bubble up so the
 * caller (the boot path) can decide whether to crash the server or
 * just log + continue. Current callers `void`-and-log so a backfill
 * failure never blocks the boot.
 */
export async function runBackfillIfNeeded(
  db: Db,
  log: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
): Promise<{ status: "skipped" | "completed"; reason?: string; pools?: number; messagesCounted?: number }> {
  const settings = await getSettings(db);
  const cfg = settings.earningConfig;
  if (cfg.backfill.completedAt) {
    return { status: "skipped", reason: "already_completed" };
  }
  const ratePerMessage = cfg.backfill.xpPerHistoricalMessage;
  if (!Number.isFinite(ratePerMessage) || ratePerMessage <= 0) {
    // Rate set to 0 or invalid, mark complete so we don't keep
    // re-checking on every boot.
    await markBackfillComplete(db);
    return { status: "skipped", reason: "rate_zero_or_invalid" };
  }
  const bodyFloor = Math.max(0, cfg.bodyFloorChars);

  log.info(`[earning] backfill starting (rate=${ratePerMessage} XP/message, bodyFloor=${bodyFloor})`);

  // Aggregate. One SELECT groups by (user_id, character_id, kind) and
  // returns the message count for each group. We then apply the routing
  // rule per group to decide which pool the count contributes to.
  //
  // Filters:
  //   - kind not in ('cmd','system'), never earned XP live
  //   - deleted_at IS NULL, removed messages never earned XP
  //   - length(trim(body)) >= bodyFloor, body floor
  const groups = await db.all<{
    userId: string;
    characterId: string | null;
    kind: string;
    n: number;
  }>(sql`
    SELECT user_id AS userId,
           character_id AS characterId,
           kind AS kind,
           COUNT(*) AS n
    FROM messages
    WHERE kind NOT IN ('cmd', 'system')
      AND deleted_at IS NULL
      AND length(trim(body)) >= ${bodyFloor}
    GROUP BY user_id, character_id, kind
  `);

  // Pool accumulator: master pool keyed on userId, character pool on
  // characterId. The routing rule is the same as the live `routeMessage`
  // helper:
  //   - kind = ooc/whisper → master
  //   - kind = any other (non-skipped) and characterId set → character
  //   - kind = any other but characterId null → master
  const pools = new Map<string, Pool>();
  let totalMessagesCounted = 0;
  for (const g of groups) {
    totalMessagesCounted += g.n;
    const isOocKind = g.kind === "ooc" || g.kind === "whisper";
    const scope: "user" | "character" =
      isOocKind || !g.characterId ? "user" : "character";
    const ownerId = scope === "character" ? g.characterId! : g.userId;
    const key = `${scope}::${ownerId}`;
    const existing = pools.get(key);
    if (existing) {
      existing.xp += Math.round(g.n * ratePerMessage);
      existing.messageCount += g.n;
    } else {
      pools.set(key, {
        scope,
        ownerId,
        xp: Math.round(g.n * ratePerMessage),
        messageCount: g.n,
      });
    }
  }

  // Write each pool. Sequential rather than concurrent because every
  // write touches the singleton earning row + a new ledger row in
  // the same SQLite WAL, concurrent writes would just serialize on
  // the writer lock anyway. Lazy-create the earning row if missing.
  for (const pool of pools.values()) {
    try {
      // Historical XP all homes to the default server (the pre-servers world
      // = the single default server). Stamp server_spire_system on the pool
      // rows + ledger so the grain matches the rest of the legacy data.
      if (pool.scope === "user") {
        await db.insert(userEarning).values({ serverId: DEFAULT_SERVER_ID, userId: pool.ownerId }).onConflictDoNothing();
        const prior = (await db.select().from(userEarning).where(sql`${userEarning.serverId} = ${DEFAULT_SERVER_ID} AND ${userEarning.userId} = ${pool.ownerId}`).limit(1))[0];
        if (!prior) continue;
        const newXp = prior.xp + pool.xp;
        const placed = await resolveRankForXp(db, newXp);
        const peak = await mergeMaxEverHeld(db, {
          maxRankKeyEverHeld: prior.maxRankKeyEverHeld,
          maxTierEverHeld: prior.maxTierEverHeld,
        }, placed);
        await db.update(userEarning).set({
          xp: newXp,
          rankKey: placed.rankKey,
          tier: placed.tier,
          maxRankKeyEverHeld: peak.maxRankKeyEverHeld,
          maxTierEverHeld: peak.maxTierEverHeld,
          updatedAt: new Date(),
        }).where(sql`${userEarning.serverId} = ${DEFAULT_SERVER_ID} AND ${userEarning.userId} = ${pool.ownerId}`);
      } else {
        await db.insert(characterEarning).values({ serverId: DEFAULT_SERVER_ID, characterId: pool.ownerId }).onConflictDoNothing();
        const prior = (await db.select().from(characterEarning).where(sql`${characterEarning.serverId} = ${DEFAULT_SERVER_ID} AND ${characterEarning.characterId} = ${pool.ownerId}`).limit(1))[0];
        if (!prior) continue;
        const newXp = prior.xp + pool.xp;
        const placed = await resolveRankForXp(db, newXp);
        const peak = await mergeMaxEverHeld(db, {
          maxRankKeyEverHeld: prior.maxRankKeyEverHeld,
          maxTierEverHeld: prior.maxTierEverHeld,
        }, placed);
        await db.update(characterEarning).set({
          xp: newXp,
          rankKey: placed.rankKey,
          tier: placed.tier,
          maxRankKeyEverHeld: peak.maxRankKeyEverHeld,
          maxTierEverHeld: peak.maxTierEverHeld,
          updatedAt: new Date(),
        }).where(sql`${characterEarning.serverId} = ${DEFAULT_SERVER_ID} AND ${characterEarning.characterId} = ${pool.ownerId}`);
      }
      await db.insert(earningLedger).values({
        id: nanoid(),
        serverId: DEFAULT_SERVER_ID,
        scope: pool.scope,
        ownerId: pool.ownerId,
        xpDelta: pool.xp,
        currencyDelta: 0,
        reason: "backfill_message_xp",
        metadataJson: JSON.stringify({ messageCount: pool.messageCount, rate: ratePerMessage }),
        createdAt: new Date(),
      });
    } catch (err) {
      log.error({ err, pool }, "[earning] backfill: pool write failed");
      // Keep going, a single pool failing shouldn't kill the whole batch.
    }
  }

  await markBackfillComplete(db);
  log.info(`[earning] backfill complete: ${pools.size} pools credited from ${totalMessagesCounted} messages`);
  return { status: "completed", pools: pools.size, messagesCounted: totalMessagesCounted };
}

async function markBackfillComplete(db: Db): Promise<void> {
  const settings = await getSettings(db);
  const next = {
    ...settings.earningConfig,
    backfill: {
      ...settings.earningConfig.backfill,
      completedAt: Date.now(),
    },
  };
  // `updateSettings` requires a `byUserId`; backfill is system-initiated
  // so we look up the bootstrap 'system' user (matches the pattern used
  // by setWorldsSeedVersion).
  const sysUser = (await db.all<{ id: string }>(sql`SELECT id FROM users WHERE username = 'system' LIMIT 1`))[0];
  await updateSettings(db, { earningConfig: next }, sysUser?.id ?? "system");
}
