/**
 * Zero-padded wall-clock timestamp assemblers.
 *
 * Three surfaces render a padded `HH:MM:SS` / `YYYY-MM-DD HH:MM:SS` clock,
 * but they differ in whether a date is shown and whether the fields are read
 * as local or UTC. The only truly common fragment is the two-digit pad, so
 * this module exposes `pad2` plus the exact assemblers each surface needs.
 * Callers keep their own guards (e.g. the "-" non-finite fallback) so output
 * stays byte-identical.
 */

/** Two-digit zero-padded number, e.g. 3 → "03". */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local wall clock, `HH:MM:SS` (no date). */
export function fmtClockLocal(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Local date + wall clock, `YYYY-MM-DD HH:MM:SS`. */
export function fmtDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/**
 * UTC date + wall clock, `YYYY-MM-DD HH:MM:SS`, read from the UTC fields.
 * Pass a tz-shifted epoch (`ms + tzMinutes * 60_000`) to render an arbitrary
 * offset's wall clock.
 */
export function fmtDateTimeUtc(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}
