/**
 * Per-server Mod Cases admin (Multi-Server Lift — the "Admin Partition").
 *
 * The server-scoped twin of admin/modCases.ts's GLOBAL moderation case log. A
 * server owner/admin/mod (holding the granular `manage_mod_cases` key) keeps a
 * case log against the users who joined THEIR server, inside the Server Admin
 * console — never the platform-wide case log.
 *
 * SCOPE — `mod_cases.server_id` is the entire seam (migration 0278b). NULL =
 * the GLOBAL / platform case (owned by admin/modCases.ts); a `server_id` scopes
 * the case to that server. Every read/write below is WHERE `mod_cases.server_id
 * = :id` and stamps `server_id = :id` on create, so a server mod can never see,
 * edit, or delete the platform case log or another server's cases. There is NO
 * separate server_mod_cases table; mod_case_updates / mod_case_evidence inherit
 * scope through case_id (cascade FKs).
 *
 * A "case action that bans" here means a SERVER ban (server_bans, the existing
 * per-server ban via PUT /servers/:id/bans), NOT a global account ban — this
 * module never touches the platform ban surface. The case log records the
 * server-level outcome; banning a member goes through the Bans tab.
 *
 * CROSS-SERVER EVIDENCE GUARD — attaching a chat message as evidence only snaps
 * messages whose room belongs to THIS server (resolveRoomServerId === :id). A
 * mod can't reach into another server's (or a legacy/default) room to snapshot
 * messages onto their own server's case. Requested ids that fail the guard are
 * silently skipped (mirrors the global "id not found → not snapshotted" shape),
 * and the response reports how many actually landed.
 *
 * FLAG-OFF is byte-identical to today: every route 404s when
 * `areServersEnabled` is false, exactly like a feature that was never wired up.
 * Per-server gating runs through `serverAuthority`/`serverCan` (the one powers
 * resolver), imported inline because this module is standalone — it is
 * registered alongside routes/servers.ts from the same index.ts.
 *
 * Routes (all under /servers/:id/mod-cases):
 *   GET    /servers/:id/mod-cases                       — this server's case log
 *   POST   /servers/:id/mod-cases                       — create (stamps server_id)
 *   PATCH  /servers/:id/mod-cases/:caseId               — edit / change status / resolve
 *   POST   /servers/:id/mod-cases/:caseId/updates       — append a timeline update
 *   DELETE /servers/:id/mod-cases/:caseId/updates/:updateId   — drop an update
 *   DELETE /servers/:id/mod-cases/:caseId/evidence/:evidenceId — drop an evidence snapshot
 *   DELETE /servers/:id/mod-cases/:caseId               — delete the case
 */
import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { auditLog, messages, modCaseEvidence, modCaseUpdates, modCases, rooms, users } from "../db/schema.js";
import { getSessionUser } from "../routes/auth.js";
import { areServersEnabled, getSettings } from "../settings.js";
import { resolveIdentityArg } from "../commands/identityArg.js";
import { resolveRoomServerId } from "../earning/pool.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

const partyMax = 120;
const STATUSES = ["open", "in_progress", "resolved"] as const;
type CaseStatus = (typeof STATUSES)[number];

const createSchema = z
  .object({
    nature: z.string().min(1).max(80),
    /** "case" = an infraction/dispute; "note" = a standing informational note. */
    kind: z.enum(["case", "note"]).optional(),
    complaintBody: z.string().min(1).max(8000),
    /** Freehand text or an `@id:`/`@cid:` token; resolved to a link if it matches. */
    reporter: z.string().max(partyMax).optional(),
    subject: z.string().max(partyMax).optional(),
    resolution: z.string().max(8000).optional(),
    status: z.enum(STATUSES).optional(),
    /** Comma/space-separated chat message ids to snapshot as evidence. */
    evidenceMessageIds: z.string().max(4000).optional(),
  })
  .strict();

const updateSchema = createSchema.partial();

