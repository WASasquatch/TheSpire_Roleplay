import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";

/**
 * `moby` is a CommonJS module that wraps the public-domain Moby
 * Thesaurus + Open Office Thesaurus data. It exposes a synchronous
 * `.search(word)` returning an array of synonyms (which may include
 * short phrases). No network, no key, no rate limit — the data
 * ships inside the package and `.search` is a hash lookup.
 *
 * We load it via `createRequire(import.meta.url)` because the app
 * runs as ESM and Node won't let plain `require` through in that
 * context. A static `import moby from "moby"` works in some
 * setups but breaks under tsx + exactOptionalPropertyTypes on the
 * CJS interop — createRequire is the most predictable shim.
 */
const moby = createRequire(import.meta.url)("moby") as {
  search: (word: string) => string[];
  reverseSearch?: (word: string) => string[];
};

/**
 * Maximum synonyms returned per lookup. Moby can return 500+ for
 * common words (`good`, `bad`); the autocomplete-style popup on the
 * client only shows a small list at a time, so capping the wire
 * payload keeps the response small without hurting UX.
 */
const MAX_RESULTS = 50;

/**
 * Word shape we accept. Letters + apostrophe + hyphen, 1–40 chars.
 * Bounded so a malicious caller can't spam queries with megabyte
 * strings, and pre-filtered so we don't waste a hash lookup on
 * obviously-not-a-word input (numbers, punctuation, etc.).
 */
const WORD_RX = /^[a-zA-Z][a-zA-Z'-]{0,39}$/;

/**
 * `/thesaurus?word=<word>` — synonyms lookup powered by the public-
 * domain Moby Thesaurus + Open Office Thesaurus data. Auth-gated
 * so the lookup table stays a benefit of being signed in (and so
 * an unauthenticated attacker can't fingerprint the install or
 * scrape the dataset).
 *
 * Response shape:
 *   { word: string, synonyms: string[] }
 *
 * Unknown word → 200 with empty synonyms (avoids a 404-loop on the
 * client as the user types into the selection).
 */
export async function registerThesaurusRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // 60/min/IP is generous for a feature that's triggered by text
  // selection — even a fast-typing user won't hit it. Same bucket
  // as /auth/me so the rate-limit plugin's metrics stay tidy.
  const thesaurusLimit = {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  } as const;

  app.get<{ Querystring: { word?: string } }>("/thesaurus", thesaurusLimit, async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    const raw = (req.query.word ?? "").trim().toLowerCase();
    if (!raw || !WORD_RX.test(raw)) {
      return { word: raw, synonyms: [] };
    }
    let synonyms: string[] = [];
    try {
      const list = moby.search(raw);
      synonyms = Array.isArray(list) ? list.slice(0, MAX_RESULTS) : [];
    } catch {
      // Moby's search is defensive but we don't want a thesaurus
      // hiccup to bubble into a 500.
      synonyms = [];
    }
    return { word: raw, synonyms };
  });
}
