import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { registerStoryCatalogRoutes } from "../src/routes/stories/catalogRoutes.js";
import { registerStoryChapterRoutes } from "../src/routes/stories/chapterRoutes.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Phase 4 Scriptorium clamps (age-restriction plan, plan_ext §B5 + §F):
 * signed-in accounts under 18 are stricter than anonymous — G / PG /
 * PG-13 only, card-level in the catalog + splash and body-level at the
 * story / chapter open, with no owner bypass. Authoring R / NC-17 is
 * adult-only. Adults (hide preference or not) keep today's behavior;
 * anonymous keeps the honest-catalog + NC-17 login-stub behavior.
 *
 * The 18th-birthday boundary itself is pinned in age-gate.test.ts; the
 * fixture DOBs here are unambiguous (a 2012 minor, a 1990 adult).
 */

const MINOR_DOB = "2012-01-01";
const ADULT_DOB = "1990-01-01";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockIo: any = { fetchSockets: async () => [] };

async function buildStoriesApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400);
      return reply.send({ error: "validation" });
    }
    throw err;
  });
  await registerStoryCatalogRoutes(app, db);
  await registerStoryChapterRoutes(app, db, mockIo);
  await app.ready();
  return app;
}

async function insertStory(
  db: Db,
  opts: { authorUserId: string; rating: string; slug?: string; visibility?: string; status?: string },
): Promise<string> {
  const id = nanoid();
  await db.insert(schema.stories).values({
    id,
    authorUserId: opts.authorUserId,
    slug: opts.slug ?? `s-${id.slice(0, 8).toLowerCase()}`,
    title: `Story ${opts.rating}`,
    rating: opts.rating,
    visibility: opts.visibility ?? "public",
    status: opts.status ?? "in_progress",
    publishedAt: new Date(),
  });
  return id;
}

async function insertPublishedChapter(db: Db, storyId: string): Promise<string> {
  const id = nanoid();
  await db.insert(schema.storyChapters).values({
    id,
    storyId,
    sortOrder: 0,
    title: "Chapter 1",
    bodyHtml: "<p>body text</p>",
    authorNotesHtml: "",
    contentWarnings: "",
    wordCount: 2,
    status: "published",
    publishedAt: new Date(),
  });
  return id;
}

