import "./helpers/env.js"; // MUST be first - sets SQLITE_PATH before the db singleton loads
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../src/db/index.js";
import { characterEarning, characters, earningLedger, userEarning } from "../src/db/schema.js";
import { debitPool, type DebitPoolResult } from "../src/earning/award.js";
import { DEFAULT_SERVER_ID } from "../src/earning/pool.js";
import { makeTestDb, createUser } from "./helpers/harness.js";

/**
 * Characterization test for the sync `debitPool` primitive
 * (apps/server/src/earning/award.ts, finding P4), extracted from the four
 * inline currency-mutating branches in routes/arcade.ts: the Eidolon
 * basic-heal debit (`debitCurrency`, user + character) and the Eidolon sale
 * credit (`sell` tx, user + character).
 *
 * The matrix pins EVERY documented divergence from `creditPool`:
 *   - runs INSIDE the caller's transaction (opens none of its own)
 *   - currency-ONLY: never touches xp, and NEVER recomputes rank / tier / peak
 *   - rejects (no writes at all) when `rejectOnInsufficient` AND the resulting
 *     balance would go negative — returning the pre-debit balance
 *   - NO `Math.max(0, …)` floor: with the guard off a negative result stands
 *   - the signed `currencyDelta` is written verbatim to the ledger row (debit
 *     negative, credit positive), with `xpDelta: 0` and the caller's
 *     reason/metadata
 *   - lazy-creates the pool row (onConflictDoNothing) before reading
 */
