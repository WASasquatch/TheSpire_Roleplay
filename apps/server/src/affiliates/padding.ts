/**
 * Top Communities traffic padding — optional SYNTHETIC in/out traffic a global
 * admin can add to a community card so a quiet listing still shows some life
 * (see the `pad_*` columns on `affiliates`).
 *
 * Design (deliberately lazy / no scheduler; ROLLING 24h period):
 *  - `pad_*_max` is the MOST a direction may add in any 24h window.
 *  - Each rolling 24h PERIOD, per direction, a seeded random CEILING in `[1, max]`
 *    is chosen (`padPeriodTarget`) and stamped on the row (`pad_*_target`). The
 *    period is anchored to a real timestamp (`pad_period_start`, ms), NOT the
 *    calendar day, so the ramp always starts at ~0 the moment padding is enabled
 *    or a period rolls over — enabling at 11pm no longer dumps most of a day's
 *    target instantly.
 *  - Through the period the shown count climbs from ~0 to that ceiling along an
 *    uneven-but-monotonic curve (`padPeriodFraction`) seeded per period, so it
 *    reads as organic (busier at some hours than others) and never ticks
 *    backwards between reads.
 *  - When a period completes, its ceiling is BANKED into a running total
 *    (`pad_*_banked`) and a fresh period + ceiling begin. Reads that span several
 *    un-viewed periods bank every completed period, so the cumulative top-sites
 *    number keeps pace with real elapsed time.
 *  - Synthetic traffic is NEVER written into the real `clicks_in`/`clicks_out`
 *    counters; it's added only at read time, so the true numbers stay intact and
 *    disabling padding simply freezes the banked total (no ugly drop).
 *
 * Everything is a deterministic function of (row, now), so repeated reads within
 * a period are stable and no per-request randomness leaks in.
 */
import type { DbAffiliate } from "../db/schema.js";

/** One padding period. Rolling, anchored to `pad_period_start`. */
export const PAD_PERIOD_MS = 24 * 60 * 60 * 1000;

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

/**
 * This period's synthetic CEILING for a direction: a seeded int in `[1, max]`,
 * stable for (card, direction, periodStart). Consecutive periods are one
 * `PAD_PERIOD_MS` apart, so their seeds — and ceilings — differ.
 */
export function padPeriodTarget(
  cardId: string,
  dir: "in" | "out",
  periodStart: number,
  max: number,
): number {
  if (max <= 0) return 0;
  const r = rngFor(`${cardId}:${dir}:${periodStart}:target`)();
  // [1, max] inclusive — never draws 0, always some life.
  return Math.min(max, 1 + Math.floor(r * max));
}

/**
 * Fraction `[0,1]` of this period's ceiling realized at position `x` (0 = period
 * start, 1 = period end). Splits the period into 24 buckets with seeded weights
 * and returns the cumulative weight (plus the current bucket's linear partial)
 * over the total — an uneven but strictly non-decreasing curve with f(0)=0 and
 * f(1)=1, stable across reads within the period.
 */
export function padPeriodFraction(
  cardId: string,
  dir: "in" | "out",
  periodStart: number,
  x: number,
): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const rng = rngFor(`${cardId}:${dir}:${periodStart}:curve`);
  const w: number[] = [];
  let total = 0;
  for (let b = 0; b < 24; b++) {
    const v = 0.4 + rng() * 1.2; // per-bucket weight in [0.4, 1.6]
    w.push(v);
    total += v;
  }
  const pos = x * 24;
  const bi = Math.floor(pos);
  const frac = pos - bi;
  let cum = 0;
  for (let b = 0; b < bi; b++) cum += w[b] ?? 0;
  cum += (w[bi] ?? 0) * frac;
  return total > 0 ? Math.min(1, cum / total) : x;
}

export interface PadResult {
  /** Columns to persist when a period rolled over / needs first init; else null. */
  patch: Partial<DbAffiliate> | null;
  /** Effective (real + synthetic) counts — for display AND ranking. */
  effIn: number;
  effOut: number;
  /** Synthetic-only contribution currently shown (banked + this period's partial). */
  padIn: number;
  padOut: number;
}

/**
 * Effective padded counts for a card at `now`, plus any settle patch (period
 * rollover / first-time init) the caller should persist. Pure + deterministic
 * given (row, now).
 */
export function computePad(row: DbAffiliate, now: Date): PadResult {
  // Fast path: nothing to pad and nothing banked → real counts, no settle write.
  if (!row.padInEnabled && !row.padOutEnabled && row.padInBanked === 0 && row.padOutBanked === 0) {
    return { patch: null, effIn: row.clicksIn, effOut: row.clicksOut, padIn: 0, padOut: 0 };
  }
  const nowMs = now.getTime();
  let inBanked = row.padInBanked;
  let outBanked = row.padOutBanked;
  let inTarget = row.padInTarget;
  let outTarget = row.padOutTarget;
  let start = row.padPeriodStart;
  let patch: Partial<DbAffiliate> | null = null;

  if (start == null) {
    // Fresh init: open a period NOW and draw ceilings for enabled directions, so
    // the ramp starts from 0 at exactly this instant.
    start = nowMs;
    inTarget = row.padInEnabled ? padPeriodTarget(row.id, "in", start, row.padInMax) : 0;
    outTarget = row.padOutEnabled ? padPeriodTarget(row.id, "out", start, row.padOutMax) : 0;
    patch = { padPeriodStart: start, padInTarget: inTarget, padOutTarget: outTarget };
  } else if (nowMs - start >= PAD_PERIOD_MS) {
    // One or more full periods elapsed since the last settle: bank each completed
    // period's ceiling (period 0 uses the already-drawn stored target; later ones
    // redraw deterministically from their own start), then open a fresh period.
    const elapsed = Math.floor((nowMs - start) / PAD_PERIOD_MS);
    for (let k = 0; k < elapsed; k++) {
      const ps = start + k * PAD_PERIOD_MS;
      inBanked += k === 0 ? inTarget : (row.padInEnabled ? padPeriodTarget(row.id, "in", ps, row.padInMax) : 0);
      outBanked += k === 0 ? outTarget : (row.padOutEnabled ? padPeriodTarget(row.id, "out", ps, row.padOutMax) : 0);
    }
    start = start + elapsed * PAD_PERIOD_MS;
    inTarget = row.padInEnabled ? padPeriodTarget(row.id, "in", start, row.padInMax) : 0;
    outTarget = row.padOutEnabled ? padPeriodTarget(row.id, "out", start, row.padOutMax) : 0;
    patch = {
      padPeriodStart: start,
      padInBanked: inBanked,
      padOutBanked: outBanked,
      padInTarget: inTarget,
      padOutTarget: outTarget,
    };
  }

  // This period's partial (enabled directions only; clamp to the current max in
  // case an admin lowered it after the ceiling was drawn).
  const x = Math.min(1, Math.max(0, (nowMs - start) / PAD_PERIOD_MS));
  const inNow = row.padInEnabled
    ? Math.round(Math.min(inTarget, row.padInMax) * padPeriodFraction(row.id, "in", start, x))
    : 0;
  const outNow = row.padOutEnabled
    ? Math.round(Math.min(outTarget, row.padOutMax) * padPeriodFraction(row.id, "out", start, x))
    : 0;

  const padIn = inBanked + inNow;
  const padOut = outBanked + outNow;
  return {
    patch,
    effIn: row.clicksIn + padIn,
    effOut: row.clicksOut + padOut,
    padIn,
    padOut,
  };
}
