import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatDurationCompact } from "@thekeep/shared";

/**
 * Characterization test for the consolidated `formatDurationCompact` helper
 * (packages/shared/src/duration.ts). It replaced four divergent "ms -> compact
 * label" copies; this pins that each caller's option bundle reproduces its old
 * copy byte-for-byte across the full divergence matrix
 * ({separator, maxUnits, showSeconds, zeroLabel, clampNegative}).
 *
 * The four originals are reimplemented below verbatim as reference oracles, and
 * a shared table of edge-case inputs is fed through both the oracle and the
 * consolidated helper with that caller's options.
 */

const D = 86_400_000;
const H = 3_600_000;
const M = 60_000;
const S = 1_000;

// --- Verbatim originals (the four copies that were consolidated) -------------

// apps/server/src/commands/duration.ts (no separator, shows seconds).
function origCommandsFormatDuration(ms: number): string {
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

// packages/shared/src/export.ts formatDurationShort (space-joined, no guard).
function origExportFormatDurationShort(ms: number): string {
  const MS = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const;
  const d = Math.floor(ms / MS.d);
  const h = Math.floor((ms % MS.d) / MS.h);
  const m = Math.floor((ms % MS.h) / MS.m);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.length ? parts.join(" ") : "0m";
}

// packages/shared/src/announcement.ts formatDurationMs (no separator).
function origAnnouncementFormatDurationMs(ms: number): string {
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

// apps/web/src/components/AdminEarningTab.tsx local formatDurationShort
// (space-joined, top-two ladder, minutes drop once days present).
function origAdminEarningFormatDurationShort(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  if (hours < 24) {
    const mins = totalMin % 60;
    return mins ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

// --- Consolidated wrappers (exactly as wired at each call site) --------------

const wrapCommands = (ms: number) =>
  formatDurationCompact(ms, { showSeconds: true, zeroLabel: "0s", clampNegative: true });
const wrapExport = (ms: number) =>
  formatDurationCompact(ms, { separator: " ", zeroLabel: "0m" });
const wrapAnnouncement = (ms: number) =>
  formatDurationCompact(ms, { zeroLabel: "0m", clampNegative: true });
const wrapAdminEarning = (ms: number) =>
  formatDurationCompact(ms, { separator: " ", maxUnits: 2, zeroLabel: "0m", clampNegative: true });

// Shared table of edge cases exercising every ladder branch + boundaries.
const CASES: Array<{ label: string; ms: number }> = [
  { label: "zero", ms: 0 },
  { label: "sub-second", ms: 500 },
  { label: "exactly 1s", ms: S },
  { label: "30s", ms: 30 * S },
  { label: "59s", ms: 59 * S },
  { label: "1m exactly", ms: M },
  { label: "1m30s", ms: M + 30 * S },
  { label: "30m", ms: 30 * M },
  { label: "59m59s", ms: 59 * M + 59 * S },
  { label: "1h exactly", ms: H },
  { label: "1h30s (h present, drops s)", ms: H + 30 * S },
  { label: "1h30m", ms: H + 30 * M },
  { label: "1h0m0s", ms: H },
  { label: "23h59m", ms: 23 * H + 59 * M },
  { label: "24h exactly (1d)", ms: D },
  { label: "1d0h30m (mid zero unit)", ms: D + 30 * M },
  { label: "1d0h30m45s", ms: D + 30 * M + 45 * S },
  { label: "1d1h", ms: D + H },
  { label: "1d1h1m", ms: D + H + M },
  { label: "25h30m", ms: 25 * H + 30 * M },
  { label: "2d3h", ms: 2 * D + 3 * H },
  { label: "10d5h37m12s", ms: 10 * D + 5 * H + 37 * M + 12 * S },
  { label: "365d", ms: 365 * D },
  { label: "negative small", ms: -1000 },
  { label: "negative large", ms: -(2 * D + 3 * H) },
];

describe("formatDurationCompact — commands/duration parity (showSeconds)", () => {
  for (const c of CASES) {
    test(c.label, () => {
      assert.equal(wrapCommands(c.ms), origCommandsFormatDuration(c.ms));
    });
  }
});

describe("formatDurationCompact — export.ts parity (space-joined, no guard)", () => {
  for (const c of CASES) {
    // export.ts has no negative guard; skip only would hide the parity claim,
    // so assert equality including the negative-input garbage both produce.
    test(c.label, () => {
      assert.equal(wrapExport(c.ms), origExportFormatDurationShort(c.ms));
    });
  }
});

describe("formatDurationCompact — announcement.ts parity (no separator)", () => {
  for (const c of CASES) {
    test(c.label, () => {
      assert.equal(wrapAnnouncement(c.ms), origAnnouncementFormatDurationMs(c.ms));
    });
  }
});

describe("formatDurationCompact — AdminEarningTab parity (maxUnits 2 ladder)", () => {
  for (const c of CASES) {
    test(c.label, () => {
      assert.equal(wrapAdminEarning(c.ms), origAdminEarningFormatDurationShort(c.ms));
    });
  }
});

describe("formatDurationCompact — explicit divergence anchors", () => {
  test("seconds only render with no d/h (commands copy)", () => {
    assert.equal(wrapCommands(H + 30 * S), "1h"); // seconds dropped
    assert.equal(wrapCommands(90 * S), "1m30s"); // seconds kept under an hour
  });
  test("export shows every non-zero unit; AdminEarning caps at two", () => {
    assert.equal(wrapExport(D + 30 * M), "1d 30m"); // keeps minutes across zero hour
    assert.equal(wrapAdminEarning(D + 30 * M), "1d"); // minutes dropped once days appear
    assert.equal(wrapExport(D + H + M), "1d 1h 1m");
    assert.equal(wrapAdminEarning(D + H + M), "1d 1h");
  });
  test("zero labels differ per caller", () => {
    assert.equal(wrapCommands(0), "0s");
    assert.equal(wrapExport(0), "0m");
    assert.equal(wrapAnnouncement(0), "0m");
    assert.equal(wrapAdminEarning(0), "0m");
  });
  test("separators differ per caller", () => {
    assert.equal(wrapAnnouncement(D + H), "1d1h"); // no separator
    assert.equal(wrapExport(D + H), "1d 1h"); // space
  });
});
