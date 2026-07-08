import { describe, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { escapeLike } from "../src/lib/nameLookup.js";

/**
 * Characterization test for the narrow SQL LIKE-wildcard escaper
 * (apps/server/src/lib/nameLookup.ts `escapeLike`), extracted
 * byte-identically from the inline copies in routes/rooms.ts,
 * routes/search.ts, routes/users.ts, routes/worlds.ts and
 * routes/stories.ts.
 *
 * Every one of those sites built its pattern via the exact literal
 * `x.replace(/[%_]/g, (c) => `\\${c}`)`. This pins that behavior and
 * proves the divergences the callers rely on:
 *   - ONLY `%` and `_` are escaped (each prefixed with a single `\`).
 *   - Backslash is NOT itself escaped (matches the old inline copies;
 *     paired with `ESCAPE '\'` a trailing lone backslash is a caller
 *     concern, unchanged by consolidation).
 *   - No lowercasing and no NBSP/space folding — that is the whole
 *     point of keeping this separate from `substringNameInsensitive`,
 *     which forces both. worlds/stories compose `.toLowerCase()`
 *     AFTER escaping; rooms/search/users do not lowercase at all.
 */

// The exact inline expression every call site used before consolidation.
const inline = (s: string): string => s.replace(/[%_]/g, (c) => `\\${c}`);

describe("escapeLike — pure escaper", () => {
  const cases = [
    "",
    "plain",
    "20% off",
    "under_score",
    "%_%",
    "a_b%c",
    "no wildcards here",
    "trailing\\backslash",
    "已 中文 %_",
    "MiXeDcAsE_%", // must NOT be lowercased by escapeLike itself
    "nbsp here", // NBSP must be left alone (no folding)
  ];

  test("matches the old inline replace byte-for-byte", () => {
    for (const c of cases) {
      assert.equal(escapeLike(c), inline(c), `mismatch for ${JSON.stringify(c)}`);
    }
  });

  test("escapes only % and _ with a single leading backslash", () => {
    assert.equal(escapeLike("a%b_c"), "a\\%b\\_c");
    assert.equal(escapeLike("%%__"), "\\%\\%\\_\\_");
  });

  test("does not lowercase or fold NBSP", () => {
    assert.equal(escapeLike("ABC"), "ABC");
    assert.equal(escapeLike("A B"), "A B");
  });

  test("worlds/stories composition (escape then lowercase) is order-safe", () => {
    // worlds.ts / stories.ts build: `%${escapeLike(q.trim()).toLowerCase()}%`
    const q = "  My_World 50% OFF  ";
    assert.equal(
      `%${escapeLike(q.trim()).toLowerCase()}%`,
      `%${q.trim().replace(/[%_]/g, (c) => `\\${c}`).toLowerCase()}%`,
    );
  });
});

describe("escapeLike — runtime SQLite semantics with ESCAPE '\\'", () => {
  test("literal % and _ match literally, wildcards no longer widen", () => {
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE t (v TEXT NOT NULL)");
    const rows = ["50% off", "50X off", "a_b", "aXb", "plain"];
    const ins = raw.prepare("INSERT INTO t (v) VALUES (?)");
    for (const r of rows) ins.run(r);

    const query = (term: string): string[] => {
      const like = `%${escapeLike(term)}%`;
      return raw
        .prepare("SELECT v FROM t WHERE v LIKE ? ESCAPE '\\' ORDER BY v")
        .all(like)
        .map((r: any) => r.v);
    };

    // `%` is treated literally: only the real "50% off" matches, not "50X off".
    assert.deepEqual(query("50%"), ["50% off"]);
    // `_` is treated literally: only "a_b" matches, not "aXb".
    assert.deepEqual(query("a_b"), ["a_b"]);

    // Sanity: WITHOUT escaping, the wildcards would widen the match.
    const unescaped = raw
      .prepare("SELECT v FROM t WHERE v LIKE ? ESCAPE '\\' ORDER BY v")
      .all("%50%%")
      .map((r: any) => r.v);
    assert.deepEqual(unescaped, ["50% off", "50X off"]);

    raw.close();
  });
});
