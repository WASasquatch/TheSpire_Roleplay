/**
 * Preset-based event recurrence (server_events.recurrence_json) — the pure
 * expansion math shared by the server (list expansion, reminder sweep, status
 * transitions) and the client (repeat chips, form round-trip).
 *
 * Rules are PRESETS, not RRULEs: daily / weekly (optionally on a weekday set)
 * / biweekly / monthly, ending never, on a date (`until`), or after N
 * occurrences (`count`, 1–52). All math is anchored to absolute UTC ms epochs
 * (the codebase-wide time convention): "weekly" means startsAt + k·7d, and
 * "monthly" means the same UTC day-of-month clamped to the target month's
 * length (Jan 31 → Feb 28). Local wall-clock drift across a DST change is
 * accepted v1 behavior and stated in the console UI copy.
 */
import { startOfUtcDayMs } from "./time.js";

export type EventRecurrenceFreq = "daily" | "weekly" | "biweekly" | "monthly";

export interface EventRecurrence {
  freq: EventRecurrenceFreq;
  /** Weekly only: 2+ weekdays (0 = Sunday … 6 = Saturday) the event repeats
   *  on, in the creator's LOCAL frame (see `tzOffsetMinutes`). Absent — or a
   *  single day — just repeats weekly on the start's own day (a fixed +7d
   *  step, no timezone needed). */
  byWeekday?: number[];
  /** Weekly multi-day `byWeekday` only: the creator's UTC offset in minutes at
   *  authoring time, `Date.getTimezoneOffset()` semantics (UTC = local +
   *  offset, so a zone WEST of UTC is a positive number). The weekday set +
   *  day boundaries resolve in this frame so a "Friday" event created west of
   *  UTC lands on Friday, not the viewer's Thursday. Absent = UTC (legacy
   *  rows created before the fix; unchanged behavior). */
  tzOffsetMinutes?: number;
  /** Series end: no occurrence STARTS after this ms epoch. */
  until?: number;
  /** Series end: total occurrences including the first (1–52). */
  count?: number;
}

/** One concrete occurrence of a (possibly recurring) event. */
export interface EventOccurrence {
  startsAt: number;
  /** Start + the event's fixed duration; null when the event is open-ended. */
  endsAt: number | null;
}

/** Hard ceiling on `count` (a year of weekly occurrences). */
export const MAX_RECURRENCE_COUNT = 52;
/** Most occurrences a single expansion call ever returns. */
export const OCCURRENCE_EXPANSION_CAP = 60;
/** Iteration safety valve for open-ended series queried over absurd windows. */
const MAX_ITERATIONS = 20_000;

const DAY_MS = 86_400_000;
const FREQS: readonly string[] = ["daily", "weekly", "biweekly", "monthly"];

/**
 * Parse a stored recurrence_json string into a validated rule, or null when
 * absent/garbage/out-of-preset (a malformed rule degrades the event to a
 * one-off rather than throwing into a list route or the reminder sweep).
 */
export function parseEventRecurrence(json: string | null | undefined): EventRecurrence | null {
  if (!json) return null;
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.freq !== "string" || !FREQS.includes(r.freq)) return null;
  const rule: EventRecurrence = { freq: r.freq as EventRecurrenceFreq };
  if (r.byWeekday !== undefined) {
    if (rule.freq !== "weekly" || !Array.isArray(r.byWeekday) || r.byWeekday.length === 0) return null;
    const days = [...new Set(r.byWeekday)];
    if (!days.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)) return null;
    rule.byWeekday = (days as number[]).sort((a, b) => a - b);
  }
  if (r.tzOffsetMinutes !== undefined) {
    // Only meaningful alongside a weekday set; anything past ±16h (covers
    // UTC−12…UTC+14 with margin) is garbage. A bad value degrades the whole
    // rule so we never silently expand in the wrong frame.
    if (typeof r.tzOffsetMinutes !== "number" || !Number.isInteger(r.tzOffsetMinutes) || Math.abs(r.tzOffsetMinutes) > 16 * 60) return null;
    if (rule.byWeekday) rule.tzOffsetMinutes = r.tzOffsetMinutes;
  }
  if (r.until !== undefined && r.count !== undefined) return null;
  if (r.until !== undefined) {
    if (typeof r.until !== "number" || !Number.isFinite(r.until) || r.until <= 0) return null;
    rule.until = r.until;
  }
  if (r.count !== undefined) {
    if (typeof r.count !== "number" || !Number.isInteger(r.count) || r.count < 1 || r.count > MAX_RECURRENCE_COUNT) return null;
    rule.count = r.count;
  }
  return rule;
}

