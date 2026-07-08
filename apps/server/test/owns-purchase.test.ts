import "./helpers/env.js"; // MUST be first - sets SQLITE_PATH before the db singleton loads
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import type { Db } from "../src/db/index.js";
import { earningLedger } from "../src/db/schema.js";
import { ownsPurchase } from "../src/earning/purchases.js";
import { DEFAULT_SERVER_ID } from "../src/earning/pool.js";
import { makeTestDb } from "./helpers/harness.js";

/**
 * Characterization test for the consolidated arcade purchase-unlock gate
 * (apps/server/src/earning/purchases.ts, finding P2), extracted from four
 * duplicate ledger checks: routes/arcade.ts (per-server, passes serverId),
 * routes/arcadeUrugal.ts, routes/arcadeGrimhold.ts, and commands/builtins/
 * eidolon.ts (all GLOBAL, no serverId).
 *
 * The matrix pins EVERY documented divergence:
 *   - reason match is exactly `purchase_<flairKey>` (prefix owned by helper)
 *   - scope + ownerId must both match
 *   - INTENTIONAL asymmetry: with `serverId` the check is per-server; without
 *     it, the check is global (matches any server) — a purchase on server B is
 *     visible to the global check but NOT to a per-server check on server A.
 */
describe("ownsPurchase", () => {
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
  });

  const FLAIR = "flair_eidolon_tamer";
  const OTHER_SERVER = "server_other";

  async function seed(opts: {
    scope: "user" | "character";
    ownerId: string;
    reason: string;
    serverId?: string;
  }): Promise<void> {
    await db.insert(earningLedger).values({
      id: nanoid(),
      scope: opts.scope,
      ownerId: opts.ownerId,
      reason: opts.reason,
      ...(opts.serverId !== undefined ? { serverId: opts.serverId } : {}),
    });
  }

  test("global check: true when a matching purchase row exists (any server)", async () => {
    await seed({ scope: "user", ownerId: "u1", reason: `purchase_${FLAIR}` });
    assert.equal(await ownsPurchase(db, { flairKey: FLAIR, scope: "user", ownerId: "u1" }), true);
  });

  test("global check: false with no matching row", async () => {
    assert.equal(await ownsPurchase(db, { flairKey: FLAIR, scope: "user", ownerId: "u1" }), false);
  });

  test("scope must match", async () => {
    await seed({ scope: "user", ownerId: "id1", reason: `purchase_${FLAIR}` });
    assert.equal(await ownsPurchase(db, { flairKey: FLAIR, scope: "character", ownerId: "id1" }), false);
  });

  test("ownerId must match", async () => {
    await seed({ scope: "user", ownerId: "u1", reason: `purchase_${FLAIR}` });
    assert.equal(await ownsPurchase(db, { flairKey: FLAIR, scope: "user", ownerId: "u2" }), false);
  });

  test("reason prefix is exact: a bare flair reason does not count", async () => {
    await seed({ scope: "user", ownerId: "u1", reason: FLAIR });
    assert.equal(await ownsPurchase(db, { flairKey: FLAIR, scope: "user", ownerId: "u1" }), false);
  });

  test("flairKey drives the reason: a different flair's purchase does not count", async () => {
    await seed({ scope: "user", ownerId: "u1", reason: "purchase_flair_grimhold" });
    assert.equal(await ownsPurchase(db, { flairKey: FLAIR, scope: "user", ownerId: "u1" }), false);
  });

  test("per-server check: true when the purchase is on that server", async () => {
    await seed({ scope: "user", ownerId: "u1", reason: `purchase_${FLAIR}`, serverId: DEFAULT_SERVER_ID });
    assert.equal(
      await ownsPurchase(db, { flairKey: FLAIR, scope: "user", ownerId: "u1", serverId: DEFAULT_SERVER_ID }),
      true,
    );
  });

  test("per-server check: false when the purchase is on a DIFFERENT server", async () => {
    await seed({ scope: "user", ownerId: "u1", reason: `purchase_${FLAIR}`, serverId: OTHER_SERVER });
    assert.equal(
      await ownsPurchase(db, { flairKey: FLAIR, scope: "user", ownerId: "u1", serverId: DEFAULT_SERVER_ID }),
      false,
    );
  });

  test("asymmetry: a purchase on server B is seen globally but not per-server on A", async () => {
    await seed({ scope: "user", ownerId: "u1", reason: `purchase_${FLAIR}`, serverId: OTHER_SERVER });
    // Global (Urugal/Grimhold/eidolon-command) — visible.
    assert.equal(await ownsPurchase(db, { flairKey: FLAIR, scope: "user", ownerId: "u1" }), true);
    // Per-server (arcade Eidolon route) scoped to the default — NOT visible.
    assert.equal(
      await ownsPurchase(db, { flairKey: FLAIR, scope: "user", ownerId: "u1", serverId: DEFAULT_SERVER_ID }),
      false,
    );
  });
});
