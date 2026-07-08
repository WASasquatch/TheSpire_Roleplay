/**
 * Parse a friendly duration string ("30d", "5m", "1h30m", or bare digits as
 * milliseconds) into a number of milliseconds, or `null` when the input is not
 * a valid duration.
 *
 * Shared by the site-admin and per-server settings forms. Those two forms
 * disagree on how a blank field is treated: the site-admin form persists an
 * empty box as `0`, while the per-server form treats blank as "inherit" and
 * wants `null`. That single difference is expressed via `emptyValue`; every
 * other input produces byte-identical output to the previous inline copies.
 */
export function parseDurationMs(s: string, emptyValue: 0 | null = null): number | null {
  const trimmed = s.trim();
  if (trimmed === "") return emptyValue;
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  let total = 0;
  let any = false;
  const re = /(\d+)\s*([smhd])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    any = true;
    const n = parseInt(m[1] ?? "0", 10);
    const unit = (m[2] ?? "").toLowerCase();
    const ms = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
    total += n * ms;
  }
  return any ? total : null;
}
