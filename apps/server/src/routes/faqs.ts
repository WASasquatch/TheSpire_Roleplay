import type { FastifyInstance } from "fastify";
import { asc, eq, sql } from "drizzle-orm";
import { faqs } from "../db/schema.js";
import type { Db } from "../db/index.js";

/**
 * Public FAQ read endpoints. Unauthenticated — FAQ entries are public site
 * content a mod can link to anyone (including logged-out visitors). Only
 * ENABLED rows are exposed; drafts stay invisible. Mounted under `/api/` so the
 * JSON routes don't shadow the `/faq/:slug` + `/faqs` SPA pages.
 *
 * Order is `sort_order ASC, created_at ASC` (admin-chosen, insertion tiebreak).
 */
export async function registerFaqRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get("/api/faqs", async () => {
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
      .where(eq(faqs.enabled, true))
      .orderBy(asc(faqs.sortOrder), asc(faqs.createdAt));
    return { faqs: rows };
  });

  app.get<{ Params: { slug: string } }>("/api/faqs/:slug", async (req, reply) => {
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
      .where(sql`lower(${faqs.slug}) = ${req.params.slug.toLowerCase()} AND ${faqs.enabled} = 1`)
      .limit(1))[0];
    if (!row) { reply.code(404); return { error: "not found" }; }
    return { faq: row };
  });
}
