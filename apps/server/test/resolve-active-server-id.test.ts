import "./helpers/env.js"; // MUST be first - sets SQLITE_PATH before the db singleton loads
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Role } from "@thekeep/shared";
import type { Db } from "../src/db/index.js";
import { DEFAULT_SERVER_ID, resolveActiveServerId } from "../src/earning/pool.js";
import { makeTestDb } from "./helpers/harness.js";

/**
 * Characterization test for the consolidated `resolveActiveServerId` helper
 * (apps/server/src/earning/pool.ts, finding P1), extracted byte-identically
 * from three duplicate copies in routes/arcade.ts, routes/arcadeUrugal.ts, and
 * routes/arcadeGrimhold.ts. Pins the fallback contract that keeps the arcade
 * default-server economy byte-identical with the servers flag OFF:
 *   - no requested server            -> DEFAULT_SERVER_ID (short-circuit)
 *   - requested === DEFAULT_SERVER_ID -> DEFAULT_SERVER_ID (short-circuit)
 *   - a foreign server, flag OFF      -> DEFAULT_SERVER_ID (getSettings gate)
 * The servers flag defaults OFF on a fresh DB, so every path lands on the
 * default pool exactly as the inline copies did.
 */
describe("resolveActiveServerId", () => {
  let db: Db;
  let raw: ReturnType<typeof makeTestDb>["raw"];

  before(() => {
    ({ db, raw } = makeTestDb());
  });
  after(() => {
    raw.close();
  });

  const me = { id: "u_test", role: "user" as Role };

  const cases: Array<{ label: string; requested: string | undefined }> = [
    { label: "undefined requested", requested: undefined },
    { label: "empty string requested", requested: "" },
    { label: "explicit default", requested: DEFAULT_SERVER_ID },
    { label: "foreign server, flag off", requested: "server_other" },
    { label: "unknown server, flag off", requested: "does_not_exist" },
  ];

  for (const c of cases) {
    test(c.label, async () => {
      const got = await resolveActiveServerId(db, me, c.requested);
      assert.equal(got, DEFAULT_SERVER_ID, `should fall back to default for ${c.label}`);
    });
  }
});
