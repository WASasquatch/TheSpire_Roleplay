/**
 * Canonical "ms -> compact label" formatter.
 *
 * Consolidates four historically divergent copies into one options-carrying
 * helper. Each old copy is reproduced byte-for-byte at its call site by the
 * options it passes; see the wrappers in `commands/duration.ts`
 * (`formatDuration`), `shared/export.ts` (`formatDurationShort`),
 * `shared/announcement.ts` (`formatDurationMs`), and
 * `AdminEarningTab.tsx` (local `formatDurationShort`).
 *
 * The day/hour/minute ladder is built from the highest non-zero unit downward,
 * including at most `maxUnits` positionally-consecutive units and emitting only
 * the non-zero ones (the first in the window is always non-zero). This single
 * rule reproduces both the "show every non-zero unit" copies (`maxUnits`
 * unbounded) and the AdminEarning "top two units, drop the rest" ladder
 * (`maxUnits: 2` -> minutes vanish once days appear, matching its
 * `<60m` / `<24h` / else branches exactly).
 *
 * Seconds are handled separately: they only ever rendered in the
 * `commands/duration` copy, and only when there are no days and no hours, so
 * `showSeconds` appends a seconds unit under that same gate rather than joining
 * the maxUnits window.
 */

const MS_D = 86_400_000;
const MS_H = 3_600_000;
const MS_M = 60_000;
const MS_S = 1_000;

export interface FormatDurationOptions {
  /** Joiner between emitted units. Default `""` (bare concatenation). */
  separator?: string;
  /**
   * Max number of positionally-consecutive d/h/m units to emit, counted from
   * the highest non-zero unit downward. Default `Infinity` (every non-zero
   * unit). `2` gives the AdminEarning "top two, drop lower" ladder.
   */
  maxUnits?: number;
  /**
   * Append a seconds unit when there are no days and no hours (and seconds is
   * non-zero). Only `commands/duration` sets this. Default `false`.
   */
  showSeconds?: boolean;
  /** Returned when no unit is emitted. Default `"0s"`. */
  zeroLabel?: string;
  /** Clamp negative input up to `0` before computing. Default `false`. */
  clampNegative?: boolean;
}

export function formatDurationCompact(
  ms: number,
  opts: FormatDurationOptions = {},
): string {
  const {
    separator = "",
    maxUnits = Infinity,
    showSeconds = false,
    zeroLabel = "0s",
    clampNegative = false,
  } = opts;

  if (clampNegative && ms < 0) ms = 0;

  const days = Math.floor(ms / MS_D);
  const hours = Math.floor((ms % MS_D) / MS_H);
  const mins = Math.floor((ms % MS_H) / MS_M);
  const secs = Math.floor((ms % MS_M) / MS_S);

  const ladder: Array<[number, string]> = [
    [days, "d"],
    [hours, "h"],
    [mins, "m"],
  ];

  const parts: string[] = [];
  // First non-zero unit (truthiness, matching the old `if (unit)` guards so a
  // negative, unclamped input keeps producing its old negative-unit output).
  const start = ladder.findIndex(([v]) => v !== 0);
  if (start !== -1) {
    const end = Math.min(ladder.length, start + maxUnits);
    for (let i = start; i < end; i++) {
      const [v, u] = ladder[i]!;
      if (v !== 0) parts.push(`${v}${u}`);
    }
  }

  if (showSeconds && secs !== 0 && !days && !hours) {
    parts.push(`${secs}s`);
  }

  return parts.length ? parts.join(separator) : zeroLabel;
}
