import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { PermissionKey, Role } from "@thekeep/shared";
import { messages, modCaseEvidence, modCaseUpdates, modCases, rooms, users } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { requireSessionPermission } from "../auth/requireSessionPermission.js";
import { recordAudit } from "../audit.js";
import { resolveIdentityArg } from "../commands/identityArg.js";

interface SessionUserCtx {
  id: string;
  role: Role;
}

const partyMax = 120;
const STATUSES = ["open", "in_progress", "resolved"] as const;
type CaseStatus = (typeof STATUSES)[number];

const createSchema = z.object({
  nature: z.string().min(1).max(80),
  /** "case" = an infraction/dispute; "note" = a standing informational note. */
  kind: z.enum(["case", "note"]).optional(),
  complaintBody: z.string().min(1).max(8000),
  /** Freehand text or an `@id:`/`@cid:` token; resolved to a link if it matches. */
  reporter: z.string().max(partyMax).optional(),
  subject: z.string().max(partyMax).optional(),
  resolution: z.string().max(8000).optional(),
  status: z.enum(STATUSES).optional(),
  relatedReportId: z.string().nullable().optional(),
  /** Comma/space-separated chat message ids to snapshot as evidence. */
  evidenceMessageIds: z.string().max(4000).optional(),
}).strict();

const updateSchema = createSchema.partial();

const timelineBody = z.object({
  body: z.string().min(1).max(8000),
  /** Optional status this update moves the case to. */
  status: z.enum(STATUSES).optional(),
}).strict();

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

/** Split a comma/space-separated id blob into a clean, de-duped, capped list. */
function parseMessageIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))].slice(0, 100);
}

/**
 * Snapshot the given chat messages onto a case as evidence (body/author/room
 * copied so the record survives the janitor purging the source). Idempotent
 * per (case, message). Returns how many of the requested ids actually existed.
 */
async function snapshotEvidence(db: Db, caseId: string, messageIds: string[]): Promise<number> {
  if (!messageIds.length) return 0;
  const found = await db
    .select({
      id: messages.id, roomId: messages.roomId, userId: messages.userId,
      displayName: messages.displayName, body: messages.body, kind: messages.kind,
      createdAt: messages.createdAt, roomName: rooms.name,
    })
    .from(messages)
    .leftJoin(rooms, eq(rooms.id, messages.roomId))
    .where(inArray(messages.id, messageIds));
  for (const m of found) {
    await db.insert(modCaseEvidence).values({
      id: nanoid(),
      caseId,
      messageId: m.id,
      authorUserId: m.userId,
      authorLabel: m.displayName,
      body: m.body,
      kind: m.kind,
      roomId: m.roomId,
      roomName: m.roomName ?? null,
      originalCreatedAt: +m.createdAt,
    }).onConflictDoNothing();
  }
  return found.length;
}

