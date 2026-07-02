/**
 * Top Communities traffic padding — optional SYNTHETIC in/out traffic a global
 * admin can add to a community card so a quiet listing still shows some life
 * (see migration 0311 + the `pad_*` columns on `affiliates`).
 *
 * Design (deliberately lazy / no scheduler):
 *  - Each day, per direction, a seeded RANDOM target in `[0, max]` is chosen
 *    (`padDailyTarget`) and stamped onto the row (`pad_*_target` + `pad_day`).
 *  - Through the day the shown count climbs from ~0 to that target along an
 *    uneven-but-monotonic curve (`padDayFraction`) so it reads as organic and
 *    never ticks backwards between reads.
 *  - When the day rolls over, the completed target is BANKED into a running
 *    total (`pad_*_banked`) and a fresh target is drawn — so the cumulative
 *    top-sites number grows day over day, like a real counter.
 *  - Synthetic traffic is NEVER written into the real `clicks_in`/`clicks_out`
 *    counters; it's added only at read time, so the true numbers stay intact and
 *    disabling padding simply freezes the banked total (no ugly drop).
 *
 * Everything is a deterministic function of (cardId, direction, day, now), so
 * repeated reads within a day are stable and no per-request randomness leaks in.
 */
import type { DbAffiliate } from "../db/schema.js";

/** Deterministic string → 32-bit seed (xmur3). */
function xmur3(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** Small seeded PRNG (mulberry32) → () => [0,1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFor(seedStr: string): () => number {
  return mulberry32(xmur3(seedStr));
}

/** Local YYYY-MM-DD for the given instant (the "day" a target belongs to). */
export function padDayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Today's synthetic target for a direction: a seeded int in `[0, max]`, stable
 *  for (card, direction, day). */
export function padDailyTarget(
  cardId: string,
  dir: "in" | "out",
  day: string,
  max: number,
): number {
  if (max <= 0) return 0;
  const r = rngFor(`${cardId}:${dir}:${day}:target`)();
  return Math.round(r * max);
}

/**
 * Fraction `[0,1]` of today's target that should be realized by `now`. Splits the
 * day into 24 hourly buckets with seeded weights and returns the cumulative
 * weight (plus the current hour's linear partial) over the total — an uneven but
 * strictly non-decreasing curve, stable across reads within the day.
 */
export function padDayFraction(
  cardId: string,
  dir: "in" | "out",
  day: string,
  now: Date,
): number {
  const rng = rngFor(`${cardId}:${dir}:${day}:curve`);
  const w: number[] = [];
  let total = 0;
  for (let h = 0; h < 24; h++) {
    const x = 0.4 + rng() * 1.2; // per-hour weight in [0.4, 1.6]
    w.push(x);
    total += x;
  }
  const hour = now.getHours();
  const minFrac = (now.getMinutes() * 60 + now.getSeconds()) / 3600;
  let cum = 0;
  for (let h = 0; h < hour; h++) cum += w[h] ?? 0;
  cum += (w[hour] ?? 0) * minFrac;
  return total > 0 ? Math.min(1, cum / total) : 0;
}

export interface PadResult {
  /** Columns to persist when the day rolled over / needs first init; else null. */
  patch: Partial<DbAffiliate> | null;
  /** Effective (real + synthetic) counts — for display AND ranking. */
  effIn: number;
  effOut: number;
  /** Synthetic-only contribution currently shown (banked + today's partial). */
  padIn: number;
  padOut: number;
}

/**
 * Effective padded counts for a card at `now`, plus any settle patch (day
 * rollover / first-time init) the caller should persist (at most once/day/card).
 * Pure + deterministic given (row, now).
 */
export function computePad(row: DbAffiliate, now: Date): PadResult {
  // Fast path: nothing to pad and nothing banked → real counts, no settle write.
  // Keeps the common (un-padded) card off the write path entirely.
  if (!row.padInEnabled && !row.padOutEnabled && row.padInBanked === 0 && row.padOutBanked === 0) {
    return { patch: null, effIn: row.clicksIn, effOut: row.clicksOut, padIn: 0, padOut: 0 };
  }
  const today = padDayKey(now);
  let inBanked = row.padInBanked;
  let outBanked = row.padOutBanked;
  let inTarget = row.padInTarget;
  let outTarget = row.padOutTarget;
  let patch: Partial<DbAffiliate> | null = null;

  if (row.padDay !== today) {
    // Roll over: bank the prior day's realized target (a null padDay is a fresh
    // init and banks nothing), draw new targets for enabled directions, stamp
    // today. A direction that's off draws a 0 target (banking it is a no-op).
    if (row.padDay) {
      inBanked += inTarget;
      outBanked += outTarget;
    }
    inTarget = row.padInEnabled ? padDailyTarget(row.id, "in", today, row.padInMax) : 0;
    outTarget = row.padOutEnabled ? padDailyTarget(row.id, "out", today, row.padOutMax) : 0;
    patch = {
      padDay: today,
      padInBanked: inBanked,
      padOutBanked: outBanked,
      padInTarget: inTarget,
      padOutTarget: outTarget,
    };
  }

  // Today's partial (enabled directions only; clamp to the current max in case an
  // admin lowered it after the target was drawn).
  const inToday = row.padInEnabled
    ? Math.round(Math.min(inTarget, row.padInMax) * padDayFraction(row.id, "in", today, now))
    : 0;
  const outToday = row.padOutEnabled
    ? Math.round(Math.min(outTarget, row.padOutMax) * padDayFraction(row.id, "out", today, now))
    : 0;

  const padIn = inBanked + inToday;
  const padOut = outBanked + outToday;
  return {
    patch,
    effIn: row.clicksIn + padIn,
    effOut: row.clicksOut + padOut,
    padIn,
    padOut,
  };
}
