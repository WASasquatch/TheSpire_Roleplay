import type { FastifyInstance, FastifyRequest } from "fastify";
import { desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { ReportEntry, ReportStatus } from "@thekeep/shared";
import { messages, reports, rooms, users } from "../db/schema.js";
import { getSessionUser } from "./auth.js";
import { recordAudit } from "../audit.js";
import type { Db } from "../db/index.js";

const createReportBody = z.object({
  messageId: z.string().min(1),
  reason: z.string().max(500).optional(),
}).strict();

const resolveReportBody = z.object({
  status: z.enum(["reviewed", "dismissed"]),
  note: z.string().max(500).optional(),
}).strict();

/**
 * Public-message reporting routes.
 *
 * Privacy contract:
 *   - Whispers are NEVER reportable (no UI button on the client; server
 *     rejects too).
 *   - Private/password-room messages are NOT reportable in v1. Their
 *     existence implies a closed audience the admin can't see; surfacing
 *     bodies via report would breach that contract. Documented in plan.md.
 *   - Public-room reports carry the message id and the body is fetched at
 *     read time (so deletes propagate naturally to the queue display).
 */
export async function registerReportRoutes(app: FastifyInstance, db: Db): Promise<void> {
  /**
   * Authenticated user files a report against a public chat message.
   * Each (reporter, message) pair is unique via DB constraint - re-reports
   * fail the unique check and get 409.
   */
  app.post<{ Body: unknown }>("/reports", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let body;
    try { body = createReportBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const m = (await db.select().from(messages).where(eq(messages.id, body.messageId)).limit(1))[0];
    if (!m) { reply.code(404); return { error: "message not found" }; }
    // Privacy gate: never accept reports for whispers (private 1:1) or for
    // messages from non-public rooms. The client doesn't expose the button
    // for those, but the server must independently enforce.
    if (m.kind === "whisper") { reply.code(403); return { error: "whispers cannot be reported" }; }
    const room = (await db.select().from(rooms).where(eq(rooms.id, m.roomId)).limit(1))[0];
    if (!room) { reply.code(404); return { error: "room not found" }; }
    if (room.type !== "public") { reply.code(403); return { error: "only public-room messages can be reported" }; }
    if (m.userId === me.id) { reply.code(400); return { error: "you can't report your own message" }; }

    try {
      await db.insert(reports).values({
        id: nanoid(),
        reporterUserId: me.id,
        messageId: m.id,
        roomId: m.roomId,
        reason: body.reason?.trim() || null,
      });
    } catch (err) {
      // SQLite throws on the unique (reporter, message) index - surface as
      // 409 so the UI can say "you already reported this".
      const msg = err instanceof Error ? err.message : "";
      if (/UNIQUE/i.test(msg)) {
        reply.code(409);
        return { error: "you already reported this message" };
      }
      throw err;
    }
    return { ok: true };
  });

  /**
   * Admin queue. Optional ?status filter; default lists open reports first
   * then resolved ones, newest within each group.
   */
  app.get<{ Querystring: { status?: string; limit?: string } }>("/admin/reports", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me || me.role !== "admin") { reply.code(403); return { error: "admin only" }; }

    const status = req.query.status;
    const limit = Math.min(200, parseInt(req.query.limit ?? "100", 10) || 100);

    const filter = status === "open" || status === "reviewed" || status === "dismissed"
      ? eq(reports.status, status)
      : undefined;

    const rows = filter
      ? await db.select().from(reports).where(filter).orderBy(desc(reports.createdAt)).limit(limit)
      : await db.select().from(reports).orderBy(desc(reports.createdAt)).limit(limit);

    if (rows.length === 0) return { reports: [] };

    // Hydrate the rows with the surrounding context the admin needs to
    // triage: reporter name, message body + author name, room name, resolver.
    const userIds = new Set<string>();
    const roomIds = new Set<string>();
    const messageIds = new Set<string>();
    for (const r of rows) {
      userIds.add(r.reporterUserId);
      if (r.resolvedById) userIds.add(r.resolvedById);
      roomIds.add(r.roomId);
      messageIds.add(r.messageId);
    }
    const userRows = userIds.size > 0
      ? await db.select().from(users).where(inArray(users.id, [...userIds]))
      : [];
    const roomRows = roomIds.size > 0
      ? await db.select().from(rooms).where(inArray(rooms.id, [...roomIds]))
      : [];
    const messageRows = messageIds.size > 0
      ? await db.select().from(messages).where(inArray(messages.id, [...messageIds]))
      : [];
    const userById = new Map(userRows.map((u) => [u.id, u]));
    const roomById = new Map(roomRows.map((r) => [r.id, r]));
    const msgById = new Map(messageRows.map((m) => [m.id, m]));

    const out: ReportEntry[] = rows.map((r) => {
      const reporter = userById.get(r.reporterUserId);
      const resolver = r.resolvedById ? userById.get(r.resolvedById) : null;
      const room = roomById.get(r.roomId);
      const msg = msgById.get(r.messageId);
      return {
        id: r.id,
        reporterUserId: r.reporterUserId,
        reporterDisplayName: reporter?.username ?? "(deleted user)",
        messageId: r.messageId,
        // Soft-deleted messages return their placeholder rather than the
        // wiped body; admins still see what was reported, but if the
        // author already removed it the queue makes that visible.
        messageBody: msg
          ? (msg.deletedAt ? "[message removed]" : msg.body)
          : "[message gone]",
        messageDisplayName: msg?.displayName ?? "(unknown)",
        messageCreatedAt: msg ? +msg.createdAt : 0,
        roomId: r.roomId,
        roomName: room?.name ?? "(deleted room)",
        reason: r.reason,
        status: r.status as ReportStatus,
        resolvedById: r.resolvedById,
        resolvedByDisplayName: resolver ? resolver.username : null,
        resolvedAt: r.resolvedAt ? +r.resolvedAt : null,
        resolutionNote: r.resolutionNote,
        createdAt: +r.createdAt,
      };
    });
    return { reports: out };
  });

  /**
   * Admin resolves a report ("reviewed" = confirmed and acted on, or
   * "dismissed" = no action). Records an audit entry referencing the report.
   */
  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/reports/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me || me.role !== "admin") { reply.code(403); return { error: "admin only" }; }

    let body;
    try { body = resolveReportBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const r = (await db.select().from(reports).where(eq(reports.id, req.params.id)).limit(1))[0];
    if (!r) { reply.code(404); return { error: "not found" }; }
    if (r.status !== "open") { reply.code(409); return { error: `already ${r.status}` }; }

    await db.update(reports).set({
      status: body.status,
      resolvedById: me.id,
      resolvedAt: new Date(),
      resolutionNote: body.note?.trim() || null,
    }).where(eq(reports.id, r.id));

    await recordAudit(db, {
      actorUserId: me.id,
      action: body.status === "dismissed" ? "report_dismiss" : "report_resolve",
      targetMessageId: r.messageId,
      targetRoomId: r.roomId,
      reason: body.note?.trim() || null,
      metadata: { reportId: r.id, reporterUserId: r.reporterUserId },
    });
    return { ok: true };
  });
}

