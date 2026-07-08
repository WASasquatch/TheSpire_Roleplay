import { describe, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/db/schema.js";
import { clampToDailyCap, earnedTodayForCap } from "../src/earning/dailyCap.js";

/**
 * Characterization test for the shared daily-currency-cap primitives
 * (apps/server/src/earning/dailyCap.ts), extracted byte-identically from the
 * four reward sources that each reimplemented the ledger scan + clamp:
 *
 *   - routes/arcadeGrimhold.ts  — LIKE `grimhold_%`, currency, per-active-server
 *   - routes/arcadeUrugal.ts    — LIKE `urugal_%`,   currency, per-active-server
 *   - routes/stories.ts royalty — eq `scriptorium_royalty`,        currency, DEFAULT
 *   - routes/stories.ts chapter — eq `scriptorium_chapter_reward`, xp+currency, DEFAULT
 *
 * The tests pin every documented divergence the callers rely on (plan §P3):
 *   - reason-match mode: LIKE-prefix (with the `_` treated as a LITERAL via
 *     `ESCAPE '\'`, matching the inline `LIKE 'grimhold\_%'`) vs exact `eq`;
 *   - which sum(s) each caller reads (currency-only vs xp+currency);
 *   - per-server scoping (rows on other servers never counted);
 *   - scope / owner filtering and the `createdAt >= sinceMs` day boundary;
 *   - the arcade clamp shape: a single currency ceiling that also gates XP,
 *     plus the `capped` flag semantics.
 */

const DDL = `
CREATE TABLE earning_ledger (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL DEFAULT 'server_spire_system',
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  xp_delta INTEGER NOT NULL DEFAULT 0,
  currency_delta INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);`;

type Row = {
  id: string;
  serverId?: string;
  scope: "user" | "character";
  ownerId: string;
  xp?: number;
  currency?: number;
  reason: string;
  createdAt: number;
};

function makeDb(rows: Row[]) {
  const raw = new Database(":memory:");
  raw.exec(DDL);
  const stmt = raw.prepare(
    `INSERT INTO earning_ledger (id, server_id, scope, owner_id, xp_delta, currency_delta, reason, created_at)
     VALUES (@id, @serverId, @scope, @ownerId, @xp, @currency, @reason, @createdAt)`,
  );
  for (const r of rows) {
    stmt.run({
      id: r.id,
      serverId: r.serverId ?? "srv_A",
      scope: r.scope,
      ownerId: r.ownerId,
      xp: r.xp ?? 0,
      currency: r.currency ?? 0,
      reason: r.reason,
      createdAt: r.createdAt,
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return drizzle(raw, { schema }) as any;
}

const DAY = 24 * 60 * 60 * 1000;
const SINCE = 1_000_000; // arbitrary "start of day" cutoff in ms

describe("earnedTodayForCap — reason-match modes", () => {
  test("LIKE-prefix sums only rows whose reason starts with `<prefix>_`", () => {
    const db = makeDb([
      { id: "1", scope: "user", ownerId: "u1", currency: 10, reason: "grimhold_snake", createdAt: SINCE + 1 },
      { id: "2", scope: "user", ownerId: "u1", currency: 5, reason: "grimhold_pong", createdAt: SINCE + 2 },
      // A different cabinet must NOT count toward this prefix.
      { id: "3", scope: "user", ownerId: "u1", currency: 100, reason: "urugal_floor", createdAt: SINCE + 3 },
    ]);
    const got = earnedTodayForCap(db, {
      serverId: "srv_A", scope: "user", ownerId: "u1",
      reason: { likePrefix: "grimhold" }, sinceMs: SINCE,
    });
    assert.equal(got.currency, 15);
  });

  test("LIKE-prefix `_` is LITERAL (ESCAPE), not a wildcard", () => {
    const db = makeDb([
      { id: "1", scope: "user", ownerId: "u1", currency: 7, reason: "grimhold_snake", createdAt: SINCE + 1 },
      // No underscore after the prefix -> must NOT match `grimhold\_%`.
      { id: "2", scope: "user", ownerId: "u1", currency: 999, reason: "grimholdXsnake", createdAt: SINCE + 2 },
      // Bare prefix with nothing after -> also must NOT match (needs `_` + at least the rest).
      { id: "3", scope: "user", ownerId: "u1", currency: 999, reason: "grimhold", createdAt: SINCE + 3 },
    ]);
    const got = earnedTodayForCap(db, {
      serverId: "srv_A", scope: "user", ownerId: "u1",
      reason: { likePrefix: "grimhold" }, sinceMs: SINCE,
    });
    assert.equal(got.currency, 7);
  });

  test("eq matches the reason exactly (no prefix/wildcard bleed)", () => {
    const db = makeDb([
      { id: "1", scope: "user", ownerId: "u1", currency: 20, reason: "scriptorium_royalty", createdAt: SINCE + 1 },
      { id: "2", scope: "user", ownerId: "u1", currency: 30, reason: "scriptorium_royalty_bonus", createdAt: SINCE + 2 },
      { id: "3", scope: "user", ownerId: "u1", currency: 40, reason: "scriptorium_chapter_reward", createdAt: SINCE + 3 },
    ]);
    const got = earnedTodayForCap(db, {
      serverId: "srv_A", scope: "user", ownerId: "u1",
      reason: { reason: "scriptorium_royalty" }, sinceMs: SINCE,
    });
    assert.equal(got.currency, 20);
  });
});

describe("earnedTodayForCap — summed fields", () => {
  test("returns both xp and currency sums (chapter reads both)", () => {
    const db = makeDb([
      { id: "1", scope: "character", ownerId: "c1", xp: 100, currency: 50, reason: "scriptorium_chapter_reward", createdAt: SINCE + 1 },
      { id: "2", scope: "character", ownerId: "c1", xp: 25, currency: 10, reason: "scriptorium_chapter_reward", createdAt: SINCE + 2 },
    ]);
    const got = earnedTodayForCap(db, {
      serverId: "srv_A", scope: "character", ownerId: "c1",
      reason: { reason: "scriptorium_chapter_reward" }, sinceMs: SINCE,
    });
    assert.deepEqual(got, { xp: 125, currency: 60 });
  });

  test("empty ledger returns { xp: 0, currency: 0 } (COALESCE)", () => {
    const db = makeDb([]);
    const got = earnedTodayForCap(db, {
      serverId: "srv_A", scope: "user", ownerId: "nobody",
      reason: { likePrefix: "grimhold" }, sinceMs: SINCE,
    });
    assert.deepEqual(got, { xp: 0, currency: 0 });
  });
});

describe("earnedTodayForCap — scoping filters", () => {
  test("per-server: rows on another server are not counted", () => {
    const db = makeDb([
      { id: "1", serverId: "srv_A", scope: "user", ownerId: "u1", currency: 10, reason: "grimhold_snake", createdAt: SINCE + 1 },
      { id: "2", serverId: "srv_B", scope: "user", ownerId: "u1", currency: 500, reason: "grimhold_snake", createdAt: SINCE + 2 },
    ]);
    const got = earnedTodayForCap(db, {
      serverId: "srv_A", scope: "user", ownerId: "u1",
      reason: { likePrefix: "grimhold" }, sinceMs: SINCE,
    });
    assert.equal(got.currency, 10);
  });

  test("scope + owner isolate the pool", () => {
    const db = makeDb([
      { id: "1", scope: "user", ownerId: "u1", currency: 10, reason: "grimhold_snake", createdAt: SINCE + 1 },
      { id: "2", scope: "character", ownerId: "u1", currency: 500, reason: "grimhold_snake", createdAt: SINCE + 2 },
      { id: "3", scope: "user", ownerId: "u2", currency: 500, reason: "grimhold_snake", createdAt: SINCE + 3 },
    ]);
    const got = earnedTodayForCap(db, {
      serverId: "srv_A", scope: "user", ownerId: "u1",
      reason: { likePrefix: "grimhold" }, sinceMs: SINCE,
    });
    assert.equal(got.currency, 10);
  });

  test("createdAt boundary: >= sinceMs included, earlier excluded", () => {
    const db = makeDb([
      { id: "before", scope: "user", ownerId: "u1", currency: 999, reason: "grimhold_snake", createdAt: SINCE - 1 },
      { id: "edge", scope: "user", ownerId: "u1", currency: 3, reason: "grimhold_snake", createdAt: SINCE },
      { id: "after", scope: "user", ownerId: "u1", currency: 4, reason: "grimhold_snake", createdAt: SINCE + DAY },
    ]);
    const got = earnedTodayForCap(db, {
      serverId: "srv_A", scope: "user", ownerId: "u1",
      reason: { likePrefix: "grimhold" }, sinceMs: SINCE,
    });
    assert.equal(got.currency, 7);
  });
});

describe("clampToDailyCap — arcade single-cap-gates-xp clamp", () => {
  test("headroom well above reward: full grant, not capped", () => {
    assert.deepEqual(
      clampToDailyCap({ currency: 10, xp: 5 }, 100),
      { currency: 10, xp: 5, capped: false },
    );
  });

  test("headroom exactly equals reward currency: full grant, not capped", () => {
    assert.deepEqual(
      clampToDailyCap({ currency: 10, xp: 5 }, 10),
      { currency: 10, xp: 5, capped: false },
    );
  });

  test("partial headroom: currency trimmed, xp still paid, capped", () => {
    assert.deepEqual(
      clampToDailyCap({ currency: 10, xp: 5 }, 4),
      { currency: 4, xp: 5, capped: true },
    );
  });

  test("zero headroom gates XP too and marks capped", () => {
    assert.deepEqual(
      clampToDailyCap({ currency: 10, xp: 5 }, 0),
      { currency: 0, xp: 0, capped: true },
    );
  });

  test("zero-currency reward with headroom: xp paid, not capped", () => {
    assert.deepEqual(
      clampToDailyCap({ currency: 0, xp: 5 }, 100),
      { currency: 0, xp: 5, capped: false },
    );
  });

  test("all-zero reward at zero headroom: nothing paid, not capped", () => {
    assert.deepEqual(
      clampToDailyCap({ currency: 0, xp: 0 }, 0),
      { currency: 0, xp: 0, capped: false },
    );
  });
});