function wireCase(
  r: typeof modCases.$inferSelect,
  createdByName: string | null,
  updates: { id: string; body: string; statusChange: string | null; authorUserId: string | null; authorName: string | null; createdAt: number }[],
  evidence: (typeof modCaseEvidence.$inferSelect)[],
) {
  return {
    id: r.id,
    nature: r.nature,
    kind: r.kind,
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
    createdByName,
    createdAt: +r.createdAt,
    updatedAt: +r.updatedAt,
    resolvedAt: r.resolvedAt ? +r.resolvedAt : null,
    updates,
    evidence: evidence.map((e) => ({
      id: e.id,
      messageId: e.messageId,
      authorUserId: e.authorUserId,
      authorLabel: e.authorLabel,
      body: e.body,
      kind: e.kind,
      roomId: e.roomId,
      roomName: e.roomName,
      originalCreatedAt: e.originalCreatedAt,
      snapshottedAt: +e.snapshottedAt,
    })),
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

  /** Re-stamp a case's resolvedAt to match a status change. */
  const resolvedStamp = (status: CaseStatus) => (status === "resolved" ? new Date() : null);

  app.get<{ Querystring: { status?: string; kind?: string; q?: string; sort?: string } }>("/admin/mod-cases", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_mod_cases"))) return;
    const status = (STATUSES as readonly string[]).includes(req.query.status ?? "") ? (req.query.status as CaseStatus) : null;
    const kind = req.query.kind === "case" || req.query.kind === "note" ? req.query.kind : null;
    const conds = [
      ...(status ? [eq(modCases.status, status)] : []),
      ...(kind ? [eq(modCases.kind, kind)] : []),
    ];
    let rows = await db
      .select()
      .from(modCases)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(modCases.createdAt));

    // Free-text search across the human fields (low-volume table → in JS).
    const q = (req.query.q ?? "").trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) => [
        r.nature, r.complaintBody, r.resolution, r.reporterText, r.reporterLabel, r.subjectText, r.subjectLabel,
      ].some((f) => f?.toLowerCase().includes(q)));
    }

    // Sort (default newest). Reporter/subject sort on the resolved label or text.
    const sort = req.query.sort ?? "newest";
    const partyKey = (text: string | null, label: string | null) => (label ?? text ?? "￿").toLowerCase();
    rows.sort((a, b) => {
      switch (sort) {
        case "oldest": return +a.createdAt - +b.createdAt;
        case "updated": return +b.updatedAt - +a.updatedAt;
        case "reporter": return partyKey(a.reporterText, a.reporterLabel).localeCompare(partyKey(b.reporterText, b.reporterLabel));
        case "subject": return partyKey(a.subjectText, a.subjectLabel).localeCompare(partyKey(b.subjectText, b.subjectLabel));
        case "nature": return a.nature.toLowerCase().localeCompare(b.nature.toLowerCase());
        default: return +b.createdAt - +a.createdAt; // newest
      }
    });

    const ids = rows.map((r) => r.id);
    // Author names (creators + update authors), updates, and evidence in bulk.
    const authorIds = [...new Set([
      ...rows.map((r) => r.createdByUserId).filter((x): x is string => !!x),
    ])];
    const updateRows = ids.length
      ? await db.select({
          id: modCaseUpdates.id, caseId: modCaseUpdates.caseId, body: modCaseUpdates.body,
          statusChange: modCaseUpdates.statusChange, authorUserId: modCaseUpdates.authorUserId,
          createdAt: modCaseUpdates.createdAt, authorName: users.username,
        }).from(modCaseUpdates).leftJoin(users, eq(users.id, modCaseUpdates.authorUserId))
          .where(inArray(modCaseUpdates.caseId, ids)).orderBy(asc(modCaseUpdates.createdAt))
      : [];
    const evidenceRows = ids.length
      ? await db.select().from(modCaseEvidence)
          .where(inArray(modCaseEvidence.caseId, ids)).orderBy(asc(modCaseEvidence.originalCreatedAt))
      : [];
    const creatorNames = authorIds.length
      ? new Map((await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, authorIds))).map((u) => [u.id, u.username]))
      : new Map<string, string>();

    const updatesByCase = new Map<string, typeof updateRows>();
    for (const u of updateRows) {
      const arr = updatesByCase.get(u.caseId) ?? [];
      arr.push(u);
      updatesByCase.set(u.caseId, arr);
    }
    const evidenceByCase = new Map<string, typeof evidenceRows>();
    for (const e of evidenceRows) {
      const arr = evidenceByCase.get(e.caseId) ?? [];
      arr.push(e);
      evidenceByCase.set(e.caseId, arr);
    }

    return {
      cases: rows.map((r) => wireCase(
        r,
        r.createdByUserId ? creatorNames.get(r.createdByUserId) ?? null : null,
        (updatesByCase.get(r.id) ?? []).map((u) => ({
          id: u.id, body: u.body, statusChange: u.statusChange, authorUserId: u.authorUserId,
          authorName: u.authorName ?? null, createdAt: +u.createdAt,
        })),
        evidenceByCase.get(r.id) ?? [],
      )),
    };
  });

  app.post<{ Body: unknown }>("/admin/mod-cases", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_mod_cases"))) return;
    const body = createSchema.parse(req.body);
    const me = sessionOf(req);
    const reporter = await resolveParty(db, body.reporter);
    const subject = await resolveParty(db, body.subject);
    const id = nanoid();
    const kind = body.kind ?? "case";
    const status = body.status ?? "open";
    await db.insert(modCases).values({
      id,
      nature: body.nature,
      kind,
      complaintBody: body.complaintBody,
      resolution: body.resolution ?? null,
      status,
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
      resolvedAt: resolvedStamp(status),
    });
    const snapshotted = await snapshotEvidence(db, id, parseMessageIds(body.evidenceMessageIds));
    await recordAudit(db, { actorUserId: me.id, action: "mod_case_create", metadata: { id, kind } });
    return { id, evidenceSnapshotted: snapshotted };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/mod-cases/:id", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_mod_cases"))) return;
    const body = updateSchema.parse(req.body);
    const existing = (await db.select().from(modCases).where(eq(modCases.id, req.params.id)).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.nature !== undefined) patch.nature = body.nature;
    if (body.kind !== undefined) patch.kind = body.kind;
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
      patch.resolvedAt = resolvedStamp(body.status);
    }
    await db.update(modCases).set(patch).where(eq(modCases.id, req.params.id));
    const snapshotted = await snapshotEvidence(db, req.params.id, parseMessageIds(body.evidenceMessageIds));
    const me = sessionOf(req);
    await recordAudit(db, {
      actorUserId: me.id,
      action: "mod_case_update",
      metadata: { id: req.params.id, keys: Object.keys(body) },
    });
    return { ok: true, evidenceSnapshotted: snapshotted };
  });

  /** Append a timeline update (and optionally move the case's status). */
  app.post<{ Params: { id: string }; Body: unknown }>("/admin/mod-cases/:id/updates", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_mod_cases"))) return;
    const body = timelineBody.parse(req.body);
    const existing = (await db.select().from(modCases).where(eq(modCases.id, req.params.id)).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    const me = sessionOf(req);
    const statusChange = body.status && body.status !== existing.status ? body.status : null;
    const id = nanoid();
    await db.insert(modCaseUpdates).values({
      id, caseId: req.params.id, body: body.body, statusChange, authorUserId: me.id,
    });
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (statusChange) { patch.status = statusChange; patch.resolvedAt = resolvedStamp(statusChange); }
    await db.update(modCases).set(patch).where(eq(modCases.id, req.params.id));
    await recordAudit(db, { actorUserId: me.id, action: "mod_case_update", metadata: { id: req.params.id, update: id, statusChange } });
    return { ok: true, id };
  });

  app.delete<{ Params: { id: string; updateId: string } }>("/admin/mod-cases/:id/updates/:updateId", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_mod_cases"))) return;
    await db.delete(modCaseUpdates).where(and(eq(modCaseUpdates.id, req.params.updateId), eq(modCaseUpdates.caseId, req.params.id)));
    return { ok: true };
  });

  app.delete<{ Params: { id: string; evidenceId: string } }>("/admin/mod-cases/:id/evidence/:evidenceId", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_mod_cases"))) return;
    await db.delete(modCaseEvidence).where(and(eq(modCaseEvidence.id, req.params.evidenceId), eq(modCaseEvidence.caseId, req.params.id)));
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
