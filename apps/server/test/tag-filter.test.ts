import { describe, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and } from "drizzle-orm";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { tagIncludes, tagExcludes } from "../src/lib/tagFilter.js";

/**
 * Characterization test for the consolidated comma-wrapped tag/content-warning
 * membership filter (apps/server/src/lib/tagFilter.ts), extracted byte-identically
 * from the inline copies in routes/worlds.ts and routes/stories.ts.
 *
 * Each copy built `needle = `%,${x.toLowerCase()},%`` and pushed
 * `sql`(',' || lower(col) || ',') LIKE/NOT LIKE ${needle}``. This runs the
 * helpers against a real in-memory SQLite table to pin the runtime semantics:
 * comma-wrapping prevents substring overlap (`courtly` != `low-courtly`),
 * matching is case-insensitive, and `%`/`_` are NOT LIKE-escaped.
 */
const items = sqliteTable("items", {
  id: integer("id").primaryKey(),
  tags: text("tags").notNull(),
});

function makeDb() {
  const raw = new Database(":memory:");
  raw.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, tags TEXT NOT NULL)");
  return { db: drizzle(raw), raw };
}

describe("tagFilter", () => {
  test("tagIncludes: exact comma-member match, no substring overlap", () => {
    const { db } = makeDb();
    db.insert(items).values([
      { id: 1, tags: "courtly,romance" },
      { id: 2, tags: "low-courtly,grim" },
      { id: 3, tags: "romance" },
    ]).run();
    const rows = db.select({ id: items.id }).from(items)
      .where(tagIncludes(items.tags, "courtly")).all();
    assert.deepEqual(rows.map((r) => r.id).sort(), [1]);
  });

  test("tagIncludes: case-insensitive on both column and needle", () => {
    const { db } = makeDb();
    db.insert(items).values([
      { id: 1, tags: "Courtly,Romance" },
      { id: 2, tags: "grim" },
    ]).run();
    const rows = db.select({ id: items.id }).from(items)
      .where(tagIncludes(items.tags, "COURTLY")).all();
    assert.deepEqual(rows.map((r) => r.id), [1]);
  });

  test("tagIncludes: multiple tags AND together", () => {
    const { db } = makeDb();
    db.insert(items).values([
      { id: 1, tags: "courtly,romance,grim" },
      { id: 2, tags: "courtly,grim" },
      { id: 3, tags: "romance" },
    ]).run();
    const rows = db.select({ id: items.id }).from(items)
      .where(and(tagIncludes(items.tags, "courtly"), tagIncludes(items.tags, "romance"))).all();
    assert.deepEqual(rows.map((r) => r.id).sort(), [1]);
  });

  test("tagExcludes: drops rows carrying the warning, keeps overlaps", () => {
    const { db } = makeDb();
    db.insert(items).values([
      { id: 1, tags: "gore,violence" },
      { id: 2, tags: "no-gore,fluff" },
      { id: 3, tags: "fluff" },
    ]).run();
    const rows = db.select({ id: items.id }).from(items)
      .where(tagExcludes(items.tags, "gore")).all();
    assert.deepEqual(rows.map((r) => r.id).sort(), [2, 3]);
  });

  test("no LIKE-escaping: % and _ in the needle act as wildcards", () => {
    const { db } = makeDb();
    // Needle for "a%b" becomes `%,a%b,%` where the inner % is a wildcard,
    // matching a row whose comma-list has a member starting "a" ending "b".
    db.insert(items).values([
      { id: 1, tags: "axxb" },
      { id: 2, tags: "azb" },
      { id: 3, tags: "cd" },
    ]).run();
    const rows = db.select({ id: items.id }).from(items)
      .where(tagIncludes(items.tags, "a%b")).all();
    assert.deepEqual(rows.map((r) => r.id).sort(), [1, 2]);
  });
});
