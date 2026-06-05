/**
 * Announcement feature shared types + the schedule-spec parser.
 *
 * Two surfaces share the admin tab:
 *   - **Banner marquee** — rows the chat shell rotates through above
 *     the timeline. Body is sanitized HTML; the editor accepts
 *     Markdown and converts client-side at save time so the read
 *     path stays one shape.
 *   - **Scheduled announcements** — cron-like rows that fire as
 *     `/announce` lines on a tick. Spec is human-readable
 *     ("1d8h", "30m", an ISO datetime); the parser below turns
 *     that into either a recurring `intervalMs` or a one-shot
 *     `runAt` so the scheduler only has to deal with two shapes.
 */

/**
 * Wire row for a single rotating banner. The shell fetches the
 * enabled set on mount + on the `announcements:banners-changed`
 * socket push.
 */
export interface AnnouncementBanner {
  id: string;
  /** Sanitized HTML — render with `dangerouslySetInnerHTML` after
   *  passing through the project's user-HTML sanitizer. */
  bodyHtml: string;
  enabled: boolean;
  /** Lower = earlier in the rotation. Ties broken by `createdAt`. */
  sortOrder: number;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Wire row for a single scheduled `/announce`. The scheduler reads
 * `nextRunAt` to decide what to fire on the current tick.
 */
export interface ScheduledAnnouncement {
  id: string;
  scheduleSpec: string;
  kind: "interval" | "oneShot";
  /** Recurring rows only. ms between fires. */
  intervalMs: number | null;
  /** One-shot rows only. Epoch ms when the row fires. */
  runAt: number | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  bodyHtml: string;
  bodyMarkdown: string;
  /** `#rrggbb` literal, `theme:<slot>` token, or null. */
  color: string | null;
  /** null = sitewide (every room), otherwise the room id. */
  targetRoomId: string | null;
  enabled: boolean;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

/* ============================================================
 *  Schedule-spec parser
 * ============================================================
 *
 * Accepts two shapes:
 *
 *   1. A combination interval string like `1d8h`, `3h`, `30m`, `1d`,
 *      `2d4h30m`. Units: `d` days, `h` hours, `m` minutes. Each unit
 *      appears at most once and in decreasing-magnitude order; the
 *      parser is intentionally strict so a typo doesn't silently
 *      become a different interval.
 *
 *   2. An ISO datetime string (`YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM]`) for
 *      one-shot scheduling. We accept anything `new Date()` can
 *      parse but require the result to be finite + in the future at
 *      save time (server re-checks at fire time).
 *
 * Returned shape mirrors the DB row's `kind` discriminator so the
 * caller can write straight through.
 */

export const SCHEDULE_INTERVAL_MIN_MS = 60_000;      // 1 minute floor
export const SCHEDULE_INTERVAL_MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 days ceiling

export type ParsedSchedule =
  | { kind: "interval"; intervalMs: number }
  | { kind: "oneShot"; runAt: number };

export interface ScheduleParseFailure {
  ok: false;
  message: string;
}
export interface ScheduleParseSuccess {
  ok: true;
  parsed: ParsedSchedule;
}
export type ScheduleParseResult = ScheduleParseSuccess | ScheduleParseFailure;

/**
 * Pure parser — no DB / clock side effects beyond `Date.now()` for
 * the one-shot future-check (the server re-validates against its own
 * clock on save). Returns a discriminated result so the caller can
 * surface the failure message verbatim in a NOTICE without throwing.
 */
export function parseScheduleSpec(rawInput: string): ScheduleParseResult {
  const raw = rawInput.trim();
  if (raw === "") return { ok: false, message: "Schedule cannot be empty." };

  // Interval shape first — cheap regex check. The expression demands
  // at least one (\d+)(d|h|m) chunk, and the optional `s` is rejected
  // on purpose (sub-minute scheduling would bury the chat in
  // announcements faster than anyone could read them).
  const intervalShape = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/i;
  const m = intervalShape.exec(raw);
  if (m && (m[1] || m[2] || m[3])) {
    const days = m[1] ? parseInt(m[1], 10) : 0;
    const hours = m[2] ? parseInt(m[2], 10) : 0;
    const minutes = m[3] ? parseInt(m[3], 10) : 0;
    const totalMs =
      days * 24 * 60 * 60 * 1000
      + hours * 60 * 60 * 1000
      + minutes * 60 * 1000;
    if (totalMs < SCHEDULE_INTERVAL_MIN_MS) {
      return { ok: false, message: "Interval must be at least 1 minute." };
    }
    if (totalMs > SCHEDULE_INTERVAL_MAX_MS) {
      return { ok: false, message: "Interval must be at most 30 days." };
    }
    return { ok: true, parsed: { kind: "interval", intervalMs: totalMs } };
  }

  // Fall through to one-shot: anything Date can parse as a fixed
  // moment in the future.
  const parsed = new Date(raw);
  const at = parsed.getTime();
  if (!Number.isFinite(at)) {
    return {
      ok: false,
      message:
        "Schedule must be an interval (e.g. `1d8h`, `3h`, `30m`) or an ISO datetime (e.g. `2026-06-04T18:00`).",
    };
  }
  if (at <= Date.now()) {
    return { ok: false, message: "One-shot schedules must be in the future." };
  }
  return { ok: true, parsed: { kind: "oneShot", runAt: at } };
}

/**
 * Render a parsed schedule + last/next bookkeeping as a single
 * sentence for admin-list display. Pure formatter, no side effects.
 * Returns "" when there's nothing meaningful to say (disabled row
 * with no nextRunAt).
 */
export function describeSchedule(
  row: Pick<ScheduledAnnouncement, "kind" | "intervalMs" | "runAt" | "nextRunAt" | "enabled">,
): string {
  if (!row.enabled) return "Disabled";
  if (row.kind === "oneShot") {
    if (!row.runAt || row.runAt <= Date.now()) return "Already fired";
    return `Once at ${new Date(row.runAt).toLocaleString()}`;
  }
  const interval = row.intervalMs ?? 0;
  const next = row.nextRunAt ? new Date(row.nextRunAt).toLocaleString() : "—";
  return `Every ${formatDurationMs(interval)} (next: ${next})`;
}

function formatDurationMs(ms: number): string {
  if (ms <= 0) return "0m";
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  return parts.join("") || "0m";
}

/**
 * Caps applied at the schema layer + the admin form. Bodies above
 * these counts get rejected at save time; the editor surfaces a
 * remaining-chars counter so admins notice before the round-trip.
 *
 * `ANNOUNCEMENT_BANNER_BODY_MAX` is sized to the single-line marquee
 * strip: `max-w-5xl` (1024px) at `text-sm` fits ~145 chars before
 * truncation; the cap leaves a ~35-char (≈6 word) tolerance for
 * markdown / chip-token expansion that adds visible chars without
 * adding source chars, plus a touch of slack for shorter bodies that
 * end mid-word. A 4000-char cap (the previous value, lifted from
 * scheduled announces) lied to admins about how much would render —
 * the editor counted up to 4000 but the bar truncated past line one.
 *
 * `SCHEDULED_ANNOUNCEMENT_BODY_MAX` stays generous because scheduled
 * announces land as `kind: "announce"` chat lines (wrapping is
 * fine — no single-strip truncation in the chat renderer).
 */
export const ANNOUNCEMENT_BANNER_BODY_MAX = 180;
export const SCHEDULED_ANNOUNCEMENT_BODY_MAX = 4000;