const timelineBody = z
  .object({
    body: z.string().min(1).max(8000),
    /** Optional status this update moves the case to. */
    status: z.enum(STATUSES).optional(),
  })
  .strict();

interface ResolvedParty {
  text: string | null;
  userId: string | null;
  characterId: string | null;
  label: string | null;
}

/**
 * Turn a free-text reporter/subject input into a stored party (mirrors the
 * global resolveParty). We always keep the raw text; if it resolves to exactly
 * one identity (a token, or a name that maps to a single account/character) we
 * ALSO store the link + a snapshot label so the log stays queryable by person.
 * Ambiguous / no-match inputs stay pure freehand.
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

export async function registerServerModCaseRoutes(
  app: FastifyInstance,
  db: Db,
  _io: Io,
): Promise<void> {
  /** Re-stamp a case's resolvedAt to match a status change. */
  const resolvedStamp = (status: CaseStatus) => (status === "resolved" ? new Date() : null);

  /**
   * Snapshot the given chat messages onto a server-scoped case as evidence.
   * CROSS-SERVER GUARD: a message is only snapshotted if its room resolves to
   * THIS server (resolveRoomServerId === serverId), so a mod can't reach into
   * another server's room to attach messages onto their own case. Idempotent
   * per (case, message). Returns how many of the requested ids actually landed.
   */
  async function snapshotEvidence(serverId: string, caseId: string, messageIds: string[]): Promise<number> {
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
    let landed = 0;
    for (const m of found) {
      // Refuse cross-server evidence: the message's room must belong to this
      // server. Legacy/NULL-serverId rooms resolve to the default server, so a
      // non-default server can never snapshot them either.
      const msgServerId = await resolveRoomServerId(db, m.roomId);
      if (msgServerId !== serverId) continue;
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
      landed += 1;
    }
    return landed;
  }

  /** Best-effort server-scoped audit row (mirrors auditServer in routes/servers.ts
   *  + audit in servers/faqs.ts). Stamps server_id so the entry lands in THIS
   *  server's Mod Log; a logging failure never fails the action it records. */
  async function audit(serverId: string, actorUserId: string, action: string, targetUserId: string | null, metadata: Record<string, unknown>): Promise<void> {
    try {
      await db.insert(auditLog).values({
        id: nanoid(),
        serverId,
        actorUserId,
        action,
        targetUserId: targetUserId ?? null,
        metadataJson: JSON.stringify(metadata),
      });
    } catch {
      /* swallow — best-effort, exactly like recordAudit */
    }
  }

  app.get<{ Params: { id: string }; Querystring: { status?: string; kind?: string; q?: string; sort?: string } }>(
    "/servers/:id/mod-cases",
    async (req, reply) => {
      if (!areServersEnabled(await getSettings(db))) { reply.code(404); return { error: "not found" }; }
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const { serverAuthority, serverCan } = await import("../servers/authority.js");
      const a = await serverAuthority(db, me, req.params.id);
      if (!a.server) { reply.code(404); return { error: "no server" }; }
      if (!serverCan(a, "manage_mod_cases")) { reply.code(403); return { error: "forbidden" }; }

      const status = (STATUSES as readonly string[]).includes(req.query.status ?? "") ? (req.query.status as CaseStatus) : null;
      const kind = req.query.kind === "case" || req.query.kind === "note" ? req.query.kind : null;
      // Always scope to THIS server's cases (the column is the seam).
      const conds = [
        eq(modCases.serverId, req.params.id),
        ...(status ? [eq(modCases.status, status)] : []),
        ...(kind ? [eq(modCases.kind, kind)] : []),
      ];
      let rows = await db
        .select()
        .from(modCases)
        .where(and(...conds))
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
      rows.sort((x, y) => {
        switch (sort) {
          case "oldest": return +x.createdAt - +y.createdAt;
          case "updated": return +y.updatedAt - +x.updatedAt;
          case "reporter": return partyKey(x.reporterText, x.reporterLabel).localeCompare(partyKey(y.reporterText, y.reporterLabel));
          case "subject": return partyKey(x.subjectText, x.subjectLabel).localeCompare(partyKey(y.subjectText, y.subjectLabel));
          case "nature": return x.nature.toLowerCase().localeCompare(y.nature.toLowerCase());
          default: return +y.createdAt - +x.createdAt; // newest
        }
      });

      const ids = rows.map((r) => r.id);
      const authorIds = [...new Set(rows.map((r) => r.createdByUserId).filter((v): v is string => !!v))];
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
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/mod-cases", async (req, reply) => {
    if (!areServersEnabled(await getSettings(db))) { reply.code(404); return { error: "not found" }; }
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const { serverAuthority, serverCan } = await import("../servers/authority.js");
    const a = await serverAuthority(db, me, req.params.id);
    if (!a.server) { reply.code(404); return { error: "no server" }; }
    if (!serverCan(a, "manage_mod_cases")) { reply.code(403); return { error: "forbidden" }; }

    let body: z.infer<typeof createSchema>;
    try { body = createSchema.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

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
      createdByUserId: me.id,
      resolvedAt: resolvedStamp(status),
      serverId: req.params.id,
    });
    const snapshotted = await snapshotEvidence(req.params.id, id, parseMessageIds(body.evidenceMessageIds));
    await audit(req.params.id, me.id, "server_mod_case_create", subject.userId, { id, kind });
    return { id, evidenceSnapshotted: snapshotted };
  });

  app.patch<{ Params: { id: string; caseId: string }; Body: unknown }>(
    "/servers/:id/mod-cases/:caseId",
    async (req, reply) => {
      if (!areServersEnabled(await getSettings(db))) { reply.code(404); return { error: "not found" }; }
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const { serverAuthority, serverCan } = await import("../servers/authority.js");
      const a = await serverAuthority(db, me, req.params.id);
      if (!a.server) { reply.code(404); return { error: "no server" }; }
      if (!serverCan(a, "manage_mod_cases")) { reply.code(403); return { error: "forbidden" }; }

      let body: z.infer<typeof updateSchema>;
      try { body = updateSchema.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      // Scope the lookup to this server's rows — a mod can never reach the
      // platform case log or another server's case by id.
      const existing = (await db.select().from(modCases)
        .where(and(eq(modCases.id, req.params.caseId), eq(modCases.serverId, req.params.id))).limit(1))[0];
      if (!existing) { reply.code(404); return { error: "not found" }; }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.nature !== undefined) patch.nature = body.nature;
      if (body.kind !== undefined) patch.kind = body.kind;
      if (body.complaintBody !== undefined) patch.complaintBody = body.complaintBody;
      if (body.resolution !== undefined) patch.resolution = body.resolution;
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
      await db.update(modCases).set(patch)
        .where(and(eq(modCases.id, req.params.caseId), eq(modCases.serverId, req.params.id)));
      const snapshotted = await snapshotEvidence(req.params.id, req.params.caseId, parseMessageIds(body.evidenceMessageIds));
      await audit(req.params.id, me.id, "server_mod_case_update", null, { id: req.params.caseId, keys: Object.keys(body) });
      return { ok: true, evidenceSnapshotted: snapshotted };
    },
  );

  /** Append a timeline update (and optionally move the case's status). */
  app.post<{ Params: { id: string; caseId: string }; Body: unknown }>(
    "/servers/:id/mod-cases/:caseId/updates",
    async (req, reply) => {
      if (!areServersEnabled(await getSettings(db))) { reply.code(404); return { error: "not found" }; }
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const { serverAuthority, serverCan } = await import("../servers/authority.js");
      const a = await serverAuthority(db, me, req.params.id);
      if (!a.server) { reply.code(404); return { error: "no server" }; }
      if (!serverCan(a, "manage_mod_cases")) { reply.code(403); return { error: "forbidden" }; }

      let body: z.infer<typeof timelineBody>;
      try { body = timelineBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const existing = (await db.select().from(modCases)
        .where(and(eq(modCases.id, req.params.caseId), eq(modCases.serverId, req.params.id))).limit(1))[0];
      if (!existing) { reply.code(404); return { error: "not found" }; }
      const statusChange = body.status && body.status !== existing.status ? body.status : null;
      const updateId = nanoid();
      await db.insert(modCaseUpdates).values({
        id: updateId, caseId: req.params.caseId, body: body.body, statusChange, authorUserId: me.id,
      });
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (statusChange) { patch.status = statusChange; patch.resolvedAt = resolvedStamp(statusChange); }
      await db.update(modCases).set(patch)
        .where(and(eq(modCases.id, req.params.caseId), eq(modCases.serverId, req.params.id)));
      await audit(req.params.id, me.id, "server_mod_case_update", null, { id: req.params.caseId, update: updateId, statusChange });
      return { ok: true, id: updateId };
    },
  );

  app.delete<{ Params: { id: string; caseId: string; updateId: string } }>(
    "/servers/:id/mod-cases/:caseId/updates/:updateId",
    async (req, reply) => {
      if (!areServersEnabled(await getSettings(db))) { reply.code(404); return { error: "not found" }; }
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const { serverAuthority, serverCan } = await import("../servers/authority.js");
      const a = await serverAuthority(db, me, req.params.id);
      if (!a.server) { reply.code(404); return { error: "no server" }; }
      if (!serverCan(a, "manage_mod_cases")) { reply.code(403); return { error: "forbidden" }; }
      // Confirm the parent case is ours before touching the child row, so a
      // child id alone can't reach into another server's case timeline.
      const owns = (await db.select({ id: modCases.id }).from(modCases)
        .where(and(eq(modCases.id, req.params.caseId), eq(modCases.serverId, req.params.id))).limit(1))[0];
      if (!owns) { reply.code(404); return { error: "not found" }; }
      await db.delete(modCaseUpdates)
        .where(and(eq(modCaseUpdates.id, req.params.updateId), eq(modCaseUpdates.caseId, req.params.caseId)));
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; caseId: string; evidenceId: string } }>(
    "/servers/:id/mod-cases/:caseId/evidence/:evidenceId",
    async (req, reply) => {
      if (!areServersEnabled(await getSettings(db))) { reply.code(404); return { error: "not found" }; }
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const { serverAuthority, serverCan } = await import("../servers/authority.js");
      const a = await serverAuthority(db, me, req.params.id);
      if (!a.server) { reply.code(404); return { error: "no server" }; }
      if (!serverCan(a, "manage_mod_cases")) { reply.code(403); return { error: "forbidden" }; }
      const owns = (await db.select({ id: modCases.id }).from(modCases)
        .where(and(eq(modCases.id, req.params.caseId), eq(modCases.serverId, req.params.id))).limit(1))[0];
      if (!owns) { reply.code(404); return { error: "not found" }; }
      await db.delete(modCaseEvidence)
        .where(and(eq(modCaseEvidence.id, req.params.evidenceId), eq(modCaseEvidence.caseId, req.params.caseId)));
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; caseId: string } }>("/servers/:id/mod-cases/:caseId", async (req, reply) => {
    if (!areServersEnabled(await getSettings(db))) { reply.code(404); return { error: "not found" }; }
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const { serverAuthority, serverCan } = await import("../servers/authority.js");
    const a = await serverAuthority(db, me, req.params.id);
    if (!a.server) { reply.code(404); return { error: "no server" }; }
    if (!serverCan(a, "manage_mod_cases")) { reply.code(403); return { error: "forbidden" }; }
    // server_id in the WHERE so a delete can only touch this server's case
    // (its updates + evidence go with it via cascade FKs).
    await db.delete(modCases)
      .where(and(eq(modCases.id, req.params.caseId), eq(modCases.serverId, req.params.id)));
    await audit(req.params.id, me.id, "server_mod_case_delete", null, { id: req.params.caseId });
    return { ok: true };
  });
}
