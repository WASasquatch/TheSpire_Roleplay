import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  OCCURRENCE_EXPANSION_CAP,
  buildMessageLinkToken,
  buildMessageLinkUrl,
  expandOccurrences,
  parseEventRecurrence,
  parseMessageLink,
} from "@thekeep/shared";

/**
 * Property suite for the pure shared recurrence expander (event upgrades,
 * migration 0358): preset semantics (daily / weekly+byWeekday / biweekly /
 * monthly with the day-of-month clamp), series bounds (until vs count), the
 * expansion cap, window filtering, and the degrade-to-one-off posture for
 * malformed rules — plus the message-link token/URL round-trip that rides
 * the same shared module.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
// Wed 2030-01-02 18:00 UTC — a fixed, DST-free anchor.
const T0 = Date.UTC(2030, 0, 2, 18, 0, 0);

function rule(json: object): string {
  return JSON.stringify(json);
}

/** Structural invariants every expansion must satisfy. */
function assertWellFormed(
  occs: { startsAt: number; endsAt: number | null }[],
  from: number,
  to: number,
  cap = OCCURRENCE_EXPANSION_CAP,
) {
  assert.ok(occs.length <= cap, "expansion respects the cap");
  for (let i = 0; i < occs.length; i++) {
    const o = occs[i]!;
    assert.ok(o.startsAt >= from && o.startsAt <= to, "every start inside the window");
    if (i > 0) assert.ok(o.startsAt > occs[i - 1]!.startsAt, "strictly ascending");
  }
}

