import "./helpers/env.js"; // MUST be first - sets SQLITE_PATH before the db singleton loads
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";
import {
  offsetPageQueryShape,
  resolveOffsetPage,
  countRows,
  offsetPageEnvelope,
  DEFAULT_CATALOG_PAGE_SIZE,
  parseLimit,
  cursorPageSlice,
} from "../src/lib/pagination.js";
import { makeTestDb, createUser } from "./helpers/harness.js";

/**
 * Characterization test for the shared offset-catalog scaffolding
 * (apps/server/src/lib/pagination.ts, finding O4), extracted byte-identically
 * from the duplicate `page`/`pageSize` fragment + `count(*)` total + envelope
 * in routes/worlds.ts (`/worlds/catalog`) and routes/stories.ts
 * (`/stories/catalog`). Pins every divergence-free piece both routes shared:
 *   - the zod query fragment's coercion + clamps (page 0..1000, pageSize 1..50)
 *   - the shared defaults (page 0, pageSize 24) applied when omitted
 *   - the `count(*)` total (0 when no rows match)
 *   - the exact `(page + 1) * pageSize < total` hasMore test at its boundary
 * Per-route bits (parse-failure handling, extra envelope fields, entity conds)
 * stay at the call sites and are intentionally NOT covered here.
 */

// A z.object using the shared fragment, mirroring how both routes spread it.
const queryObj = z.object({ ...offsetPageQueryShape }).strict();

describe("offsetPageQueryShape — zod fragment", () => {
  test("coerces numeric strings (querystrings arrive as strings)", () => {
    const r = queryObj.parse({ page: "3", pageSize: "10" });
    assert.deepEqual(r, { page: 3, pageSize: 10 });
  });

  test("both fields optional (omitted -> undefined, defaults applied later)", () => {
    assert.deepEqual(queryObj.parse({}), {});
  });

  test("page clamps: min 0, max 1000 inclusive; rejects out of range", () => {
    assert.equal(queryObj.parse({ page: "0" }).page, 0);
    assert.equal(queryObj.parse({ page: "1000" }).page, 1000);
    assert.equal(queryObj.safeParse({ page: "-1" }).success, false);
    assert.equal(queryObj.safeParse({ page: "1001" }).success, false);
  });

  test("pageSize clamps: min 1, max 50 inclusive; rejects out of range", () => {
    assert.equal(queryObj.parse({ pageSize: "1" }).pageSize, 1);
    assert.equal(queryObj.parse({ pageSize: "50" }).pageSize, 50);
    assert.equal(queryObj.safeParse({ pageSize: "0" }).success, false);
    assert.equal(queryObj.safeParse({ pageSize: "51" }).success, false);
  });

  test("rejects non-integer values", () => {
    assert.equal(queryObj.safeParse({ page: "2.5" }).success, false);
    assert.equal(queryObj.safeParse({ pageSize: "10.5" }).success, false);
  });
});

describe("resolveOffsetPage — shared defaults", () => {
  test("applies page 0 / pageSize 24 when omitted", () => {
    assert.deepEqual(resolveOffsetPage({}), { page: 0, pageSize: DEFAULT_CATALOG_PAGE_SIZE });
    assert.equal(DEFAULT_CATALOG_PAGE_SIZE, 24);
  });

  test("passes through provided values verbatim", () => {
    assert.deepEqual(resolveOffsetPage({ page: 5, pageSize: 10 }), { page: 5, pageSize: 10 });
  });

  test("page 0 is honored, not treated as missing (0 ?? default = 0)", () => {
    assert.equal(resolveOffsetPage({ page: 0, pageSize: 12 }).page, 0);
  });
});

describe("offsetPageEnvelope — envelope + hasMore boundary", () => {
  test("builds the exact five-field envelope", () => {
    assert.deepEqual(
      offsetPageEnvelope({ entries: ["a", "b"], page: 0, pageSize: 24, total: 2 }),
      { entries: ["a", "b"], page: 0, pageSize: 24, total: 2, hasMore: false },
    );
  });

  test("hasMore is (page + 1) * pageSize < total, exactly", () => {
    // page 0, size 24, total 24 -> 24 < 24 is false (last full page).
    assert.equal(offsetPageEnvelope({ entries: [], page: 0, pageSize: 24, total: 24 }).hasMore, false);
    // page 0, size 24, total 25 -> 24 < 25 is true (one more page).
    assert.equal(offsetPageEnvelope({ entries: [], page: 0, pageSize: 24, total: 25 }).hasMore, true);
    // page 1, size 10, total 20 -> 20 < 20 is false.
    assert.equal(offsetPageEnvelope({ entries: [], page: 1, pageSize: 10, total: 20 }).hasMore, false);
    // page 1, size 10, total 21 -> 20 < 21 is true.
    assert.equal(offsetPageEnvelope({ entries: [], page: 1, pageSize: 10, total: 21 }).hasMore, true);
  });

  test("total 0 -> hasMore false", () => {
    assert.equal(offsetPageEnvelope({ entries: [], page: 0, pageSize: 24, total: 0 }).hasMore, false);
  });
});

