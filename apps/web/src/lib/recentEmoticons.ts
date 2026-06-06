/**
 * Recent-emoticons cache for the picker's "Recent" section.
 *
 * Mirrors how Slack / Discord surface a "frequently used" row at the
 * top of the emoji picker, the user's last N picks, sorted by
 * frequency (most-used first), capped at MAX_RECENT entries.
 *
 * Persistence: localStorage. The cache is a purely client-side
 * convenience; a fresh tab / device just starts empty and re-fills
 * with use. We deliberately avoid round-tripping this through the
 * server, every emoticon pick would otherwise be a write to a
 * personal preference store, which the existing settings surface
 * isn't shaped for.
 */
import type { EmoticonKey } from "@thekeep/shared";
import { emoticonKey, parseEmoticonKey } from "@thekeep/shared";

const STORAGE_KEY = "scriptorium.recentEmoticons.v1";
/** Cap on stored history. Picker surfaces a subset of this (`MAX_VISIBLE`). */
const MAX_HISTORY = 64;
/** Picker shows at most this many recent entries, keeps the "Recent"
 *  row to one line at typical picker widths. */
export const MAX_VISIBLE_RECENT = 12;

interface RecentEntry {
  key: EmoticonKey;
  count: number;
  /** Epoch ms of last use, tie-breaks the frequency sort so newer
   *  picks edge out older ones at the same count. */
  lastAt: number;
}

function load(): RecentEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is RecentEntry => (
        e && typeof e.key === "string"
        && typeof e.count === "number"
        && typeof e.lastAt === "number"
        && parseEmoticonKey(e.key) !== null
      ))
      .slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

function save(entries: RecentEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY)));
  } catch {
    /* quota / private-browsing, swallow */
  }
}

/**
 * Record a pick. Increments the entry's `count` (or inserts at 1)
 * and stamps `lastAt = now`. Returns the new ordered list so callers
 * (e.g. zustand) can update state without re-reading.
 */
export function recordEmoticonPick(sheetSlug: string, cellIndex: number): RecentEntry[] {
  const key = emoticonKey(sheetSlug, cellIndex);
  const now = Date.now();
  const current = load();
  const idx = current.findIndex((e) => e.key === key);
  let next: RecentEntry[];
  if (idx >= 0) {
    const updated: RecentEntry = { ...current[idx]!, count: current[idx]!.count + 1, lastAt: now };
    next = [...current];
    next[idx] = updated;
  } else {
    next = [...current, { key, count: 1, lastAt: now }];
  }
  next.sort(byFrequency);
  save(next);
  return next;
}

/** Read the current sorted recents. */
export function readRecentEmoticons(): RecentEntry[] {
  const list = load();
  list.sort(byFrequency);
  return list;
}

function byFrequency(a: RecentEntry, b: RecentEntry): number {
  if (a.count !== b.count) return b.count - a.count;
  return b.lastAt - a.lastAt;
}

/** Expand recents into { sheetSlug, cellIndex } pairs for rendering. */
export function recentPicks(): Array<{ sheetSlug: string; cellIndex: number }> {
  const out: Array<{ sheetSlug: string; cellIndex: number }> = [];
  for (const e of readRecentEmoticons()) {
    const parsed = parseEmoticonKey(e.key);
    if (parsed) out.push({ sheetSlug: parsed.sheetSlug, cellIndex: parsed.cellIndex });
    if (out.length >= MAX_VISIBLE_RECENT) break;
  }
  return out;
}
