/**
 * Shared arithmetic core for the app's compact "time ago" ladders.
 *
 * Several surfaces render a tiny relative-time label ("just now", "5m",
 * "3h", "2d", "2w") but each wants its own wording, cutoffs and rounding.
 * The ONLY thing they share is the `Date.now() - ms` bucketing into
 * minutes / hours / days / weeks. This core does that bucketing under a
 * config and returns the chosen tier + numeric value; every caller keeps
 * its own words/prefix/suffix so the rendered output is byte-identical to
 * the hand-rolled version it replaced.
 */

export type RelTimeTier = "justNow" | "minutes" | "hours" | "days" | "weeks";

export interface RelTimeConfig {
  /** When |delta| is below this many seconds the tier is "justNow". */
  justNowSec: number;
  /** Switch from the "hours" tier to "days" at this many whole hours. */
  hourCutoffHrs: number;
  /** Rounding applied at each unit step (floor for elapsed, round for eta). */
  roundMode: "floor" | "round";
  /** Clamp negative deltas to 0 before bucketing. */
  clampNegative?: boolean;
  /** Roll "days" up into a "weeks" tier once days reach the week cutoff. */
  addWeeks?: boolean;
  /** Whole days at which days become weeks (default 7). Only with addWeeks. */
  weekCutoffDays?: number;
}

export interface RelTimeParts {
  tier: RelTimeTier;
  value: number;
}

/**
 * Bucket a signed delta (ms) into a tier + value per `cfg`.
 *
 * The staged rounding (`round(d/60000)` → `round(m/60)` → `round(h/24)`)
 * mirrors the original copies exactly, so the numeric value matches what
 * each surface used to compute. Callers own the wording.
 */
export function relTimeParts(deltaMs: number, cfg: RelTimeConfig): RelTimeParts {
  const round = cfg.roundMode === "round" ? Math.round : Math.floor;
  let d = deltaMs;
  if (cfg.clampNegative) d = Math.max(0, d);
  if (d / 1000 < cfg.justNowSec) return { tier: "justNow", value: 0 };
  const m = round(d / 60_000);
  if (m < 60) return { tier: "minutes", value: m };
  const h = round(m / 60);
  if (h < cfg.hourCutoffHrs) return { tier: "hours", value: h };
  const days = round(h / 24);
  if (cfg.addWeeks) {
    const weekCutoff = cfg.weekCutoffDays ?? 7;
    if (days < weekCutoff) return { tier: "days", value: days };
    return { tier: "weeks", value: round(days / 7) };
  }
  return { tier: "days", value: days };
}
