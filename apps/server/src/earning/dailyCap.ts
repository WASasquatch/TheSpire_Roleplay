import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { earningLedger } from "../db/schema.js";

/**
 * Shared "how much have I already earned toward a daily cap today" ledger
 * scan + the arcade clamp, extracted byte-for-byte from four reward sources:
 *
 *   - `routes/arcadeGrimhold.ts`  (LIKE `grimhold_%`, currency, per-active-server)
 *   - `routes/arcadeUrugal.ts`    (LIKE `urugal_%`,   currency, per-active-server)
 *   - `routes/stories.ts` royalty (eq `scriptorium_royalty`,        currency, DEFAULT server)
 *   - `routes/stories.ts` chapter (eq `scriptorium_chapter_reward`, xp+currency, DEFAULT server)
 *
 * Each caller kept its own divergences (see the plan §P3): the reason-match
 * mode (LIKE-prefix vs eq), which sum(s) it reads, which serverId it scopes
 * to, and its own clamp shape. Those all map onto the options below so every
 * caller's observable result is unchanged.
 *
 * NOTE ON READ TIMING: Urugal reads this sum OUTSIDE its milestone
 * transaction and clamps INSIDE it. That timing is deliberate (see the
 * urugal event handler) and is preserved by keeping the scan (this function)
 * and the clamp (`clampToDailyCap`) as separate steps the caller sequences.
 */

type Scope = "user" | "character";

/** How to match the ledger `reason` column for a given reward source. */
export type CapReasonMatch =
  /** `reason LIKE '<prefix>\_%' ESCAPE '\'` — the two arcade cabinets, which
   *  emit `grimhold_<game>` / `urugal_<...>` rows and cap across the family.
   *  The `_` after the prefix is escaped so it is a literal underscore, exactly
   *  as the inline copies wrote it. */
  | { likePrefix: string }
  /** `reason = '<reason>'` — the Scriptorium sources, one exact reason each. */
  | { reason: string };

export interface EarnedTodayScanOpts {
  serverId: string;
  scope: Scope;
  ownerId: string;
  reason: CapReasonMatch;
  /** Inclusive lower bound (`createdAt >= sinceMs`); callers pass
   *  `startOfUtcDayMs(now)`. */
  sinceMs: number;
}

/**
 * Sum the XP and currency this pool has already earned from a reward source
 * today. Both aggregates are `COALESCE(SUM(...), 0)` so the row is always
 * present; callers read whichever field(s) their cap uses. Runs synchronously
 * against better-sqlite3 (matches the inline copies, which were sync in the
 * arcade paths and awaited a synchronous builder in the Scriptorium paths).
 */
export function earnedTodayForCap(
  db: Db,
  opts: EarnedTodayScanOpts,
): { xp: number; currency: number } {
  const reasonCond =
    "likePrefix" in opts.reason
      ? sql`${earningLedger.reason} LIKE ${opts.reason.likePrefix + "\\_%"} ESCAPE '\\'`
      : eq(earningLedger.reason, opts.reason.reason);
  const row = db
    .select({
      xp: sql<number>`COALESCE(SUM(${earningLedger.xpDelta}), 0)`,
      currency: sql<number>`COALESCE(SUM(${earningLedger.currencyDelta}), 0)`,
    })
    .from(earningLedger)
    .where(
      and(
        eq(earningLedger.serverId, opts.serverId),
        eq(earningLedger.scope, opts.scope),
        eq(earningLedger.ownerId, opts.ownerId),
        reasonCond,
        sql`${earningLedger.createdAt} >= ${opts.sinceMs}`,
      ),
    )
    .all()[0];
  return { xp: Number(row?.xp ?? 0), currency: Number(row?.currency ?? 0) };
}

/**
 * The arcade daily-cap clamp, shared by Grimhold and Urugal (whose clamps were
 * byte-identical). The single per-day currency ceiling gates XP too: once the
 * remaining headroom hits 0, XP stops as well, and `capped` reports whether
 * either grant was trimmed.
 *
 * `remainingCap` is the already-computed headroom
 * (`Math.max(0, CAP - earnedToday)`); it is passed in rather than the raw cap
 * so Urugal can compute it outside its transaction and clamp inside.
 *
 * The Scriptorium sources deliberately do NOT use this: royalty has a single
 * currency-only clamp, and chapter rewards clamp XP and currency against two
 * independent caps. Those stay at their call sites.
 */
export function clampToDailyCap(
  reward: { currency: number; xp: number },
  remainingCap: number,
): { currency: number; xp: number; capped: boolean } {
  const currency = Math.min(reward.currency, remainingCap);
  const xp = remainingCap > 0 ? reward.xp : 0;
  const capped = currency < reward.currency || xp < reward.xp;
  return { currency, xp, capped };
}
