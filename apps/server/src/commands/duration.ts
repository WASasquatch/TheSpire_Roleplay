/**
 * Parse a duration string like "5m", "1h20m", "30d", "2h30m15s" into
 * milliseconds. Returns null on bad input.
 *
 * Accepted units: s/m/h/d (seconds/minutes/hours/days). Components are
 * additive — "1h20m" is 80 minutes; order doesn't matter ("20m1h" is the
 * same). Whitespace is allowed between components.
 *
 * Capped at 365 days to refuse pathological values like "9999d".
 */
const RX = /(\d+)\s*([smhd])/gi;
const MAX_MS = 365 * 24 * 60 * 60 * 1000;

export function parseDuration(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  // Disallow stray characters: every character must be a digit, a unit,
  // or whitespace. Otherwise bail (e.g. "5moose" is rejected).
  if (!/^[\d\s smhdSMHD]+$/i.test(trimmed)) return null;
  // The only legal characters are also matched per chunk by RX, so a string
  // that survives the lookbehind but produces zero matches is malformed.
  let total = 0;
  let any = false;
  RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RX.exec(trimmed)) !== null) {
    any = true;
    const n = parseInt(m[1] ?? "0", 10);
    if (!Number.isFinite(n) || n < 0) return null;
    const unit = (m[2] ?? "").toLowerCase();
    const ms = unit === "d" ? 86_400_000
             : unit === "h" ? 3_600_000
             : unit === "m" ? 60_000
             : unit === "s" ? 1_000
             : 0;
    if (ms === 0) return null;
    total += n * ms;
    if (total > MAX_MS) return null;
  }
  if (!any || total === 0) return null;
  return total;
}

/** Format a millisecond duration back into "1h20m" form for display. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1_000);
  let out = "";
  if (days) out += `${days}d`;
  if (hours) out += `${hours}h`;
  if (mins) out += `${mins}m`;
  if (secs && !days && !hours) out += `${secs}s`;
  return out || "0s";
}
