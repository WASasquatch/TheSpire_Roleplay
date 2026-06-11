/**
 * Chat-export helpers, shared by the `/export` command (which parses the
 * user's duration + builds the download hint) and the `GET /rooms/:id/export`
 * route (which re-derives the window defensively from the same rules). Keeping
 * the parse + clamp logic here means the command's friendly "clamped to X"
 * notice and the route's actual query window can never disagree.
 *
 * An export is a download of the room's recent messages as a formatted HTML
 * log. The requested window is always clamped to (a) how long messages are
 * actually retained — you can't export what's already been swept — and (b) a
 * hard ceiling so a single request can't try to serialize an unbounded history.
 */

/** Hard ceiling on the export window regardless of retention (30 days). Keeps
 *  any one request bounded even when retention is "infinite" (global 0). */
export const MAX_EXPORT_MS = 30 * 24 * 60 * 60 * 1000;

/** Window used when `/export` is run with no duration argument (12 hours). */
export const DEFAULT_EXPORT_MS = 12 * 60 * 60 * 1000;

/** Upper bound on rows serialized into one export. The route takes the most
 *  recent N within the window; anything older is dropped (and flagged in the
 *  document header) so the query + string build stay cheap and non-blocking. */
export const EXPORT_MAX_MESSAGES = 5000;

const MS = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const;

/**
 * Parse a human duration like `5h`, `90m`, `2d`, `1d6h`, or a bare number
 * (treated as hours). Returns milliseconds, or null if nothing usable parsed
 * or the total is zero. Case/whitespace insensitive; combined units sum.
 */
export function parseExportDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  // Bare number → hours (e.g. `/export 5` == `/export 5h`).
  if (/^\d+$/.test(s)) {
    const h = parseInt(s, 10);
    return h > 0 ? h * MS.h : null;
  }
  // One-or-more <number><unit> chunks. Longest unit spellings first so e.g.
  // "min" matches as minutes rather than "m" + leftover "in".
  const re = /(\d+)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m)/g;
  let total = 0;
  let matched = false;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(s)) !== null) {
    matched = true;
    const n = parseInt(mm[1]!, 10);
    const unit = mm[2]![0]; // d | h | m
    total += n * (unit === "d" ? MS.d : unit === "h" ? MS.h : MS.m);
  }
  return matched && total > 0 ? total : null;
}

/**
 * Effective retention window for a room in ms: the per-room expiry override if
 * set, else the global retention, else `Infinity` (kept indefinitely). The
 * per-room override wins because the sweep applies it regardless of the global
 * value.
 */
export function effectiveRetentionMs(
  globalRetentionMs: number,
  roomExpiryMinutes: number | null | undefined,
): number {
  if (roomExpiryMinutes != null && roomExpiryMinutes > 0) return roomExpiryMinutes * MS.m;
  if (globalRetentionMs > 0) return globalRetentionMs;
  return Infinity;
}

/**
 * Clamp a requested export window to what's actually exportable: never longer
 * than retention (you can't export swept messages) and never past the hard
 * {@link MAX_EXPORT_MS} ceiling. Always returns a positive, finite ms value.
 */
export function clampExportMs(
  requestedMs: number,
  globalRetentionMs: number,
  roomExpiryMinutes: number | null | undefined,
): number {
  const retention = effectiveRetentionMs(globalRetentionMs, roomExpiryMinutes);
  return Math.max(MS.m, Math.min(requestedMs, retention, MAX_EXPORT_MS));
}

/** Compact human label for a ms window, e.g. `2d 3h`, `5h`, `45m`. Used in the
 *  clamp notice and the export document header. */
export function formatDurationShort(ms: number): string {
  const d = Math.floor(ms / MS.d);
  const h = Math.floor((ms % MS.d) / MS.h);
  const m = Math.floor((ms % MS.h) / MS.m);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.length ? parts.join(" ") : "0m";
}
