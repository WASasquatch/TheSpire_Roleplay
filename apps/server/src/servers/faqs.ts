/**
 * Per-server FAQ admin (Multi-Server Lift — the "Admin Partition").
 *
 * The server-scoped twin of admin/faqs.ts's global FAQ CRUD. A server owner/mod
 * (holding the granular `manage_faqs` key) curates THIS server's help entries
 * inside the Server Admin console — never the platform-wide FAQ list.
 *
 * SCOPE — `faqs.server_id` is the entire seam (migration 0278f). NULL = the
 * platform FAQ (owned by admin/faqs.ts); a `server_id` scopes per-community
 * help content. Every read/write below is WHERE `faqs.server_id = :id` and
 * stamps `server_id = :id` on create, so a server mod can never see, edit, or
 * delete the platform FAQ or another server's entries. There is NO separate
 * server_faqs table.
 *
 * Slugs: the `faqs_slug_uq` index is GLOBAL (lowercase), so a per-server slug
 * still has to be unique across the whole install — we honor that here, but the
 * uniqueness check is scoped to this server's own rows for the duplicate
 * message, then the column's UNIQUE constraint is the cross-server backstop.
 *
 * FLAG-OFF is byte-identical to today: every route 404s when
 * `areServersEnabled` is false, exactly like a feature that was never wired up.
 * Per-server gating runs through `serverAuthority`/`serverCan` (the one powers
 * resolver), imported inline because this module is standalone — it is
 * registered alongside routes/servers.ts from the same index.ts.
 *
 * Routes (all under /servers/:id/faqs):
 *   GET    /servers/:id/faqs                  — this server's FAQ entries
 *   GET    /servers/:id/faqs/slug-availability — live editor slug check
 *   POST   /servers/:id/faqs                  — create (stamps server_id)
 *   PATCH  /servers/:id/faqs/:faqId           — edit
 *   DELETE /servers/:id/faqs/:faqId           — delete
 *   PATCH  /servers/:id/faqs/reorder          — bulk sort_order update
 */
import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { and, asc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  FAQ_ANSWER_MAX,
  FAQ_CATEGORY_MAX,
  FAQ_QUESTION_MAX,
  markdownToHtml,
  normalizeFaqSlug,
  type ClientToServerEvents,
  type FaqAdminEntry,
  type ServerToClientEvents,
} from "@thekeep/shared";
import { auditLog, faqs } from "../db/schema.js";
import { getSessionUser } from "../routes/auth.js";
import { areServersEnabled, getSettings } from "../settings.js";
import { sanitizeBio } from "../auth/html.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