describe("parseLimit — `?limit` clamp with a floor (finding O1)", () => {
  // The four no-floor sites all used the same shape:
  //   Math.min(MAX, parseInt(req.query.limit ?? "D", 10) || D)
  // Model each here as { max, default } and prove the NORMAL path is byte-
  // identical while the negative case is now floored instead of leaking a
  // negative `LIMIT` (which SQLite treats as "no limit").
  const reports = { max: 200, default: 100 }; // routes/reports.ts, servers/reports.ts
  const perms = { max: 100, default: 30 }; // admin/permissions.ts
  const audit = { max: 500, default: 200 }; // admin/routes.ts

  // Reference implementation of the OLD buggy idiom, for the parity assertions.
  const oldIdiom = (raw: string | undefined, o: { max: number; default: number }) =>
    Math.min(o.max, parseInt(raw ?? String(o.default), 10) || o.default);

  test("normal path unchanged: valid in-range values pass through verbatim", () => {
    for (const o of [reports, perms, audit]) {
      for (const v of ["1", "5", "10", "42"]) {
        assert.equal(parseLimit(v, o), oldIdiom(v, o), `${v} @ ${JSON.stringify(o)}`);
      }
    }
  });

  test("normal path unchanged: missing / empty / 0 / NaN all fall back to default", () => {
    for (const o of [reports, perms, audit]) {
      assert.equal(parseLimit(undefined, o), o.default);
      assert.equal(parseLimit("", o), o.default);
      assert.equal(parseLimit("0", o), o.default);
      assert.equal(parseLimit("abc", o), o.default);
      // parity with the old idiom for exactly these (previously-handled) cases
      assert.equal(parseLimit(undefined, o), oldIdiom(undefined, o));
      assert.equal(parseLimit("0", o), oldIdiom("0", o));
      assert.equal(parseLimit("abc", o), oldIdiom("abc", o));
    }
  });

  test("normal path unchanged: over-max clamps to max", () => {
    assert.equal(parseLimit("999", reports), 200);
    assert.equal(parseLimit("999", perms), 100);
    assert.equal(parseLimit("99999", audit), 500);
  });

  test("THE FIX: negative limit is floored to >= 1, never leaks a negative LIMIT", () => {
    // OLD idiom leaked the negative straight through Math.min:
    assert.equal(oldIdiom("-5", reports), -5); // demonstrates the old bug
    // NEW helper floors it to the default (never <= 0):
    assert.equal(parseLimit("-5", reports), 100);
    assert.equal(parseLimit("-1", perms), 30);
    assert.equal(parseLimit("-100", audit), 200);
    for (const o of [reports, perms, audit]) {
      assert.ok(parseLimit("-5", o) >= 1);
    }
  });

  test("explicit min floor is honored", () => {
    assert.equal(parseLimit("0", { max: 50, default: 25, min: 5 }), 25);
    assert.equal(parseLimit("2", { max: 50, default: 25, min: 5 }), 5);
    assert.equal(parseLimit("-9", { max: 50, default: 25, min: 5 }), 25);
  });

  test("accepts a numeric input and floors fractional values", () => {
    assert.equal(parseLimit(7, reports), 7);
    assert.equal(parseLimit(7.9, reports), 7);
    assert.equal(parseLimit(-3, reports), 100);
  });

  test("parseMode 'number' accepts decimals the same way (then floored)", () => {
    assert.equal(parseLimit("7.9", { max: 50, default: 10, parseMode: "number" }), 7);
  });
});

