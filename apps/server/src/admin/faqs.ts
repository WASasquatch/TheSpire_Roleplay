import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { asc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { PermissionKey, Role } from "@thekeep/shared";
import {
  FAQ_ANSWER_MAX,
  FAQ_CATEGORY_MAX,
  FAQ_QUESTION_MAX,
  markdownToHtml,
  normalizeFaqSlug,
} from "@thekeep/shared";
import { faqs } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { requireSessionPermission } from "../auth/requireSessionPermission.js";
import { sanitizeBio } from "../auth/html.js";
import { recordAudit } from "../audit.js";

interface SessionUserCtx {
  id: string;
  role: Role;
}

const createSchema = z.object({
  slug: z.string().min(3).max(40),
  question: z.string().min(1).max(FAQ_QUESTION_MAX),
  // The editor sends the Markdown SOURCE; the server converts + sanitizes to
  // HTML (so the public read path is one shape) and stores both, so re-editing
  // round-trips the source instead of double-wrapping the rendered HTML.
  answerMarkdown: z.string().min(1).max(FAQ_ANSWER_MAX),
  category: z.string().max(FAQ_CATEGORY_MAX).nullable().optional(),
  sortOrder: z.number().int().min(-1000).max(1000).optional(),
  enabled: z.boolean().optional(),
}).strict();

const updateSchema = createSchema.partial();

/** Case-insensitive slug uniqueness check, optionally excluding one row (edit). */
async function slugTaken(db: Db, slug: string, exceptId?: string): Promise<boolean> {
  const row = (await db
    .select({ id: faqs.id })
    .from(faqs)
    .where(exceptId
      ? sql`lower(${faqs.slug}) = ${slug} AND ${faqs.id} <> ${exceptId}`
      : sql`lower(${faqs.slug}) = ${slug}`)
    .limit(1))[0];
  return !!row;
}

function wireFaq(r: typeof faqs.$inferSelect) {
  return {
    id: r.id,
    slug: r.slug,
    question: r.question,
    answerMarkdown: r.answerMarkdown,
    answerHtml: r.answerHtml,
    category: r.category,
    sortOrder: r.sortOrder,
    enabled: r.enabled,
    createdByUserId: r.createdByUserId,
    createdAt: +r.createdAt,
    updatedAt: +r.updatedAt,
  };
}

/**
 * FAQ admin CRUD. Gated by `view_admin_faqs` (read) / `manage_faqs` (write),
 * seeded to `admin` by migration 0255. Answer HTML is sanitized with the same
 * allow-list as bios before storage; the public read path is one shape.
 */
export async function registerAdminFaqRoutes(
  app: FastifyInstance,
  deps: { db: Db },
): Promise<void> {
  const { db } = deps;
  const requirePermission = (req: FastifyRequest, reply: FastifyReply, key: PermissionKey) =>
    requireSessionPermission(req, reply, key, db);
  const sessionOf = (req: FastifyRequest) =>
    (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;

  app.get("/admin/faqs", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_faqs"))) return;
    const rows = await db.select().from(faqs).orderBy(asc(faqs.sortOrder), asc(faqs.createdAt));
    return { faqs: rows.map(wireFaq) };
  });

  // Real-time slug-availability check for the editor.
  app.get<{ Querystring: { slug?: string; exceptId?: string } }>("/admin/faqs/slug-availability", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_faqs"))) return;
    const norm = normalizeFaqSlug(req.query.slug ?? "");
    if (!norm) return { available: false, reason: "invalid" };
    const taken = await slugTaken(db, norm, req.query.exceptId);
    return { available: !taken, slug: norm, reason: taken ? "taken" : null };
  });

  app.post<{ Body: unknown }>("/admin/faqs", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_faqs"))) return;
    const body = createSchema.parse(req.body);
    const slug = normalizeFaqSlug(body.slug);
    if (!slug) { reply.code(400); return { error: "Slug must be 3–40 chars: lowercase letters, numbers, underscore (and not reserved)." }; }
    if (await slugTaken(db, slug)) { reply.code(409); return { error: "That slug is already taken." }; }
    const me = sessionOf(req);
    const id = nanoid();
    await db.insert(faqs).values({
      id,
      slug,
      question: body.question,
      answerMarkdown: body.answerMarkdown,
      answerHtml: sanitizeBio(markdownToHtml(body.answerMarkdown)),
      category: body.category ?? null,
      sortOrder: body.sortOrder ?? 0,
      enabled: body.enabled ?? true,
      createdByUserId: me.id,
    });
    await recordAudit(db, { actorUserId: me.id, action: "faq_create", metadata: { id, slug } });
    return { id, slug };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/faqs/:id", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_faqs"))) return;
    const body = updateSchema.parse(req.body);
    const existing = (await db.select().from(faqs).where(eq(faqs.id, req.params.id)).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.slug !== undefined) {
      const slug = normalizeFaqSlug(body.slug);
      if (!slug) { reply.code(400); return { error: "Invalid slug." }; }
      if (await slugTaken(db, slug, req.params.id)) { reply.code(409); return { error: "That slug is already taken." }; }
      patch.slug = slug;
    }
    if (body.question !== undefined) patch.question = body.question;
    if (body.answerMarkdown !== undefined) {
      patch.answerMarkdown = body.answerMarkdown;
      patch.answerHtml = sanitizeBio(markdownToHtml(body.answerMarkdown));
    }
    if (body.category !== undefined) patch.category = body.category;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    await db.update(faqs).set(patch).where(eq(faqs.id, req.params.id));
    const me = sessionOf(req);
    await recordAudit(db, { actorUserId: me.id, action: "faq_update", metadata: { id: req.params.id, keys: Object.keys(body) } });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/admin/faqs/:id", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_faqs"))) return;
    await db.delete(faqs).where(eq(faqs.id, req.params.id));
    const me = sessionOf(req);
    await recordAudit(db, { actorUserId: me.id, action: "faq_delete", metadata: { id: req.params.id } });
    return { ok: true };
  });
}
