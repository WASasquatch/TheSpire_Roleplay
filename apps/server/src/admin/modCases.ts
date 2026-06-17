import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { PermissionKey, Role } from "@thekeep/shared";
import { modCases } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { requireSessionPermission } from "../auth/requireSessionPermission.js";
import { recordAudit } from "../audit.js";
import { resolveIdentityArg } from "../commands/identityArg.js";

interface SessionUserCtx {
  id: string;
  role: Role;
}

const partyMax = 120;
const createSchema = z.object({
  nature: z.string().min(1).max(80),
  complaintBody: z.string().min(1).max(8000),
  /** Freehand text or an `@id:`/`@cid:` token; resolved to a link if it matches. */
  reporter: z.string().max(partyMax).optional(),
  subject: z.string().max(partyMax).optional(),
  resolution: z.string().max(8000).optional(),
  status: z.enum(["open", "resolved"]).optional(),
  relatedReportId: z.string().nullable().optional(),
}).strict();

const updateSchema = createSchema.partial();

interface ResolvedParty {
  text: string | null;
  userId: string | null;
  characterId: string | null;
  label: string | null;
}

/**
 * Turn a free-text reporter/subject input into a stored party. We always keep
 * the raw text; if it resolves to exactly one identity (a token, or a name
 * that maps to a single account/character) we ALSO store the link + a snapshot
 * label so the log stays queryable by person. Ambiguous / no-match inputs stay
 * pure freehand — an admin form shouldn't force token disambiguation.
 */
async function resolveParty(db: Db, raw: string | undefined): Promise<ResolvedParty> {
  const text = raw?.trim() || null;
  if (!text) return { text: null, userId: null, characterId: null, label: null };
  const r = await resolveIdentityArg(db, text);
  if (r.kind === "unique") {
    return { text, userId: r.target.userId, characterId: r.target.characterId, label: r.target.displayName };
  }
  return { text, userId: null, characterId: null, label: null };
}

function wireCase(r: typeof modCases.$inferSelect) {
  return {
    id: r.id,
    nature: r.nature,
    complaintBody: r.complaintBody,
    resolution: r.resolution,
    status: r.status,
    reporterText: r.reporterText,
    reporterUserId: r.reporterUserId,
    reporterCharacterId: r.reporterCharacterId,
    reporterLabel: r.reporterLabel,
    subjectText: r.subjectText,
    subjectUserId: r.subjectUserId,
    subjectCharacterId: r.subjectCharacterId,
    subjectLabel: r.subjectLabel,
    relatedReportId: r.relatedReportId,
    createdByUserId: r.createdByUserId,
    createdAt: +r.createdAt,
    updatedAt: +r.updatedAt,
    resolvedAt: r.resolvedAt ? +r.resolvedAt : null,
  };
}

/**
 * Moderation case-log CRUD. Gated by the granular permission system:
 *   - `view_admin_mod_cases`, tab visibility + read
 *   - `manage_mod_cases`, create / edit / resolve / delete
 * Seeded to `mod` + `admin` by migration 0254; masteradmin bypasses.
 */
export async function registerAdminModCaseRoutes(
  app: FastifyInstance,
  deps: { db: Db },
): Promise<void> {
  const { db } = deps;
  const requirePermission = (req: FastifyRequest, reply: FastifyReply, key: PermissionKey) =>
    requireSessionPermission(req, reply, key, db);
  const sessionOf = (req: FastifyRequest) =>
    (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;

  app.get<{ Querystring: { status?: string } }>("/admin/mod-cases", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_mod_cases"))) return;
    const status = req.query.status === "open" || req.query.status === "resolved" ? req.query.status : null;
    const rows = await db
      .select()
      .from(modCases)
      .where(status ? eq(modCases.status, status) : undefined)
      .orderBy(desc(modCases.createdAt));
    return { cases: rows.map(wireCase) };
  });

  app.post<{ Body: unknown }>("/admin/mod-cases", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_mod_cases"))) return;
    const body = createSchema.parse(req.body);
    const me = sessionOf(req);
    const reporter = await resolveParty(db, body.reporter);
    const subject = await resolveParty(db, body.subject);
    const id = nanoid();
    const resolved = body.status === "resolved";
    await db.insert(modCases).values({
      id,
      nature: body.nature,
      complaintBody: body.complaintBody,
      resolution: body.resolution ?? null,
      status: body.status ?? "open",
      reporterText: reporter.text,
      reporterUserId: reporter.userId,
      reporterCharacterId: reporter.characterId,
      reporterLabel: reporter.label,
      subjectText: subject.text,
      subjectUserId: subject.userId,
      subjectCharacterId: subject.characterId,
      subjectLabel: subject.label,
      relatedReportId: body.relatedReportId ?? null,
      createdByUserId: me.id,
      resolvedAt: resolved ? new Date() : null,
    });
    await recordAudit(db, { actorUserId: me.id, action: "mod_case_create", metadata: { id } });
    return { id };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/mod-cases/:id", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_mod_cases"))) return;
    const body = updateSchema.parse(req.body);
    const existing = (await db.select().from(modCases).where(eq(modCases.id, req.params.id)).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.nature !== undefined) patch.nature = body.nature;
    if (body.complaintBody !== undefined) patch.complaintBody = body.complaintBody;
    if (body.resolution !== undefined) patch.resolution = body.resolution;
    if (body.relatedReportId !== undefined) patch.relatedReportId = body.relatedReportId;
    if (body.reporter !== undefined) {
      const p = await resolveParty(db, body.reporter);
      patch.reporterText = p.text; patch.reporterUserId = p.userId;
      patch.reporterCharacterId = p.characterId; patch.reporterLabel = p.label;
    }
    if (body.subject !== undefined) {
      const p = await resolveParty(db, body.subject);
      patch.subjectText = p.text; patch.subjectUserId = p.userId;
      patch.subjectCharacterId = p.characterId; patch.subjectLabel = p.label;
    }
    if (body.status !== undefined) {
      patch.status = body.status;
      // Stamp the resolution time on close; clear it if reopened.
      patch.resolvedAt = body.status === "resolved" ? new Date() : null;
    }
    await db.update(modCases).set(patch).where(eq(modCases.id, req.params.id));
    const me = sessionOf(req);
    await recordAudit(db, {
      actorUserId: me.id,
      action: "mod_case_update",
      metadata: { id: req.params.id, keys: Object.keys(body) },
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/admin/mod-cases/:id", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_mod_cases"))) return;
    await db.delete(modCases).where(eq(modCases.id, req.params.id));
    const me = sessionOf(req);
    await recordAudit(db, { actorUserId: me.id, action: "mod_case_delete", metadata: { id: req.params.id } });
    return { ok: true };
  });
}