describe("cursorPageSlice — createdAt cursor, no dup/skip at boundary (finding O5)", () => {
  // Rows are just { createdAt } newest-first, matching how both call sites
  // (notifications/engine.ts, earning ledger) order and over-fetch limit+1.
  type Row = { createdAt: number };
  const cursorOf = (r: Row) => r.createdAt;

  // Simulate a full paginated walk over `total` rows at page size `limit`.
  // The caller over-fetches limit+1 filtered by `createdAt < cursor`.
  function walk(total: number, limit: number): Row[] {
    const all: Row[] = Array.from({ length: total }, (_, i) => ({ createdAt: total - i })); // newest first
    const seen: Row[] = [];
    let cursor: number | null = null;
    let guard = 0;
    for (;;) {
      if (guard++ > 1000) throw new Error("pagination did not terminate");
      const pool = cursor == null ? all : all.filter((r) => r.createdAt < cursor!);
      const fetched = pool.slice(0, limit + 1); // over-fetch limit+1
      const { page, nextCursor } = cursorPageSlice(fetched, limit, cursorOf);
      seen.push(...page);
      if (nextCursor == null) break;
      cursor = nextCursor;
    }
    return seen;
  }

  test("non-final full page: returns exactly `limit` rows + a real next cursor", () => {
    const rows: Row[] = [{ createdAt: 5 }, { createdAt: 4 }, { createdAt: 3 }]; // limit+1 = 3
    const { page, nextCursor } = cursorPageSlice(rows, 2, cursorOf);
    assert.deepEqual(page, [{ createdAt: 5 }, { createdAt: 4 }]);
    assert.equal(nextCursor, 4); // cursor is the LAST RETURNED row, not the over-fetched one
  });

  test("THE FIX: a full-but-final page yields nextCursor null (no spurious empty page)", () => {
    // Exactly `limit` rows exist -> caller over-fetches and gets only `limit`.
    const rows: Row[] = [{ createdAt: 2 }, { createdAt: 1 }];
    const { page, nextCursor } = cursorPageSlice(rows, 2, cursorOf);
    assert.deepEqual(page, [{ createdAt: 2 }, { createdAt: 1 }]);
    assert.equal(nextCursor, null);
  });

  test("empty result -> empty page, null cursor", () => {
    const { page, nextCursor } = cursorPageSlice([] as Row[], 2, cursorOf);
    assert.deepEqual(page, []);
    assert.equal(nextCursor, null);
  });

  test("boundary sweep: every total walks each row exactly once (no dup, no skip)", () => {
    for (const limit of [1, 2, 3, 5]) {
      for (let total = 0; total <= 12; total++) {
        const seen = walk(total, limit);
        assert.equal(seen.length, total, `total=${total} limit=${limit}: count`);
        const ids = seen.map((r) => r.createdAt);
        // no duplicates
        assert.equal(new Set(ids).size, ids.length, `total=${total} limit=${limit}: dup`);
        // covers every original createdAt 1..total exactly once, in order
        const expected = Array.from({ length: total }, (_, i) => total - i);
        assert.deepEqual(ids, expected, `total=${total} limit=${limit}: order/coverage`);
      }
    }
  });

  test("multiple-of-limit total is the case the old `=== limit` test broke", () => {
    // total == limit (and any multiple) is where the old code emitted a
    // spurious cursor -> an extra empty fetch. The sweep above already covers
    // total==limit and total==2*limit; assert termination + exact coverage.
    assert.deepEqual(
      walk(4, 2).map((r) => r.createdAt),
      [4, 3, 2, 1],
    );
    assert.deepEqual(
      walk(6, 3).map((r) => r.createdAt),
      [6, 5, 4, 3, 2, 1],
    );
  });
});

describe("countRows — count(*) total", () => {
  let db: Db;
  let raw: ReturnType<typeof makeTestDb>["raw"];

  before(() => {
    ({ db, raw } = makeTestDb());
  });
  after(() => {
    raw.close();
  });

  test("0 when no rows match", async () => {
    assert.equal(await countRows(db, schema.users, eq(schema.users.role, "admin")), 0);
  });

  test("counts all rows when whereExpr is undefined", async () => {
    await createUser(db, { role: "user" });
    await createUser(db, { role: "user" });
    await createUser(db, { role: "admin" });
    assert.equal(await countRows(db, schema.users, undefined), 3);
  });

  test("counts only rows matching the predicate", async () => {
    assert.equal(await countRows(db, schema.users, eq(schema.users.role, "user")), 2);
    assert.equal(await countRows(db, schema.users, eq(schema.users.role, "admin")), 1);
  });
});
