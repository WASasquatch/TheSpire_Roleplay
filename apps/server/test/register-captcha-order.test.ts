import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { Db } from "../src/db/index.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { ensureSiteSettings } from "../src/settings.js";
import { makeTestDb } from "./helpers/harness.js";

/**
 * Registration de-friction (retention package): the captcha is single-use,
 * so the server must verify it LAST — after field validation and the
 * username/email conflict check — or every fixable failure also burns the
 * challenge. Pinned here: a name-conflict 409 leaves the captcha alive and
 * reusable, and only a genuine captcha failure reports `code: "CAPTCHA"`
 * (the client's refresh signal).
 */

async function buildAuthApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400);
      return reply.send({
        error: "validation",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    throw err;
  });
  await registerAuthRoutes(app, db);
  await app.ready();
  return app;
}

/** Fetch a captcha and solve its "What is A + B?" question. */
async function solvedCaptcha(app: FastifyInstance): Promise<{ captchaId: string; captchaAnswer: string }> {
  const res = await app.inject({ method: "GET", url: "/auth/captcha" });
  assert.equal(res.statusCode, 200);
  const j = res.json() as { id: string; question: string };
  const m = /What is (\d+) \+ (\d+)\?/.exec(j.question);
  assert.ok(m, "captcha question is the expected math shape");
  return { captchaId: j.id, captchaAnswer: String(Number(m![1]) + Number(m![2])) };
}

function registerBody(username: string, email: string, captcha: { captchaId: string; captchaAnswer: string }) {
  return {
    email,
    username,
    password: "hunter2hunter2",
    acceptDisclaimer: true,
    birthdate: "1990-06-15",
    ...captcha,
  };
}

describe("register: captcha is verified last", () => {
  test("a username-conflict 409 does NOT consume the captcha; the same token then registers", async () => {
    const { db } = makeTestDb();
    await ensureSiteSettings(db);
    const app = await buildAuthApp(db);

    // Seed the taken name through the real route (also exercises success).
    const first = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: registerBody("Alice", "alice@test.local", await solvedCaptcha(app)),
    });
    assert.equal(first.statusCode, 200, first.body);

    // Conflict attempt with a fresh captcha: 409, and NOT a captcha error.
    const captcha = await solvedCaptcha(app);
    const conflict = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: registerBody("Alice", "bob@test.local", captcha),
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal((conflict.json() as { code?: string }).code, undefined, "conflict is not tagged as a captcha problem");

    // ORDER ASSERTION: the SAME captcha token still works — the conflict
    // check ran before the captcha was consumed.
    const retry = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: registerBody("Bob", "bob@test.local", captcha),
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal((retry.json() as { username: string }).username, "Bob");
  });

  test("field validation (zod) fails before the captcha is touched", async () => {
    const { db } = makeTestDb();
    await ensureSiteSettings(db);
    const app = await buildAuthApp(db);

    const captcha = await solvedCaptcha(app);
    // Bad username (regular space) → 400 validation, captcha untouched.
    const bad = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: registerBody("Bad Name", "carol@test.local", captcha),
    });
    assert.equal(bad.statusCode, 400);
    assert.equal((bad.json() as { error: string }).error, "validation");

    // The same token still registers once the field is fixed.
    const ok = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: registerBody("Good_Name", "carol@test.local", captcha),
    });
    assert.equal(ok.statusCode, 200, ok.body);
  });

  test("a wrong captcha answer is tagged code=CAPTCHA and consumes the token (single-use kept)", async () => {
    const { db } = makeTestDb();
    await ensureSiteSettings(db);
    const app = await buildAuthApp(db);

    const captcha = await solvedCaptcha(app);
    const wrong = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: registerBody("Dave", "dave@test.local", { captchaId: captcha.captchaId, captchaAnswer: "999" }),
    });
    assert.equal(wrong.statusCode, 400);
    assert.equal((wrong.json() as { code?: string }).code, "CAPTCHA", "captcha failures carry the refresh marker");

    // Single-use semantics survived the reorder: the burned token can't be
    // replayed even with the right answer.
    const replay = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: registerBody("Dave", "dave@test.local", captcha),
    });
    assert.equal(replay.statusCode, 400);
    assert.equal((replay.json() as { code?: string }).code, "CAPTCHA");
  });
});