describe("scriptorium age clamps (plan §B5)", () => {
  let db: Db;
  let app: FastifyInstance;
  let adultToken: string;
  let minorToken: string;
  let hidePrefToken: string;
  let adultId: string;
  let pgStoryId: string;
  let rStoryId: string;
  let ncStoryId: string;
  let rChapterId: string;
  /** R-rated story AUTHORED by the minor (as if a mod re-rated it). */
  let minorOwnRStoryId: string;

  before(async () => {
    ({ db } = makeTestDb());
    app = await buildStoriesApp(db);
    const adult = await createUser(db, { birthdate: ADULT_DOB });
    const minor = await createUser(db, { birthdate: MINOR_DOB });
    const hidePref = await createUser(db, { birthdate: ADULT_DOB, hideNsfw: true });
    adultId = adult.id;
    adultToken = await tokenFor(db, adult.id);
    minorToken = await tokenFor(db, minor.id);
    hidePrefToken = await tokenFor(db, hidePref.id);

    pgStoryId = await insertStory(db, { authorUserId: adult.id, rating: "PG" });
    rStoryId = await insertStory(db, { authorUserId: adult.id, rating: "R" });
    ncStoryId = await insertStory(db, { authorUserId: adult.id, rating: "NC-17" });
    rChapterId = await insertPublishedChapter(db, rStoryId);
    minorOwnRStoryId = await insertStory(db, { authorUserId: minor.id, rating: "R" });
  });

  /* ── Catalog + splash listings ─────────────────────────────────── */

  test("catalog: minor receives G/PG/PG-13 cards only", async () => {
    const r = await app.inject({ method: "GET", url: "/stories/catalog", headers: auth(minorToken) });
    assert.equal(r.statusCode, 200);
    const ratings = (r.json() as { entries: Array<{ rating: string }> }).entries.map((e) => e.rating);
    assert.ok(ratings.includes("PG"));
    assert.ok(!ratings.includes("R"));
    assert.ok(!ratings.includes("NC-17"));
  });

  test("catalog: anonymous and adults (both pref states) still see every rating", async () => {
    for (const headers of [undefined, auth(adultToken), auth(hidePrefToken)]) {
      const r = await app.inject({ method: "GET", url: "/stories/catalog", ...(headers ? { headers } : {}) });
      assert.equal(r.statusCode, 200);
      const ratings = (r.json() as { entries: Array<{ rating: string }> }).entries.map((e) => e.rating);
      assert.ok(ratings.includes("R"), "R card should list");
      assert.ok(ratings.includes("NC-17"), "NC-17 card should list");
    }
  });

  test("splash shelf: minor gets the SFW subset, anonymous the full shelf", async () => {
    const asMinor = await app.inject({ method: "GET", url: "/stories/splash", headers: auth(minorToken) });
    const minorRatings = (asMinor.json() as { entries: Array<{ rating: string }> }).entries.map((e) => e.rating);
    assert.ok(!minorRatings.includes("R") && !minorRatings.includes("NC-17"));
    const asAnon = await app.inject({ method: "GET", url: "/stories/splash" });
    const anonRatings = (asAnon.json() as { entries: Array<{ rating: string }> }).entries.map((e) => e.rating);
    assert.ok(anonRatings.includes("R") && anonRatings.includes("NC-17"));
  });

  /* ── Story + chapter open (HARD, no owner bypass) ──────────────── */

  test("story open: minor gets the rating stub (no sign-in CTA), not the body", async () => {
    const r = await app.inject({ method: "GET", url: `/stories/${rStoryId}`, headers: auth(minorToken) });
    assert.equal(r.statusCode, 200);
    const j = r.json() as { private?: true; reason?: string; requiresAuth?: boolean };
    assert.equal(j.private, true);
    assert.equal(j.reason, "rating");
    assert.equal(j.requiresAuth, false);
  });

  test("story open: minor reads PG normally; hide-pref adult still opens R (HARD tier)", async () => {
    const pg = await app.inject({ method: "GET", url: `/stories/${pgStoryId}`, headers: auth(minorToken) });
    assert.equal(pg.statusCode, 200);
    assert.ok("story" in (pg.json() as Record<string, unknown>));
    const rr = await app.inject({ method: "GET", url: `/stories/${rStoryId}`, headers: auth(hidePrefToken) });
    assert.equal(rr.statusCode, 200);
    assert.ok("story" in (rr.json() as Record<string, unknown>));
  });

  test("story open: anonymous behavior unchanged (R readable, NC-17 login stub)", async () => {
    const rOpen = await app.inject({ method: "GET", url: `/stories/${rStoryId}` });
    assert.equal(rOpen.statusCode, 200);
    assert.ok("story" in (rOpen.json() as Record<string, unknown>));
    const nc = await app.inject({ method: "GET", url: `/stories/${ncStoryId}` });
    const j = nc.json() as { private?: true; reason?: string; requiresAuth?: boolean };
    assert.equal(j.private, true);
    assert.equal(j.reason, "rating");
    assert.equal(j.requiresAuth, true);
  });

  test("story open: a minor AUTHOR of an R story is blocked too (no bypass)", async () => {
    const r = await app.inject({ method: "GET", url: `/stories/${minorOwnRStoryId}`, headers: auth(minorToken) });
    assert.equal(r.statusCode, 200);
    const j = r.json() as { private?: true; reason?: string };
    assert.equal(j.private, true);
    assert.equal(j.reason, "rating");
  });

  test("chapter read: minor blocked on the R chapter, adult reads it", async () => {
    const blocked = await app.inject({
      method: "GET",
      url: `/stories/${rStoryId}/chapters/${rChapterId}`,
      headers: auth(minorToken),
    });
    assert.equal(blocked.statusCode, 403);
    assert.equal((blocked.json() as { reason?: string }).reason, "rating");
    const ok = await app.inject({
      method: "GET",
      url: `/stories/${rStoryId}/chapters/${rChapterId}`,
      headers: auth(adultToken),
    });
    assert.equal(ok.statusCode, 200);
    assert.match((ok.json() as { bodyHtml: string }).bodyHtml, /body text/);
  });

  /* ── Authoring clamp ───────────────────────────────────────────── */

  test("create: minor cannot rate a new story R or NC-17; SFW tiers stay open", async () => {
    for (const rating of ["R", "NC-17"]) {
      const r = await app.inject({
        method: "POST",
        url: "/stories",
        headers: auth(minorToken),
        payload: { title: `Blocked ${rating}`, rating },
      });
      assert.equal(r.statusCode, 400);
      assert.match((r.json() as { error: string }).error, /adults only/);
    }
    const ok = await app.inject({
      method: "POST",
      url: "/stories",
      headers: auth(minorToken),
      payload: { title: "Fine", rating: "PG-13" },
    });
    assert.equal(ok.statusCode, 201);
  });

  test("create: adults keep the full rating range", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/stories",
      headers: auth(adultToken),
      payload: { title: "Adult NC", rating: "NC-17" },
    });
    assert.equal(r.statusCode, 201);
  });

  test("update: minor cannot raise a rating to R/NC-17, lowering stays open", async () => {
    // The minor's own R story: raising to NC-17 rejected, lowering to PG fine.
    const up = await app.inject({
      method: "PATCH",
      url: `/stories/${minorOwnRStoryId}`,
      headers: auth(minorToken),
      payload: { rating: "NC-17" },
    });
    assert.equal(up.statusCode, 400);
    assert.match((up.json() as { error: string }).error, /adults only/);
    const down = await app.inject({
      method: "PATCH",
      url: `/stories/${minorOwnRStoryId}`,
      headers: auth(minorToken),
      payload: { rating: "PG" },
    });
    assert.equal(down.statusCode, 200);
  });

  test("update: adult author can set R (regression)", async () => {
    const r = await app.inject({
      method: "PATCH",
      url: `/stories/${pgStoryId}`,
      headers: auth(adultToken),
      payload: { rating: "R" },
    });
    assert.equal(r.statusCode, 200);
    // Restore for the other assertions that expect a PG card in lists.
    const back = await app.inject({
      method: "PATCH",
      url: `/stories/${pgStoryId}`,
      headers: auth(adultToken),
      payload: { rating: "PG" },
    });
    assert.equal(back.statusCode, 200);
  });

  test("stories cannot link an 18+ world for a minor caller", async () => {
    const worldId = nanoid();
    await db.insert(schema.worlds).values({
      id: worldId,
      ownerUserId: adultId,
      slug: `w-${worldId.slice(0, 8).toLowerCase()}`,
      name: "Adult world",
      visibility: "open",
      isNsfw: true,
    });
    const blocked = await app.inject({
      method: "POST",
      url: "/stories",
      headers: auth(minorToken),
      payload: { title: "Linked", linkedWorldId: worldId },
    });
    assert.equal(blocked.statusCode, 400);
    const ok = await app.inject({
      method: "POST",
      url: "/stories",
      headers: auth(adultToken),
      payload: { title: "Linked fine", linkedWorldId: worldId },
    });
    assert.equal(ok.statusCode, 201);
  });

  test("legacy accounts (null birthdate) stay adult end-to-end", async () => {
    const legacy = await createUser(db, { birthdate: null });
    const legacyToken = await tokenFor(db, legacy.id);
    const r = await app.inject({ method: "GET", url: `/stories/${rStoryId}`, headers: auth(legacyToken) });
    assert.equal(r.statusCode, 200);
    assert.ok("story" in (r.json() as Record<string, unknown>));
  });
});
