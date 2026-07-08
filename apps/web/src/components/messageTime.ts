import { fmtClockLocal } from "@thekeep/shared";
import { relTimeParts } from "../lib/relativeTime.js";

export function fmtTime(ms: number): string {
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
 * Locale-aware via `toLocaleString`, month abbreviations + 12-/24-h
 * preference follow the viewer's browser locale, so en-US sees
 * "9:21 PM" and en-GB sees "21:21". The chat-line `fmtTime` stays
 * HH:MM:SS because tight time-of-day precision is useful in an
 * active conversation where context tells you what day it is.
 */
export function fmtForumTime(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const delta = now - ms;
  const p = relTimeParts(delta, { justNowSec: 60, hourCutoffHrs: 24, roundMode: "floor" });
  if (p.tier === "justNow") return "just now";
  if (p.tier === "minutes") return `${p.value}m ago`;
  if (p.tier === "hours") return `${p.value}h ago`;
  if (delta < 7 * 86_400_000) {
    const day = d.toLocaleDateString(undefined, { weekday: "short" });
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${day} at ${time}`;
  }
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  if (sameYear) {
    const md = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${md}, ${time}`;
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Always-explicit "wall clock" timestamp for hover tooltips, so
 *  any tier of the date-aware label above can be cross-checked
 *  against an unambiguous full date/time. */
export function fmtFullTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}
