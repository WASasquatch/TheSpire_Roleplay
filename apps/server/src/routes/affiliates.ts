import type { FastifyInstance, FastifyRequest } from "fastify";
import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { affiliates } from "../db/schema.js";
import { getSessionUser } from "./auth.js";
import { recordAudit } from "../audit.js";
import type { Db } from "../db/index.js";

const createBody = z.object({
  label: z.string().min(1).max(80),
  html: z.string().min(1).max(8000),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
}).strict();

const updateBody = z.object({
  label: z.string().min(1).max(80).optional(),
  html: z.string().min(1).max(8000).optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
}).strict();

interface SessionUserCtx {
  id: string;
  role: "user" | "trusted" | "mod" | "admin";
}

async function requireAdmin(req: FastifyRequest, db: Db): Promise<SessionUserCtx | null> {
  const me = await getSessionUser(req, db);
  if (!me || me.role !== "admin") return null;
  return me;
}

/**
 * Affiliate / partner / sponsor management.
 *
 * `GET /affiliates`              - public; lists ENABLED entries only.
 * `GET /admin/affiliates`        - admin; lists everything (incl. disabled).
 * `POST /admin/affiliates`       - admin create.
 * `PATCH /admin/affiliates/:id`  - admin edit.
 * `DELETE /admin/affiliates/:id` - admin delete.
 *
 * Trust posture: `html` is rendered as raw HTML on the splash so topsite
 * tracking pixels work. NEVER sanitized. Same admin-trust contract as
 * `customHeadHtml` - the admin pasting it owns the consequences.
 */
export async function registerAffiliateRoutes(app: FastifyInstance, db: Db): Promise<void> {
  /** Public list - enabled rows ordered by sortOrder then created_at. */
  app.get("/affiliates", async () => {
    const rows = await db
      .select()
      .from(affiliates)
      .where(eq(affiliates.enabled, true))
      .orderBy(asc(affiliates.sortOrder), asc(affiliates.createdAt));
    // Strip admin-only fields for the public response. `label` and
    // timestamps are internal bookkeeping; the splash only needs id + html.
    return { affiliates: rows.map((r) => ({ id: r.id, html: r.html })) };
  });

  /** Admin list - everything, with admin-only fields included for editing. */
  app.get("/admin/affiliates", async (req, reply) => {
    const me = await requireAdmin(req, db);
    if (!me) { reply.code(403); return { error: "admin only" }; }
    const rows = await db
      .select()
      .from(affiliates)
      .orderBy(asc(affiliates.sortOrder), asc(affiliates.createdAt));
    return { affiliates: rows };
  });

  app.post<{ Body: unknown }>("/admin/affiliates", async (req, reply) => {
    const me = await requireAdmin(req, db);
    if (!me) { reply.code(403); return { error: "admin only" }; }

    let body;
    try { body = createBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const id = nanoid();
    await db.insert(affiliates).values({
      id,
      label: body.label.trim(),
      html: body.html,
      enabled: body.enabled ?? true,
      sortOrder: body.sortOrder ?? 0,
    });
    await recordAudit(db, {
      actorUserId: me.id,
      action: "settings_update",
      metadata: { kind: "affiliate_create", id, label: body.label.trim() },
    });
    const row = (await db.select().from(affiliates).where(eq(affiliates.id, id)).limit(1))[0];
    reply.code(201);
    return row;
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/affiliates/:id", async (req, reply) => {
    const me = await requireAdmin(req, db);
    if (!me) { reply.code(403); return { error: "admin only" }; }

    let body;
    try { body = updateBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const existing = (await db.select().from(affiliates).where(eq(affiliates.id, req.params.id)).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }

    await db.update(affiliates).set({
      ...(body.label !== undefined ? { label: body.label.trim() } : {}),
      ...(body.html !== undefined ? { html: body.html } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      updatedAt: new Date(),
    }).where(eq(affiliates.id, existing.id));
    await recordAudit(db, {
      actorUserId: me.id,
      action: "settings_update",
      metadata: { kind: "affiliate_update", id: existing.id, keys: Object.keys(body) },
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/admin/affiliates/:id", async (req, reply) => {
    const me = await requireAdmin(req, db);
    if (!me) { reply.code(403); return { error: "admin only" }; }
    const existing = (await db.select().from(affiliates).where(eq(affiliates.id, req.params.id)).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    await db.delete(affiliates).where(eq(affiliates.id, existing.id));
    await recordAudit(db, {
      actorUserId: me.id,
      action: "settings_update",
      metadata: { kind: "affiliate_delete", id: existing.id, label: existing.label },
    });
    return { ok: true };
  });
}