const createSchema = z
  .object({
    slug: z.string().min(3).max(40),
    // The editor sends the Markdown SOURCE; the server converts + sanitizes to
    // HTML (so the public read path is one shape) and stores both, so
    // re-editing round-trips the source instead of double-wrapping the HTML.
    question: z.string().min(1).max(FAQ_QUESTION_MAX),
    answerMarkdown: z.string().min(1).max(FAQ_ANSWER_MAX),
    category: z.string().max(FAQ_CATEGORY_MAX).nullable().optional(),
    sortOrder: z.number().int().min(-1000).max(1000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const updateSchema = createSchema.partial();

const reorderSchema = z
  .object({ order: z.array(z.string()).max(500) })
  .strict();

function wireFaq(r: typeof faqs.$inferSelect): FaqAdminEntry {
  return {
    id: r.id,
    slug: r.slug,
    question: r.question,
    answerHtml: r.answerHtml,
    answerMarkdown: r.answerMarkdown,
    category: r.category,
    sortOrder: r.sortOrder,
    enabled: r.enabled,
    createdByUserId: r.createdByUserId,
    createdAt: +r.createdAt,
    updatedAt: +r.updatedAt,
  };
}

export async function registerServerFaqRoutes(
  app: FastifyInstance,
  db: Db,
  _io: Io,
): Promise<void> {
  /** Case-insensitive slug-taken check scoped to THIS server, optionally
   *  excluding one row (the edit case). The global UNIQUE index is the
   *  cross-server backstop; this is the friendly per-server message. */
  async function slugTaken(serverId: string, slug: string, exceptId?: string): Promise<boolean> {
    const row = (await db
      .select({ id: faqs.id })
      .from(faqs)
      .where(
        exceptId
          ? sql`lower(${faqs.slug}) = ${slug} AND ${faqs.serverId} = ${serverId} AND ${faqs.id} <> ${exceptId}`
          : sql`lower(${faqs.slug}) = ${slug} AND ${faqs.serverId} = ${serverId}`,
      )
      .limit(1))[0];
    return !!row;
  }

  /** Best-effort server-scoped audit row (mirrors auditServer in servers.ts).
   *  Stamps server_id so the entry lands in THIS server's Mod Log; a logging
   *  failure never fails the action it records. */
  async function audit(serverId: string, actorUserId: string, action: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      await db.insert(auditLog).values({
        id: nanoid(),
        serverId,
        actorUserId,
        action,
        metadataJson: JSON.stringify(metadata),
      });
    } catch {
      /* swallow — best-effort, exactly like recordAudit */
    }
  }

  app.get<{ Params: { id: string } }>("/servers/:id/faqs", async (req, reply) => {
    if (!areServersEnabled(await getSettings(db))) { reply.code(404); return { error: "not found" }; }
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const { serverAuthority, serverCan } = await import("../servers/authority.js");
    const a = await serverAuthority(db, me, req.params.id);
    if (!a.server) { reply.code(404); return { error: "no server" }; }
    if (!serverCan(a, "manage_faqs")) { reply.code(403); return { error: "forbidden" }; }

    const rows = await db
      .select()
      .from(faqs)
      .where(eq(faqs.serverId, req.params.id))
      .orderBy(asc(faqs.sortOrder), asc(faqs.createdAt));
    return { faqs: rows.map(wireFaq) };
  });

  app.get<{ Params: { id: string }; Querystring: { slug?: string; exceptId?: string } }>(
    "/servers/:id/faqs/slug-availability",
    async (req, reply) => {
      if (!areServersEnabled(await getSettings(db))) { reply.code(404); return { error: "not found" }; }
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const { serverAuthority, serverCan } = await import("../servers/authority.js");
      const a = await serverAuthority(db, me, req.params.id);
      if (!a.server) { reply.code(404); return { error: "no server" }; }
      if (!serverCan(a, "manage_faqs")) { reply.code(403); return { error: "forbidden" }; }

      const norm = normalizeFaqSlug(req.query.slug ?? "");
      if (!norm) return { available: false, reason: "invalid" };
      const taken = await slugTaken(req.params.id, norm, req.query.exceptId);
      return { available: !taken, slug: norm, reason: taken ? "taken" : null };
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/faqs", async (req, reply) => {
    if (!areServersEnabled(await getSettings(db))) { reply.code(404); return { error: "not found" }; }
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const { serverAuthority, serverCan } = await import("../servers/authority.js");
    const a = await serverAuthority(db, me, req.params.id);
    if (!a.server) { reply.code(404); return { error: "no server" }; }
    if (!serverCan(a, "manage_faqs")) { reply.code(403); return { error: "forbidden" }; }

    let body: z.infer<typeof createSchema>;
    try { body = createSchema.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const slug = normalizeFaqSlug(body.slug);
    if (!slug) { reply.code(400); return { error: "Slug must be 3-40 chars: lowercase letters, numbers, underscore (and not reserved)." }; }
    if (await slugTaken(req.params.id, slug)) { reply.code(409); return { error: "That slug is already taken." }; }

    const id = nanoid();
    try {
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
        serverId: req.params.id,
      });
    } catch {
      // The slug UNIQUE index is GLOBAL; a collision with another server's (or
      // the platform's) entry lands here even though the per-server check passed.
      reply.code(409); return { error: "That slug is already taken." };
    }
    await audit(req.params.id, me.id, "server_faq_create", { id, slug });
    return { id, slug };
  });

  app.patch<{ Params: { id: string; faqId: string }; Body: unknown }>(
    "/servers/:id/faqs/:faqId",
    async (req, reply) => {
      if (!areServersEnabled(await getSettings(db))) { reply.code(404); return { error: "not found" }; }
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const { serverAuthority, serverCan } = await import("../servers/authority.js");
      const a = await serverAuthority(db, me, req.params.id);
      if (!a.server) { reply.code(404); return { error: "no server" }; }
      if (!serverCan(a, "manage_faqs")) { reply.code(403); return { error: "forbidden" }; }

      let body: z.infer<typeof updateSchema>;
      try { body = updateSchema.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      // Scope the lookup to this server's rows — a mod can never reach the
      // platform FAQ or another server's entry by id.
      const existing = (await db
        .select()
        .from(faqs)
        .where(and(eq(faqs.id, req.params.faqId), eq(faqs.serverId, req.params.id)))
        .limit(1))[0];
      if (!existing) { reply.code(404); return { error: "not found" }; }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.slug !== undefined) {
        const slug = normalizeFaqSlug(body.slug);
        if (!slug) { reply.code(400); return { error: "Invalid slug." }; }
        if (await slugTaken(req.params.id, slug, req.params.faqId)) { reply.code(409); return { error: "That slug is already taken." }; }
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

      try {
        await db.update(faqs)
          .set(patch)
          .where(and(eq(faqs.id, req.params.faqId), eq(faqs.serverId, req.params.id)));
      } catch {
        reply.code(409); return { error: "That slug is already taken." };
      }
      await audit(req.params.id, me.id, "server_faq_update", { id: req.params.faqId, keys: Object.keys(body) });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; faqId: string } }>(
    "/servers/:id/faqs/:faqId",
    async (req, reply) => {
      if (!areServersEnabled(await getSettings(db))) { reply.code(404); return { error: "not found" }; }
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const { serverAuthority, serverCan } = await import("../servers/authority.js");
      const a = await serverAuthority(db, me, req.params.id);
      if (!a.server) { reply.code(404); return { error: "no server" }; }
      if (!serverCan(a, "manage_faqs")) { reply.code(403); return { error: "forbidden" }; }

      // server_id in the WHERE so a delete can only touch this server's rows.
      await db.delete(faqs)
        .where(and(eq(faqs.id, req.params.faqId), eq(faqs.serverId, req.params.id)));
      await audit(req.params.id, me.id, "server_faq_delete", { id: req.params.faqId });
      return { ok: true };
    },
  );

  /**
   * PATCH /servers/:id/faqs/reorder — bulk-assign sort_order from a list of
   * faq ids (the order they should appear). Each UPDATE is scoped to this
   * server's rows, so an id that isn't ours is a silent no-op rather than a way
   * to renumber the platform FAQ.
   */
  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/servers/:id/faqs/reorder",
    async (req, reply) => {
      if (!areServersEnabled(await getSettings(db))) { reply.code(404); return { error: "not found" }; }
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const { serverAuthority, serverCan } = await import("../servers/authority.js");
      const a = await serverAuthority(db, me, req.params.id);
      if (!a.server) { reply.code(404); return { error: "no server" }; }
      if (!serverCan(a, "manage_faqs")) { reply.code(403); return { error: "forbidden" }; }

      let body: z.infer<typeof reorderSchema>;
      try { body = reorderSchema.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      db.transaction((tx) => {
        body.order.forEach((faqId, idx) => {
          tx.update(faqs)
            .set({ sortOrder: idx, updatedAt: new Date() })
            .where(and(eq(faqs.id, faqId), eq(faqs.serverId, req.params.id)))
            .run();
        });
      });
      await audit(req.params.id, me.id, "server_faq_reorder", { count: body.order.length });
      return { ok: true };
    },
  );
}
