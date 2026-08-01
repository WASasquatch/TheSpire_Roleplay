import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../src/db/index.js";
import { registerMediaProxyRoutes } from "../src/routes/mediaProxy.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * GET /media/image, the same-origin image proxy the world PDF export pulls
 * every picture through.
 *
 * The export inlines each file as a `data:` URL before rasterizing, and this
 * is where those bytes come from, so the route's refusals matter twice over:
 * it must not be an open proxy, and it must not be an SSRF primitive pointed
 * at the private network. The address guard itself is covered in
 * overlook.test.ts; these cases pin the route's own gates and make sure the
 * checks actually run before any outbound fetch is attempted.
 */

async function buildApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify();
  await registerMediaProxyRoutes(app, db);
  await app.ready();
  return app;
}

describe("media image proxy", () => {
  let db: Db;
  let app: FastifyInstance;
  let token: string;

  before(async () => {
    ({ db } = makeTestDb());
    app = await buildApp(db);
    const user = await createUser(db, { birthdate: "1990-01-01" });
    token = await tokenFor(db, user.id);
  });

  async function get(u: string, withAuth = true) {
    return app.inject({
      method: "GET",
      url: `/media/image?u=${encodeURIComponent(u)}`,
      ...(withAuth ? { headers: auth(token) } : {}),
    });
  }

  test("anonymous callers are refused, so this can't be used as an open proxy", async () => {
    const res = await get("https://example.com/a.png", false);
    assert.equal(res.statusCode, 401);
  });

  test("a missing or unparseable target is a 400, not a fetch attempt", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/media/image", headers: auth(token) })).statusCode, 400);
    assert.equal((await get("not a url")).statusCode, 400);
  });

  test("http is refused: a downgrade hop is also the easy path to an internal service", async () => {
    assert.equal((await get("http://example.com/a.png")).statusCode, 400);
  });

  test("hosts that resolve into the private network are refused before any fetch", async () => {
    // Resolved through DNS and vetted per address, so a hostname pointing at
    // loopback is caught even though the literal string looks external.
    assert.equal((await get("https://localhost/a.png")).statusCode, 403);
    assert.equal((await get("https://127.0.0.1/a.png")).statusCode, 403);
  });

  test("the feature is NOT tied to the Overlook switch", async () => {
    // Overlook has its own copy of this proxy behind its master switch.
    // Turning that off must not silently strip the art out of world exports,
    // so this route has no feature gate: the private-network refusal above
    // proves the handler ran rather than 404ing on a disabled feature.
    const res = await get("https://127.0.0.1/a.png");
    assert.equal(res.statusCode, 403);
    assert.notEqual(res.statusCode, 404);
  });
});
