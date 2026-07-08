import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { startOfUtcDayMs } from "@thekeep/shared";

/**
 * Characterization test for the consolidated `startOfUtcDayMs` helper
 * (packages/shared/src/time.ts), extracted byte-identically from the arcade,
 * Scriptorium, and analytics per-UTC-day cap/rollup call sites. Pins the exact
 * value the old inline `Date.UTC(d.getUTCFullYear(), d.getUTCMonth(),
 * d.getUTCDate())` copies produced across a table of edge cases so the move
 * stays behavior-preserving.
 */
describe("startOfUtcDayMs", () => {
  // Reference implementation matching every consolidated inline copy.
  const ref = (nowMs: number): number => {
    const d = new Date(nowMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };

  const cases: Array<{ label: string; ms: number }> = [
    { label: "epoch", ms: 0 },
    { label: "exact UTC midnight", ms: Date.UTC(2026, 6, 5, 0, 0, 0, 0) },
    { label: "one ms before UTC midnight", ms: Date.UTC(2026, 6, 5, 0, 0, 0, 0) - 1 },
    { label: "one ms after UTC midnight", ms: Date.UTC(2026, 6, 5, 0, 0, 0, 0) + 1 },
    { label: "mid-day UTC", ms: Date.UTC(2026, 6, 5, 13, 47, 12, 345) },
    { label: "23:59:59.999 UTC", ms: Date.UTC(2026, 6, 5, 23, 59, 59, 999) },
    { label: "leap day", ms: Date.UTC(2024, 1, 29, 8, 0, 0, 0) },
    { label: "year boundary", ms: Date.UTC(2025, 11, 31, 23, 59, 59, 999) },
    { label: "pre-epoch", ms: Date.UTC(1969, 5, 15, 10, 0, 0, 0) },
    { label: "now", ms: Date.now() },
  ];

  for (const c of cases) {
    test(c.label, () => {
      const got = startOfUtcDayMs(c.ms);
      assert.equal(got, ref(c.ms), `value for ${c.label}`);
      // Result is itself a UTC-midnight instant (idempotent).
      assert.equal(startOfUtcDayMs(got), got, `idempotent for ${c.label}`);
      // Result lands on a whole-second (in fact whole-day) boundary.
      assert.equal(Math.abs(got % 1000), 0, `whole seconds for ${c.label}`);
    });
  }

  test("explicit known value", () => {
    // 2026-07-05T13:47:12.345Z -> 2026-07-05T00:00:00.000Z
    assert.equal(
      startOfUtcDayMs(Date.UTC(2026, 6, 5, 13, 47, 12, 345)),
      Date.UTC(2026, 6, 5),
    );
  });
});
