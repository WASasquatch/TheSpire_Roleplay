import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ageUtc,
  canSeeNsfw,
  isAdultUser,
  isMinor,
  meetsMinimumAge,
  minimumSignupAge,
} from "../src/auth/ageGate.js";

/**
 * The age helpers gate real minors' access, so their boundary behavior is
 * pinned by tests rather than trusted to read right. Every case drives the
 * pure functions with explicit UTC `now` values - no clocks, no flakiness.
 *
 * The contract under test (age-restriction plan, Phase 0):
 *   - birthdate NULL = legacy account = adult (attested 18+ at signup)
 *   - age math is date-only, UTC; a user is adult ON their 18th birthday
 *   - a malformed non-null birthdate fails CLOSED (not adult)
 *   - canSeeNsfw: anonymous -> false, minor -> false always, adult ->
 *     unless the "Hide 18+ content" preference is on
 *   - minimumSignupAge: flag OFF -> 18, ON -> 13
 */

/** Build a Date at UTC midnight from an ISO date - the exact boundary. */
function utc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

describe("ageUtc", () => {
  test("counts full years, date-only", () => {
    assert.equal(ageUtc("2000-06-15", utc("2026-06-15")), 26);
    assert.equal(ageUtc("2000-06-15", utc("2026-06-14")), 25);
    assert.equal(ageUtc("2000-06-15", utc("2026-06-16")), 26);
  });

  test("ignores the time of day (UTC midnight boundary)", () => {
    // 23:59 UTC the day BEFORE the birthday is still the previous age...
    assert.equal(ageUtc("2008-07-08", new Date("2026-07-07T23:59:59.999Z")), 17);
    // ...and 00:00 UTC on the birthday is the new age.
    assert.equal(ageUtc("2008-07-08", new Date("2026-07-08T00:00:00.000Z")), 18);
  });

  test("rejects malformed and impossible dates as null", () => {
    assert.equal(ageUtc("not-a-date", utc("2026-01-01")), null);
    assert.equal(ageUtc("2008-7-8", utc("2026-01-01")), null); // not zero-padded
    assert.equal(ageUtc("2008-02-31", utc("2026-01-01")), null); // rollover date
    assert.equal(ageUtc("2008-13-01", utc("2026-01-01")), null); // month 13
    assert.equal(ageUtc("", utc("2026-01-01")), null);
  });

  test("leap-day birthdate ages on March 1 in common years", () => {
    // Feb 29 2008 -> in 2026 (common year) the "not yet had the birthday"
    // rule holds through Feb 28 and flips on Mar 1.
    assert.equal(ageUtc("2008-02-29", utc("2026-02-28")), 17);
    assert.equal(ageUtc("2008-02-29", utc("2026-03-01")), 18);
  });
});

describe("isAdultUser / isMinor", () => {
  test("null birthdate = legacy account = adult", () => {
    assert.equal(isAdultUser({ birthdate: null }), true);
    assert.equal(isMinor({ birthdate: null }), false);
  });

  test("adult exactly ON the 18th birthday (UTC)", () => {
    const row = { birthdate: "2008-07-08" };
    assert.equal(isAdultUser(row, utc("2026-07-07")), false);
    assert.equal(isAdultUser(row, utc("2026-07-08")), true);
    assert.equal(isMinor(row, utc("2026-07-07")), true);
    assert.equal(isMinor(row, utc("2026-07-08")), false);
  });

  test("clearly-adult and clearly-minor dates", () => {
    assert.equal(isAdultUser({ birthdate: "1990-01-01" }, utc("2026-07-08")), true);
    assert.equal(isAdultUser({ birthdate: "2012-01-01" }, utc("2026-07-08")), false);
  });

  test("malformed non-null birthdate fails closed (not adult)", () => {
    assert.equal(isAdultUser({ birthdate: "garbage" }, utc("2026-07-08")), false);
    assert.equal(isMinor({ birthdate: "garbage" }, utc("2026-07-08")), true);
  });
});

describe("canSeeNsfw truth table", () => {
  const now = utc("2026-07-08");
  const adult = { birthdate: "1990-01-01" };
  const legacy = { birthdate: null };
  const minor = { birthdate: "2012-01-01" };

  test("anonymous viewer -> false", () => {
    assert.equal(canSeeNsfw(null, now), false);
    assert.equal(canSeeNsfw(undefined, now), false);
  });

  test("minor -> false regardless of the preference", () => {
    assert.equal(canSeeNsfw({ ...minor, hideNsfw: false }, now), false);
    assert.equal(canSeeNsfw({ ...minor, hideNsfw: true }, now), false);
  });

  test("adult -> true unless Hide 18+ content is on", () => {
    assert.equal(canSeeNsfw({ ...adult, hideNsfw: false }, now), true);
    assert.equal(canSeeNsfw({ ...adult, hideNsfw: true }, now), false);
  });

  test("legacy (null birthdate) behaves as adult", () => {
    assert.equal(canSeeNsfw({ ...legacy, hideNsfw: false }, now), true);
    assert.equal(canSeeNsfw({ ...legacy, hideNsfw: true }, now), false);
  });

  test("a minor crossing 18 flips to true with no stored change", () => {
    const viewer = { birthdate: "2008-07-08", hideNsfw: false };
    assert.equal(canSeeNsfw(viewer, utc("2026-07-07")), false);
    assert.equal(canSeeNsfw(viewer, utc("2026-07-08")), true);
  });
});

describe("minimumSignupAge + meetsMinimumAge (registration floor)", () => {
  const now = utc("2026-07-08");

  test("flag OFF -> 18, ON -> 13", () => {
    assert.equal(minimumSignupAge({ allowMinorSignups: false }), 18);
    assert.equal(minimumSignupAge({ allowMinorSignups: true }), 13);
  });

  test("13-minimum boundary with the flag ON", () => {
    const min = minimumSignupAge({ allowMinorSignups: true });
    assert.equal(meetsMinimumAge("2013-07-08", min, now), true); // 13 today
    assert.equal(meetsMinimumAge("2013-07-09", min, now), false); // 13 tomorrow
  });

  test("18-minimum boundary with the flag OFF", () => {
    const min = minimumSignupAge({ allowMinorSignups: false });
    assert.equal(meetsMinimumAge("2008-07-08", min, now), true); // 18 today
    assert.equal(meetsMinimumAge("2008-07-09", min, now), false); // 18 tomorrow
  });

  test("a 17-year-old passes the 13 floor but not the 18 floor", () => {
    assert.equal(meetsMinimumAge("2009-01-01", 13, now), true);
    assert.equal(meetsMinimumAge("2009-01-01", 18, now), false);
  });

  test("malformed input never meets any minimum", () => {
    assert.equal(meetsMinimumAge("2010-02-31", 13, now), false);
    assert.equal(meetsMinimumAge("soon", 13, now), false);
  });
});