describe("expandOccurrences", () => {
  test("non-recurring: yields itself inside the window, nothing outside", () => {
    const ev = { startsAt: T0, endsAt: T0 + HOUR, recurrenceJson: null };
    assert.deepEqual(expandOccurrences(ev, T0 - DAY, T0 + DAY), [{ startsAt: T0, endsAt: T0 + HOUR }]);
    assert.deepEqual(expandOccurrences(ev, T0 + 1, T0 + DAY), []);
    assert.deepEqual(expandOccurrences(ev, T0 - DAY, T0 - 1), []);
  });

  test("daily with count: exactly N occurrences, one day apart, duration rides", () => {
    const ev = { startsAt: T0, endsAt: T0 + 2 * HOUR, recurrenceJson: rule({ freq: "daily", count: 5 }) };
    const occs = expandOccurrences(ev, T0 - DAY, T0 + 365 * DAY);
    assert.equal(occs.length, 5);
    assertWellFormed(occs, T0 - DAY, T0 + 365 * DAY);
    for (let i = 0; i < occs.length; i++) {
      assert.equal(occs[i]!.startsAt, T0 + i * DAY);
      assert.equal(occs[i]!.endsAt, T0 + i * DAY + 2 * HOUR);
    }
  });

  test("daily with until: no occurrence starts after the bound (inclusive)", () => {
    const until = T0 + 3 * DAY;
    const ev = { startsAt: T0, endsAt: null, recurrenceJson: rule({ freq: "daily", until }) };
    const occs = expandOccurrences(ev, T0, T0 + 30 * DAY);
    assert.equal(occs.length, 4); // T0, +1d, +2d, +3d
    assert.equal(occs[occs.length - 1]!.startsAt, until);
    assert.ok(occs.every((o) => o.endsAt === null), "open-ended events stay open-ended");
  });

  test("weekly / biweekly: fixed 7- and 14-day steps", () => {
    for (const [freq, step] of [["weekly", 7 * DAY], ["biweekly", 14 * DAY]] as const) {
      const ev = { startsAt: T0, endsAt: null, recurrenceJson: rule({ freq, count: 4 }) };
      const occs = expandOccurrences(ev, T0, T0 + 120 * DAY);
      assert.equal(occs.length, 4, freq);
      for (let i = 1; i < occs.length; i++) {
        assert.equal(occs[i]!.startsAt - occs[i - 1]!.startsAt, step, freq);
      }
    }
  });

  test("weekly byWeekday: only the chosen UTC weekdays, anchored at the start's time of day", () => {
    // T0 is a Wednesday (UTC weekday 3). Repeat on Mon (1) + Wed (3).
    const ev = { startsAt: T0, endsAt: null, recurrenceJson: rule({ freq: "weekly", byWeekday: [1, 3], count: 6 }) };
    const occs = expandOccurrences(ev, T0 - 30 * DAY, T0 + 60 * DAY);
    assert.equal(occs.length, 6);
    assert.equal(occs[0]!.startsAt, T0, "the anchor itself matches its own weekday");
    for (const o of occs) {
      const d = new Date(o.startsAt);
      assert.ok([1, 3].includes(d.getUTCDay()), "only Mon/Wed");
      assert.equal(d.getUTCHours(), 18, "time of day preserved");
      assert.ok(o.startsAt >= T0, "never before the series anchor");
    }
    // Wed → next Mon is +5d, Mon → Wed is +2d.
    assert.equal(occs[1]!.startsAt - occs[0]!.startsAt, 5 * DAY);
    assert.equal(occs[2]!.startsAt - occs[1]!.startsAt, 2 * DAY);
  });

  test("monthly: same day-of-month, clamped to short months (Jan 31 → Feb 28)", () => {
    const jan31 = Date.UTC(2026, 0, 31, 12, 0, 0); // 2026 is not a leap year
    const ev = { startsAt: jan31, endsAt: null, recurrenceJson: rule({ freq: "monthly", count: 4 }) };
    const occs = expandOccurrences(ev, jan31, jan31 + 200 * DAY);
    assert.deepEqual(
      occs.map((o) => o.startsAt),
      [
        Date.UTC(2026, 0, 31, 12), // Jan 31
        Date.UTC(2026, 1, 28, 12), // Feb 28 (clamped)
        Date.UTC(2026, 2, 31, 12), // Mar 31
        Date.UTC(2026, 3, 30, 12), // Apr 30 (clamped)
      ],
    );
  });

  test("cap bounds a single call, not the series", () => {
    const ev = { startsAt: T0, endsAt: null, recurrenceJson: rule({ freq: "daily" }) };
    const capped = expandOccurrences(ev, T0, T0 + 3650 * DAY);
    assert.equal(capped.length, OCCURRENCE_EXPANSION_CAP);
    const tight = expandOccurrences(ev, T0, T0 + 3650 * DAY, 7);
    assert.equal(tight.length, 7);
  });

  test("window mid-series: count is measured from the series start, window filters output", () => {
    const ev = { startsAt: T0, endsAt: null, recurrenceJson: rule({ freq: "daily", count: 10 }) };
    // Window opens at the 8th occurrence: only occurrences 8..10 remain.
    const occs = expandOccurrences(ev, T0 + 7 * DAY, T0 + 365 * DAY);
    assert.equal(occs.length, 3);
    assert.equal(occs[0]!.startsAt, T0 + 7 * DAY);
  });

  test("malformed / out-of-preset rules degrade to a one-off", () => {
    const bads = [
      "not json",
      rule({ freq: "yearly" }),
      rule({ freq: "daily", until: T0, count: 3 }), // mutually exclusive
      rule({ freq: "daily", byWeekday: [1] }), // byWeekday is weekly-only
      rule({ freq: "weekly", byWeekday: [7] }), // out-of-range weekday
      rule({ freq: "weekly", byWeekday: [] }), // empty set
      rule({ freq: "weekly", count: 53 }), // over MAX_RECURRENCE_COUNT
      rule({ freq: "weekly", count: 0 }),
    ];
    for (const bad of bads) {
      assert.equal(parseEventRecurrence(bad), null, bad);
      const occs = expandOccurrences({ startsAt: T0, endsAt: null, recurrenceJson: bad }, T0 - DAY, T0 + 30 * DAY);
      assert.deepEqual(occs.map((o) => o.startsAt), [T0], bad);
    }
  });

  test("valid rules parse canonically", () => {
    const r = parseEventRecurrence(rule({ freq: "weekly", byWeekday: [3, 1, 1], count: 12 }));
    assert.ok(r);
    assert.deepEqual(r!.byWeekday, [1, 3], "deduped + sorted");
    assert.equal(r!.count, 12);
  });
});

describe("message links", () => {
  test("URL round-trip", () => {
    const url = buildMessageLinkUrl("https://spire.test", "room_abc123", "msg_xyz789");
    assert.equal(url, "https://spire.test/?m=room_abc123:msg_xyz789");
    assert.deepEqual(parseMessageLink(url), { roomId: "room_abc123", messageId: "msg_xyz789" });
  });

  test("bare token round-trip", () => {
    const token = buildMessageLinkToken("room_abc123", "msg_xyz789");
    assert.deepEqual(parseMessageLink(token), { roomId: "room_abc123", messageId: "msg_xyz789" });
    assert.deepEqual(parseMessageLink(`  ${token}  `), { roomId: "room_abc123", messageId: "msg_xyz789" });
  });

  test("rejects malformed input", () => {
    for (const bad of [
      "",
      "no-colon",
      "a:b", // ids too short
      "room_abc123:msg:extra", // ':' can't appear in an id
      "https://spire.test/?x=1", // no ?m=
      "https://spire.test/?m=garbage",
      "javascript:alert(1)",
    ]) {
      assert.equal(parseMessageLink(bad), null, JSON.stringify(bad));
    }
  });
});