/**
 * Expand an event into its concrete occurrences whose START falls inside
 * `[fromMs, toMs]`, capped at `cap` returned occurrences. A non-recurring
 * event yields itself (when in the window). `count`/`until` bound the SERIES
 * (counted from the first occurrence, window or not); `cap` bounds only this
 * call's output. Pure and side-effect free.
 */
export function expandOccurrences(
  event: { startsAt: number; endsAt?: number | null; recurrenceJson?: string | null },
  fromMs: number,
  toMs: number,
  cap: number = OCCURRENCE_EXPANSION_CAP,
): EventOccurrence[] {
  const endsAt = event.endsAt ?? null;
  const durationMs = endsAt != null && endsAt > event.startsAt ? endsAt - event.startsAt : null;
  const mk = (s: number): EventOccurrence => ({
    startsAt: s,
    endsAt: durationMs != null ? s + durationMs : null,
  });
  const rule = parseEventRecurrence(event.recurrenceJson ?? null);
  if (!rule) {
    return event.startsAt >= fromMs && event.startsAt <= toMs ? [mk(event.startsAt)] : [];
  }

  const out: EventOccurrence[] = [];
  const maxCount = rule.count ?? Number.POSITIVE_INFINITY;
  const until = rule.until ?? Number.POSITIVE_INFINITY;
  let seriesIndex = 0; // occurrences generated so far, window or not
  /** Feed one candidate start; false = the series (or this call) is done. */
  const push = (s: number): boolean => {
    if (seriesIndex >= maxCount || s > until || s > toMs) return false;
    seriesIndex++;
    if (s >= fromMs) {
      out.push(mk(s));
      if (out.length >= Math.max(1, cap)) return false;
    }
    return true;
  };

  if (rule.freq === "weekly" && rule.byWeekday && rule.byWeekday.length > 1) {
    // A weekday SET only matters when there are 2+ days (e.g. Mon/Wed/Fri); a
    // single day is just "weekly on the start's own day" and falls through to
    // the fixed +7d step below, which preserves the start's exact instant (and
    // therefore its weekday, in EVERY viewer's clock) with no timezone info at
    // all. That path is correct even for events stored before offsets existed.
    //
    // For a real multi-day set we must resolve the weekdays + day boundaries in
    // the CREATOR's local frame, not UTC — otherwise a set authored west of
    // UTC (whose start is already the next day in UTC) matches shifted UTC
    // weekdays and lands a day early. `offMs` shifts an absolute epoch into a
    // stand-in "local wall clock as UTC" frame; we walk days there and shift
    // each match back to a real epoch. Legacy rows (no stored offset) keep the
    // old UTC behavior via offMs = 0.
    const offMs = (rule.tzOffsetMinutes ?? 0) * 60_000;
    const localStart = event.startsAt - offMs;
    const timeOfDayMs = localStart - startOfUtcDayMs(localStart);
    const weekdaySet = new Set(rule.byWeekday);
    let day = startOfUtcDayMs(localStart);
    for (let i = 0; i < MAX_ITERATIONS; i++, day += DAY_MS) {
      const s = day + timeOfDayMs + offMs; // back to the real UTC epoch
      if (s < event.startsAt) continue;
      if (!weekdaySet.has(new Date(day).getUTCDay())) {
        // Non-matching days still bound the walk so an empty stretch past the
        // window can't spin to the iteration valve.
        if (s > toMs || s > until) break;
        continue;
      }
      if (!push(s)) break;
    }
    return out;
  }

  if (rule.freq === "monthly") {
    // Same UTC day-of-month clamped to each target month's length; the
    // time-of-day rides the original start.
    const base = new Date(event.startsAt);
    const y = base.getUTCFullYear();
    const mo = base.getUTCMonth();
    const dayOfMonth = base.getUTCDate();
    const timeOfDayMs = event.startsAt - Date.UTC(y, mo, dayOfMonth);
    for (let k = 0; k < MAX_ITERATIONS; k++) {
      const daysInMonth = new Date(Date.UTC(y, mo + k + 1, 0)).getUTCDate();
      const s = Date.UTC(y, mo + k, Math.min(dayOfMonth, daysInMonth)) + timeOfDayMs;
      if (!push(s)) break;
    }
    return out;
  }

  // Fixed-step series: daily / weekly (no weekday set) / biweekly.
  const stepMs = rule.freq === "daily" ? DAY_MS : rule.freq === "weekly" ? 7 * DAY_MS : 14 * DAY_MS;
  for (let k = 0; k < MAX_ITERATIONS; k++) {
    if (!push(event.startsAt + k * stepMs)) break;
  }
  return out;
}
