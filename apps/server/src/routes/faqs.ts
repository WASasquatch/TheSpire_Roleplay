import type { FastifyInstance } from "fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import { faqs } from "../db/schema.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import type { Db } from "../db/index.js";

/**
 * Public FAQ read endpoints. Unauthenticated — FAQ entries are public site
 * content a mod can link to anyone (including logged-out visitors). Only
 * ENABLED rows are exposed; drafts stay invisible. Mounted under `/api/` so the
 * JSON routes don't shadow the `/faq/:slug` + `/faqs` SPA pages.
 *
 * FAQs are PER-SERVER (faqs.serverId). The viewer scopes to the requested
 * `?serverId` (the in-app FAQ link passes the active server) and falls back to
 * the default/system server when none is given (a bare/shared link, or a
 * logged-out visitor). So each server shows its OWN FAQ, and The Spire's FAQ is
 * the default. Order is `sort_order ASC, created_at ASC`.
 *
 * This is a pure DB read: the platform's default FAQ set is SEEDED into the
 * `faqs` table on boot (`ensureDefaultFaqs` in seed.ts) as real, admin-editable
 * rows — so there is no display fallback here. An empty result means the admin
 * genuinely has no (enabled) FAQ, and "delete every FAQ" stays honored.
 */
export async function registerFaqRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get<{ Querystring: { serverId?: string } }>("/api/faqs", async (req) => {
    const serverId = req.query.serverId || DEFAULT_SERVER_ID;
    const rows = await db
      .select({
        id: faqs.id,
        slug: faqs.slug,
        question: faqs.question,
        answerHtml: faqs.answerHtml,
        category: faqs.category,
        sortOrder: faqs.sortOrder,
      })
      .from(faqs)
      .where(and(eq(faqs.enabled, true), eq(faqs.serverId, serverId)))
      .orderBy(asc(faqs.sortOrder), asc(faqs.createdAt));
    return { faqs: rows };
  });

  app.get<{ Params: { slug: string }; Querystring: { serverId?: string } }>("/api/faqs/:slug", async (req, reply) => {
    // Slugs are unique per server, so the slug lookup must be server-scoped too.
    const serverId = req.query.serverId || DEFAULT_SERVER_ID;
    const row = (await db
      .select({
        id: faqs.id,
        slug: faqs.slug,
        question: faqs.question,
        answerHtml: faqs.answerHtml,
        category: faqs.category,
        sortOrder: faqs.sortOrder,
      })
      .from(faqs)
      .where(sql`lower(${faqs.slug}) = ${req.params.slug.toLowerCase()} AND ${faqs.enabled} = 1 AND ${faqs.serverId} = ${serverId}`)
      .limit(1))[0];
    if (!row) { reply.code(404); return { error: "not found" }; }
    return { faq: row };
  });
}