describe("debitPool", () => {
  let db: Db;
  let raw: ReturnType<typeof makeTestDb>["raw"];

  before(() => {
    ({ db, raw } = makeTestDb());
  });
  after(() => {
    raw.close();
  });

  beforeEach(() => {
    raw.exec("DELETE FROM earning_ledger");
    raw.exec("DELETE FROM user_earning");
    raw.exec("DELETE FROM character_earning");
    raw.exec("DELETE FROM characters");
    raw.exec("DELETE FROM users");
  });

  const run = (input: Parameters<typeof debitPool>[1]): DebitPoolResult =>
    db.transaction((tx) => debitPool(tx, input));

  async function makeUser(): Promise<string> {
    const u = await createUser(db);
    return u.id;
  }

  async function makeCharacter(userId: string): Promise<string> {
    const id = nanoid();
    await db.insert(characters).values({ id, userId, name: `c_${id.slice(0, 6)}` });
    return id;
  }

  async function ledgerRows(): Promise<Array<typeof earningLedger.$inferSelect>> {
    return db.select().from(earningLedger).all() as unknown as Array<typeof earningLedger.$inferSelect>;
  }

  test("user debit: balance decreases, ledger records the NEGATIVE delta, xp/rank untouched", async () => {
    const userId = await makeUser();
    await db.insert(userEarning).values({
      serverId: DEFAULT_SERVER_ID, userId, currency: 100, xp: 500, rankKey: "rank_two", tier: 3,
      maxRankKeyEverHeld: "rank_two", maxTierEverHeld: 3,
    });

    const res = run({
      serverId: DEFAULT_SERVER_ID, scope: "user", ownerId: userId, currencyDelta: -30,
      reason: "eidolon_basic_heal", metadata: { kind: "eidolon_heal" }, rejectOnInsufficient: true,
    });

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.final, { xp: 500, currency: 70, rankKey: "rank_two", tier: 3 });

    const row = (await db.select().from(userEarning).where(eq(userEarning.userId, userId)).limit(1))[0];
    assert.equal(row.currency, 70);
    // No rank rewrite: xp / rank / tier / peaks all exactly as seeded.
    assert.equal(row.xp, 500);
    assert.equal(row.rankKey, "rank_two");
    assert.equal(row.tier, 3);
    assert.equal(row.maxRankKeyEverHeld, "rank_two");
    assert.equal(row.maxTierEverHeld, 3);

    const rows = await ledgerRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope, "user");
    assert.equal(rows[0].ownerId, userId);
    assert.equal(rows[0].xpDelta, 0);
    assert.equal(rows[0].currencyDelta, -30);
    assert.equal(rows[0].reason, "eidolon_basic_heal");
    assert.equal(rows[0].metadataJson, JSON.stringify({ kind: "eidolon_heal" }));
  });

  test("user debit rejects on insufficient funds: NO writes, returns pre-debit balance", async () => {
    const userId = await makeUser();
    await db.insert(userEarning).values({ serverId: DEFAULT_SERVER_ID, userId, currency: 10 });

    const res = run({
      serverId: DEFAULT_SERVER_ID, scope: "user", ownerId: userId, currencyDelta: -30,
      reason: "eidolon_basic_heal", metadata: { kind: "eidolon_heal" }, rejectOnInsufficient: true,
    });

    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.balance, 10);

    const row = (await db.select().from(userEarning).where(eq(userEarning.userId, userId)).limit(1))[0];
    assert.equal(row.currency, 10); // unchanged
    assert.equal((await ledgerRows()).length, 0); // no ledger row on rejection
  });

  test("exact-balance debit to zero succeeds (boundary: not insufficient)", async () => {
    const userId = await makeUser();
    await db.insert(userEarning).values({ serverId: DEFAULT_SERVER_ID, userId, currency: 30 });

    const res = run({
      serverId: DEFAULT_SERVER_ID, scope: "user", ownerId: userId, currencyDelta: -30,
      reason: "eidolon_basic_heal", metadata: null, rejectOnInsufficient: true,
    });

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.final.currency, 0);
    assert.equal((await ledgerRows())[0].metadataJson, null); // null metadata => null column
  });

  test("lazy-creates the pool row, then rejects (0 balance < amount) with no ledger row", async () => {
    const userId = await makeUser(); // no user_earning row yet
    const res = run({
      serverId: DEFAULT_SERVER_ID, scope: "user", ownerId: userId, currencyDelta: -5,
      reason: "eidolon_basic_heal", metadata: { kind: "eidolon_heal" }, rejectOnInsufficient: true,
    });

    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.balance, 0);
    // The onConflictDoNothing insert ran before the read, so a zero row exists.
    const row = (await db.select().from(userEarning).where(eq(userEarning.userId, userId)).limit(1))[0];
    assert.equal(row.currency, 0);
    assert.equal((await ledgerRows()).length, 0);
  });

  test("credit (rejectOnInsufficient off): positive delta increases balance, positive ledger delta", async () => {
    const userId = await makeUser();
    await db.insert(userEarning).values({ serverId: DEFAULT_SERVER_ID, userId, currency: 10 });

    const res = run({
      serverId: DEFAULT_SERVER_ID, scope: "user", ownerId: userId, currencyDelta: 25,
      reason: "eidolon_sale", metadata: { kind: "eidolon_sale", level: 4 }, rejectOnInsufficient: false,
    });

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.final.currency, 35);
    const rows = await ledgerRows();
    assert.equal(rows[0].currencyDelta, 25);
    assert.equal(rows[0].reason, "eidolon_sale");
    assert.equal(rows[0].metadataJson, JSON.stringify({ kind: "eidolon_sale", level: 4 }));
  });

  test("NO floor: with the guard off a negative delta can drive the balance below zero", async () => {
    const userId = await makeUser();
    await db.insert(userEarning).values({ serverId: DEFAULT_SERVER_ID, userId, currency: 10 });

    const res = run({
      serverId: DEFAULT_SERVER_ID, scope: "user", ownerId: userId, currencyDelta: -25,
      reason: "manual", metadata: null, rejectOnInsufficient: false,
    });

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.final.currency, -15); // NOT floored at 0
    const row = (await db.select().from(userEarning).where(eq(userEarning.userId, userId)).limit(1))[0];
    assert.equal(row.currency, -15);
  });

  test("character scope debit hits the character pool + ledger with scope 'character'", async () => {
    const userId = await makeUser();
    const charId = await makeCharacter(userId);
    await db.insert(characterEarning).values({
      serverId: DEFAULT_SERVER_ID, characterId: charId, currency: 50, xp: 99, rankKey: "rank_one", tier: 1,
    });

    const res = run({
      serverId: DEFAULT_SERVER_ID, scope: "character", ownerId: charId, currencyDelta: -20,
      reason: "eidolon_basic_heal", metadata: { kind: "eidolon_heal" }, rejectOnInsufficient: true,
    });

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.final, { xp: 99, currency: 30, rankKey: "rank_one", tier: 1 });

    const row = (await db.select().from(characterEarning)
      .where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, charId))).limit(1))[0];
    assert.equal(row.currency, 30);
    assert.equal(row.xp, 99); // untouched
    assert.equal(row.rankKey, "rank_one");

    const rows = await ledgerRows();
    assert.equal(rows[0].scope, "character");
    assert.equal(rows[0].ownerId, charId);
    assert.equal(rows[0].currencyDelta, -20);
  });
});
