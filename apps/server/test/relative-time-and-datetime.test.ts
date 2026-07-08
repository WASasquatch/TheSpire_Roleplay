import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { pad2, fmtClockLocal, fmtDateTimeLocal, fmtDateTimeUtc } from "@thekeep/shared";
import { relTimeParts } from "../../web/src/lib/relativeTime.js";

/**
 * Characterization test for the D1/D2 time-helper consolidation.
 *
 * D1: `relTimeParts` (apps/web/src/lib/relativeTime.ts) is the config-driven
 *     core that replaced four divergent "time ago" ladders (forums.relTime,
 *     NotificationCenter.ago, MessageList.fmtForumTime, PollCard.timeLeft).
 * D2: `pad2` + the wall-clock assemblers (packages/shared/src/datetime.ts)
 *     that replaced three padded-timestamp copies (MessageList.fmtTime,
 *     AdminVerifyLogTab.fmtTime, chatLog.fmtTimestamp).
 *
 * Each original is reimplemented verbatim below as a reference oracle, and a
 * shared table of boundary inputs is fed through both the oracle and the
 * consolidated helper wired with that caller's exact options + wording. The
 * rendered output must be byte-identical.
 */

// ---- D1 oracles: the four originals, verbatim (delta-parameterized) ----

// forums.ts:66 — 90s just-now, 48h cutoff, " ago" suffix, floor.
function oracleForums(delta: number): string {
  if (delta < 90_000) return "just now";
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// NotificationCenter.tsx:94 — 60s "now", clamp negative, adds weeks, no suffix.
function oracleNotif(delta: number): string {
  const s = Math.max(0, Math.floor(delta / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

// MessageList.tsx:374 — ladder head only (date fallthrough is locale-dependent);
// return "DATE" sentinel once the shared core would hand off to the calendar tier.
function oracleForumTimeHead(delta: number): string {
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return "DATE";
}

// PollCard.tsx:69 — future-facing, Math.round, "closes in" prefix, "closing…" at <=0.
function oraclePoll(ms: number): string {
  if (ms <= 0) return "closing…";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `closes in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `closes in ${hrs}h`;
  return `closes in ${Math.round(hrs / 24)}d`;
}

// ---- D1 consolidated wrappers: relTimeParts + each caller's wording ----

function newForums(delta: number): string {
  const p = relTimeParts(delta, { justNowSec: 90, hourCutoffHrs: 48, roundMode: "floor" });
  switch (p.tier) {
    case "justNow": return "just now";
    case "minutes": return `${p.value}m ago`;
    case "hours": return `${p.value}h ago`;
    default: return `${p.value}d ago`;
  }
}

function newNotif(delta: number): string {
  const p = relTimeParts(delta, {
    justNowSec: 60, hourCutoffHrs: 24, roundMode: "floor",
    clampNegative: true, addWeeks: true,
  });
  switch (p.tier) {
    case "justNow": return "now";
    case "minutes": return `${p.value}m`;
    case "hours": return `${p.value}h`;
    case "days": return `${p.value}d`;
    default: return `${p.value}w`;
  }
}

function newForumTimeHead(delta: number): string {
  const p = relTimeParts(delta, { justNowSec: 60, hourCutoffHrs: 24, roundMode: "floor" });
  if (p.tier === "justNow") return "just now";
  if (p.tier === "minutes") return `${p.value}m ago`;
  if (p.tier === "hours") return `${p.value}h ago`;
  return "DATE";
}

function newPoll(ms: number): string {
  if (ms <= 0) return "closing…";
  const p = relTimeParts(ms, { justNowSec: 0, hourCutoffHrs: 48, roundMode: "round" });
  switch (p.tier) {
    case "minutes": return `closes in ${p.value}m`;
    case "hours": return `closes in ${p.value}h`;
    default: return `closes in ${p.value}d`;
  }
}

const SEC = 1_000, MIN = 60_000, HR = 3_600_000, DAY = 86_400_000;

// Boundary-dense sweep: negatives, zero, and every tier edge ±1ms.
const DELTAS: number[] = [
  -DAY, -HR, -MIN, -SEC, -1, 0, 1, SEC, 30 * SEC,
  59 * SEC, 59_999, 60 * SEC, 89 * SEC, 89_999, 90 * SEC, 90_001,
  MIN, 90 * SEC, 30 * MIN, 59 * MIN, 59 * MIN + 59 * SEC, 60 * MIN - 1, 60 * MIN,
  90 * MIN, HR, 23 * HR, 24 * HR - 1, 24 * HR, 25 * HR,
  47 * HR, 48 * HR - 1, 48 * HR, 49 * HR,
  6 * DAY, 7 * DAY - 1, 7 * DAY, 8 * DAY, 13 * DAY, 14 * DAY, 30 * DAY, 400 * DAY,
];

describe("relTimeParts — D1 ladder consolidation", () => {
  test("forums.relTime config is byte-identical", () => {
    for (const d of DELTAS) assert.equal(newForums(d), oracleForums(d), `delta=${d}`);
  });
  test("NotificationCenter.ago config is byte-identical (weeks + clamp)", () => {
    for (const d of DELTAS) assert.equal(newNotif(d), oracleNotif(d), `delta=${d}`);
  });
  test("MessageList.fmtForumTime ladder head + date handoff is byte-identical", () => {
    for (const d of DELTAS) assert.equal(newForumTimeHead(d), oracleForumTimeHead(d), `delta=${d}`);
  });
  test("PollCard.timeLeft config is byte-identical (future, round, prefix)", () => {
    // Poll takes a future remaining-ms; sweep the same magnitudes as positives.
    for (const d of DELTAS) assert.equal(newPoll(d), oraclePoll(d), `ms=${d}`);
  });
});

// ---- D2 oracles: the three padded-timestamp originals, verbatim ----

function oracleFmtTimeLocal(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function oracleFmtDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function oracleFmtTimestampUtc(ms: number, tzMinutes: number): string {
  const d = new Date(ms + tzMinutes * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

const STAMPS = [
  0, 1, 999, 1_000, 61_000, 3_661_000,
  Date.UTC(2025, 0, 1, 0, 0, 0), Date.UTC(2025, 5, 4, 9, 21, 48),
  Date.UTC(2026, 11, 31, 23, 59, 59), 1_700_000_000_000, 1_751_000_000_000,
];
const TZ_OFFSETS = [-720, -480, -300, 0, 60, 330, 540, 720];

describe("datetime — D2 wall-clock consolidation", () => {
  test("pad2 matches String(n).padStart(2,'0')", () => {
    for (let n = 0; n < 130; n++) assert.equal(pad2(n), String(n).padStart(2, "0"), `n=${n}`);
  });
  test("fmtClockLocal == MessageList.fmtTime", () => {
    for (const ms of STAMPS) assert.equal(fmtClockLocal(ms), oracleFmtTimeLocal(ms), `ms=${ms}`);
  });
  test("fmtDateTimeLocal == AdminVerifyLogTab.fmtTime body", () => {
    for (const ms of STAMPS) assert.equal(fmtDateTimeLocal(ms), oracleFmtDateTimeLocal(ms), `ms=${ms}`);
  });
  test("fmtDateTimeUtc(shifted) == chatLog.fmtTimestamp", () => {
    for (const ms of STAMPS) {
      for (const tz of TZ_OFFSETS) {
        assert.equal(fmtDateTimeUtc(ms + tz * 60_000), oracleFmtTimestampUtc(ms, tz), `ms=${ms} tz=${tz}`);
      }
    }
  });
});
