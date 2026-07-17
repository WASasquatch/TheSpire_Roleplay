import { fmtClockLocal } from "@thekeep/shared";
import { i18n } from "../lib/i18n.js";
import { activeTimeZone, formatDate, formatDateTime, formatTime } from "../lib/intlFormat.js";
import { relTimeParts } from "../lib/relativeTime.js";

export function fmtTime(ms: number): string {
  // Default (no chosen display timezone): the browser wall clock, byte-for-byte
  // as before. When the user has picked a timezone in Settings, render the chat
  // clock in THAT zone — still a 24-hour HH:MM:SS to match the untouched path.
  if (activeTimeZone()) {
    return formatTime(ms, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }
  return fmtClockLocal(ms);
}

/**
 * Date-aware timestamp for forum surfaces (topic cards + the post
 * timestamp on each ForumPostBody). Forum posts are persistent,
 * a "09:21:48" with no date is meaningless once the topic is more
 * than a few hours old, which is why the old `fmtTime` rendering
 * read as wrong on the forum even though it was fine for live chat.
 *
 * Tier ladder, picked for "fits in a chip-sized footprint, reads
 * like a human wrote it":
 *   - < 60s:        "just now"
 *   - < 60m:        "12m ago"
 *   - < 24h:        "5h ago"
 *   - < 7d:         "Mon at 9:21 PM"   (weekday + locale time)
 *   - same year:    "Jun 4, 9:21 PM"
 *   - older:        "Jun 4, 2025"      (year on its own, older posts
 *                                       care about the year, not the
 *                                       minute)
 *
 * Locale-aware via the intlFormat helpers, which key on the active
 * i18next language and pass the browser default through while English
 * is active — month abbreviations + 12-/24-h preference stay exactly
 * what the viewer's browser produced before i18n existed, so en-US
 * sees "9:21 PM" and en-GB sees "21:21". The chat-line `fmtTime` stays
 * HH:MM:SS because tight time-of-day precision is useful in an
 * active conversation where context tells you what day it is.
 */
export function fmtForumTime(ms: number): string {
  const now = Date.now();
  const delta = now - ms;
  const p = relTimeParts(delta, { justNowSec: 60, hourCutoffHrs: 24, roundMode: "floor" });
  if (p.tier === "justNow") return i18n.t("common:relTime.justNow");
  if (p.tier === "minutes") return i18n.t("common:relTime.minutesAgo", { value: p.value });
  if (p.tier === "hours") return i18n.t("common:relTime.hoursAgo", { value: p.value });
  if (delta < 7 * 86_400_000) {
    const day = formatDate(ms, { weekday: "short" });
    const time = formatTime(ms, { hour: "numeric", minute: "2-digit" });
    return i18n.t("common:relTime.dayAtTime", { day, time });
  }
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  if (sameYear) {
    const md = formatDate(ms, { month: "short", day: "numeric" });
    const time = formatTime(ms, { hour: "numeric", minute: "2-digit" });
    return `${md}, ${time}`;
  }
  return formatDate(ms, { month: "short", day: "numeric", year: "numeric" });
}

/** Always-explicit "wall clock" timestamp for hover tooltips, so
 *  any tier of the date-aware label above can be cross-checked
 *  against an unambiguous full date/time. */
export function fmtFullTimestamp(ms: number): string {
  return formatDateTime(ms);
}
