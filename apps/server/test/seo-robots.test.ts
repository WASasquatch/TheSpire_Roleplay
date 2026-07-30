import "./helpers/env.js"; // MUST be first - sets SQLITE_PATH before the db singleton loads
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { renderRobotsTxt } from "../src/seo.js";
import { updateSettings } from "../src/settings.js";
import { createUser, makeTestDb } from "./helpers/harness.js";

/**
 * robots.txt policy (the "cite me, don't train on me" stance behind the
 * front-page privacy slide). Pinned behaviors:
 *
 *   1. Normal search engines ride the wildcard Allow (we never name, and never
 *      Disallow, Googlebot / Bingbot).
 *   2. AI TRAINING / dataset crawlers each get an explicit Disallow.
 *   3. AI SEARCH / retrieval bots each get an explicit Allow (live citation,
 *      not training).
 *   4. The master indexing switch off collapses everything to a blanket
 *      Disallow and drops the sitemap line.
 */

const ORIGIN = "https://thespire.test";

/** Assert `txt` contains the exact two-line stanza for `agent` with `rule`. */
function hasStanza(txt: string, agent: string, rule: "Allow" | "Disallow"): boolean {
  return txt.includes(`User-agent: ${agent}\n${rule}: /`);
}

describe("robots.txt", () => {
  test("blocks AI training crawlers, allows AI search + normal indexing", async () => {
    const { db } = makeTestDb();
    const txt = await renderRobotsTxt(db, ORIGIN);

    // Wildcard welcomes ordinary search engines.
    assert.ok(txt.startsWith("User-agent: *\nAllow: /"), "wildcard Allow leads the file");
    // We never single out traditional indexers (they ride the wildcard).
    assert.ok(!txt.includes("Googlebot"), "Googlebot is not named");
    assert.ok(!txt.includes("Bingbot"), "Bingbot is not named");

    // Training / dataset harvesters are refused.
    for (const agent of ["GPTBot", "ClaudeBot", "Google-Extended", "CCBot", "Bytespider", "meta-externalagent", "Applebot-Extended"]) {
      assert.ok(hasStanza(txt, agent, "Disallow"), `${agent} is disallowed`);
      assert.ok(!hasStanza(txt, agent, "Allow"), `${agent} is not allowed`);
    }

    // AI answer-engine / retrieval bots are allowed (cite, don't train).
    for (const agent of ["OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "Perplexity-User"]) {
      assert.ok(hasStanza(txt, agent, "Allow"), `${agent} is allowed`);
      assert.ok(!hasStanza(txt, agent, "Disallow"), `${agent} is not disallowed`);
    }

    assert.ok(txt.includes(`Sitemap: ${ORIGIN}/sitemap.xml`), "points at the sitemap");
  });

  test("master indexing switch off serves a blanket disallow", async () => {
    const { db } = makeTestDb();
    const admin = await createUser(db, { role: "masteradmin" });
    await updateSettings(db, { searchIndexingEnabled: false }, admin.id);

    const txt = await renderRobotsTxt(db, ORIGIN);
    assert.equal(txt, "User-agent: *\nDisallow: /\n");
    // No per-agent stanzas or sitemap advertised while de-indexed.
    assert.ok(!txt.includes("GPTBot"));
    assert.ok(!txt.includes("Sitemap:"));
  });
});
