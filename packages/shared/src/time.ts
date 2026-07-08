/**
 * Start of the UTC day (00:00:00.000 UTC) containing `nowMs`, in ms since epoch.
 *
 * The canonical window-start for per-UTC-day cap scans and rollups. Equivalent
 * to `Date.UTC(y, mo, d)` for the UTC calendar date of `nowMs`.
 */
export function startOfUtcDayMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
