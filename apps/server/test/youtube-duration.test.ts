import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseIso8601Duration } from "../src/lib/youtube.js";

/**
 * YouTube `contentDetails.duration` is an ISO-8601 duration. We parse it into
 * whole seconds to cache a source's length for server-side empty-room
 * advancement (theaterScheduler.ts). A live broadcast / premiere reports "P0D"
 * (or omits it), which must come back null so the source stays un-timed and
 * never auto-advances.
 */
describe("parseIso8601Duration", () => {
  test("parses hours / minutes / seconds combinations", () => {
    assert.equal(parseIso8601Duration("PT45S"), 45);
    assert.equal(parseIso8601Duration("PT4M13S"), 4 * 60 + 13);
    assert.equal(parseIso8601Duration("PT1H2M10S"), 3600 + 2 * 60 + 10);
    assert.equal(parseIso8601Duration("PT2H"), 7200);
    assert.equal(parseIso8601Duration("PT10M"), 600);
    assert.equal(parseIso8601Duration("P1DT1H"), 86_400 + 3600);
  });

  test("returns null for a zero / empty / live-broadcast duration", () => {
    assert.equal(parseIso8601Duration("P0D"), null);
    assert.equal(parseIso8601Duration("PT0S"), null);
    assert.equal(parseIso8601Duration("P0DT0S"), null);
  });

  test("returns null for missing or malformed input", () => {
    assert.equal(parseIso8601Duration(null), null);
    assert.equal(parseIso8601Duration(undefined), null);
    assert.equal(parseIso8601Duration(""), null);
    assert.equal(parseIso8601Duration("garbage"), null);
    assert.equal(parseIso8601Duration("1H2M"), null); // no leading P
    assert.equal(parseIso8601Duration("PT1H2X"), null);
  });
});
