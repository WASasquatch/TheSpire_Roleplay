import type { FastifyInstance, FastifyRequest } from "fastify";
import { hasPermission } from "../auth/permissions.js";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { ReportEntry, ReportStatus } from "@thekeep/shared";
import { characters, directConversations, directMessages, messages, reports, rooms, users } from "../db/schema.js";
import { getSessionUser } from "./auth.js";
import { recordAudit } from "../audit.js";
import { areServersEnabled, getSettings } from "../settings.js";
import type { Db } from "../db/index.js";

/**
 * Two report shapes share one endpoint. The discriminant is `kind`:
 *   - kind: "message" , room-content report; `messageId` required.
 *   - kind: "dm"      , direct-message report; `directMessageId`
 *                        required. The reporter must be one of the
 *                        two participants. The route snapshots the
 *                        body at report-time so the admin queue can
 *                        show it without ever querying
 *                        `direct_messages` from the /admin/* surface.
 *
 * The "message" branch is the legacy default (omit `kind` and pass
 * `messageId`) so existing clients keep working without an update.
 */
const createReportBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    messageId: z.string().min(1),
    reason: z.string().max(500).optional(),
  }).strict(),
  z.object({
    kind: z.literal("dm"),
    directMessageId: z.string().min(1),
    reason: z.string().max(500).optional(),
  }).strict(),
  z.object({
    // Report a whole profile (e.g. explicit imagery / rule-breaking
    // content found on it). Targets the master account; an optional
    // characterId records which persona surfaced it. No message body,
    // the mod opens the profile to review.
    kind: z.literal("profile"),
    targetUserId: z.string().min(1),
    targetCharacterId: z.string().min(1).optional(),
    reason: z.string().max(500).optional(),
  }).strict(),
]);
const legacyMessageReportBody = z.object({
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

    // Accept the new discriminated shape OR the legacy `{ messageId }`
    // form. Legacy clients (or admin-tool scripts) don't have to be
    // updated to keep filing message reports.
    let parsed: z.infer<typeof createReportBody>;
    const tryUnion = createReportBody.safeParse(req.body);
    if (tryUnion.success) {
      parsed = tryUnion.data;
    } else {
      const tryLegacy = legacyMessageReportBody.safeParse(req.body);
      if (!tryLegacy.success) { reply.code(400); return { error: "invalid body" }; }
      parsed = { kind: "message", messageId: tryLegacy.data.messageId, reason: tryLegacy.data.reason };
    }

    if (parsed.kind === "message") {
      const m = (await db.select().from(messages).where(eq(messages.id, parsed.messageId)).limit(1))[0];
      if (!m) { reply.code(404); return { error: "message not found" }; }
      // Privacy gate: never accept reports for whispers (private 1:1) or
      // for messages from non-public rooms. The client doesn't expose the
      // button for those, but the server must independently enforce.
      if (m.kind === "whisper") { reply.code(403); return { error: "whispers cannot be reported" }; }
      const room = (await db.select().from(rooms).where(eq(rooms.id, m.roomId)).limit(1))[0];
      if (!room) { reply.code(404); return { error: "room not found" }; }
      if (room.type !== "public") { reply.code(403); return { error: "only public-room messages can be reported" }; }
      if (m.userId === me.id) { reply.code(400); return { error: "you can't report your own message" }; }

      // Scope a message/room report to the room's owning server so it lands in
      // that server's Reports panel (there is NO server_reports table — this
      // one column is the seam). DM/profile reports below carry no room, so
      // they stay `server_id` NULL = platform/site staff. Only stamp when the
      // feature is live; flag-off keeps `server_id` NULL exactly as today.
      const serversOn = areServersEnabled(await getSettings(db));
      try {
        await db.insert(reports).values({
          id: nanoid(),
          reporterUserId: me.id,
          messageId: m.id,
          roomId: m.roomId,
          serverId: serversOn ? (room.serverId ?? null) : null,
          reason: parsed.reason?.trim() || null,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (/UNIQUE/i.test(msg)) {
          reply.code(409);
          return { error: "you already reported this message" };
        }
        throw err;
      }
      return { ok: true };
    }

    // Profile branch.
    if (parsed.kind === "profile") {
      const target = (await db.select().from(users).where(eq(users.id, parsed.targetUserId)).limit(1))[0];
      if (!target) { reply.code(404); return { error: "user not found" }; }
      if (target.id === me.id) { reply.code(400); return { error: "you can't report your own profile" }; }
      let snapName = target.username;
      if (parsed.targetCharacterId) {
        const c = (await db.select({ name: characters.name, userId: characters.userId })
          .from(characters).where(eq(characters.id, parsed.targetCharacterId)).limit(1))[0];
        if (c && c.userId === target.id) snapName = c.name;
      }
      // Dedup: one OPEN profile report per (reporter, target). Profile
      // reports carry neither messageId nor directMessageId, so the
      // (reporter, message) unique index doesn't apply, gate in code.
      const existing = (await db.select({ id: reports.id }).from(reports).where(and(
        eq(reports.reporterUserId, me.id),
        eq(reports.senderUserId, target.id),
        isNull(reports.messageId),
        isNull(reports.directMessageId),
        eq(reports.status, "open"),
      )).limit(1))[0];
      if (existing) { reply.code(409); return { error: "you already reported this profile" }; }
      await db.insert(reports).values({
        id: nanoid(),
        reporterUserId: me.id,
        // Reuse senderUserId as the reported party (same as DM reports);
        // bodySnapshot describes the target so the queue stands alone.
        senderUserId: target.id,
        bodySnapshot: `Profile report: ${snapName}${parsed.targetCharacterId ? " (character)" : ""}`,
        reason: parsed.reason?.trim() || null,
      });
      return { ok: true };
    }

    // DM branch.
    const dm = (await db.select().from(directMessages).where(eq(directMessages.id, parsed.directMessageId)).limit(1))[0];
    if (!dm) { reply.code(404); return { error: "message not found" }; }
    if (dm.senderUserId === me.id) { reply.code(400); return { error: "you can't report your own message" }; }
    // Participant check, reporter must be one of the two parties on
    // the conversation. Non-participants don't see DMs at all (the
    // history endpoint also 404s for them), so a request here from
    // someone else is treated the same: 404, no info leak.
    const conv = (await db
      .select()
      .from(directConversations)
      .where(eq(directConversations.id, dm.conversationId))
      .limit(1))[0];
    if (!conv) { reply.code(404); return { error: "message not found" }; }
    if (conv.userAId !== me.id && conv.userBId !== me.id) {
      reply.code(404);
      return { error: "message not found" };
    }
    try {
      await db.insert(reports).values({
        id: nanoid(),
        reporterUserId: me.id,
        directMessageId: dm.id,
        // Snapshot the body + sender at report time so the admin
        // queue stands on its own. Even if the sender soft-deletes
        // afterwards (or the DM cascade fires), the report row
        // retains what was reported.
        bodySnapshot: dm.body,
        senderUserId: dm.senderUserId,
        reason: parsed.reason?.trim() || null,
      });
    } catch (err) {
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
    if (!me || !(await hasPermission(me, "view_report_queue", db))) {
      reply.code(403); return { error: "forbidden", missing: "view_report_queue" };
    }

    const status = req.query.status;
    const limit = Math.min(200, parseInt(req.query.limit ?? "100", 10) || 100);

    const statusFilter = status === "open" || status === "reviewed" || status === "dismissed"
      ? eq(reports.status, status)
      : undefined;
    // The GLOBAL report queue is platform-owned reports only once servers are
    // live: message/room reports stamped with a `server_id` belong to that
    // server's Reports panel. DM/profile reports stay NULL = here. FLAG-OFF:
    // no scoping (every row has `server_id` NULL anyway) → byte-identical.
    const scope = areServersEnabled(await getSettings(db)) ? isNull(reports.serverId) : undefined;
    const conds = [scope, statusFilter].filter((c): c is NonNullable<typeof c> => !!c);
    const filter = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);

    const rows = filter
      ? await db.select().from(reports).where(filter).orderBy(desc(reports.createdAt)).limit(limit)
      : await db.select().from(reports).orderBy(desc(reports.createdAt)).limit(limit);

    if (rows.length === 0) return { reports: [] };

    // Hydrate the rows with the surrounding context the admin needs to
    // triage: reporter name, message body + author name, room name, resolver.
    //
    // Reports come in two shapes now (Phase 5 extension): the old
    // room-message report carries `messageId` + `roomId` and we hydrate
    // them by joining `messages` and `rooms`. DM reports carry
    // `directMessageId` + `bodySnapshot` + `senderUserId`, with
    // `messageId` and `roomId` null; the snapshot is used verbatim so
    // the admin queue never queries `direct_messages` from the
    // /admin/* surface (preserves the admin-blind invariant).
    const userIds = new Set<string>();
    const roomIds = new Set<string>();
    const messageIds = new Set<string>();
    for (const r of rows) {
      userIds.add(r.reporterUserId);
      if (r.resolvedById) userIds.add(r.resolvedById);
      if (r.senderUserId) userIds.add(r.senderUserId);
      if (r.roomId) roomIds.add(r.roomId);
      if (r.messageId) messageIds.add(r.messageId);
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
      const room = r.roomId ? roomById.get(r.roomId) : undefined;
      const msg = r.messageId ? msgById.get(r.messageId) : undefined;
      // DM branch: use the at-report-time snapshot rather than
      // looking up the live row. The /admin/* surface deliberately
      // never queries `direct_messages` directly.
      const isDmReport = !!r.directMessageId;
      // Profile reports carry a reported party (senderUserId) but no
      // message of either kind; the snapshot describes the target.
      const isProfileReport = !r.messageId && !r.directMessageId && !!r.senderUserId;
      const reportedUser = r.senderUserId ? userById.get(r.senderUserId) : undefined;
      return {
        id: r.id,
        reporterUserId: r.reporterUserId,
        reporterDisplayName: reporter?.username ?? "(deleted user)",
        messageId: r.messageId ?? r.directMessageId ?? "",
        // Soft-deleted messages return their placeholder rather than the
        // wiped body; admins still see what was reported, but if the
        // author already removed it the queue makes that visible. DM +
        // profile reports return their snapshot.
        messageBody: isProfileReport || isDmReport
          ? (r.bodySnapshot ?? "[snapshot gone]")
          : (msg
              ? (msg.deletedAt ? "[message removed]" : msg.body)
              : "[message gone]"),
        messageDisplayName: isProfileReport || isDmReport
          ? (reportedUser?.username ?? "(unknown)")
          : (msg?.displayName ?? "(unknown)"),
        messageCreatedAt: msg ? +msg.createdAt : ((isDmReport || isProfileReport) ? +r.createdAt : 0),
        roomId: r.roomId ?? "",
        roomName: isProfileReport ? "(profile)" : isDmReport ? "(direct message)" : (room?.name ?? "(deleted room)"),
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
    if (!me || !(await hasPermission(me, "resolve_reports", db))) {
      reply.code(403); return { error: "forbidden", missing: "resolve_reports" };
    }

    let body;
    try { body = resolveReportBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    // Mirror the queue read: from the GLOBAL tab a platform mod resolves only
    // platform-owned (server_id NULL) reports once servers are live. Flag-off
    // keeps the bare id lookup (every row is NULL) → unchanged.
    const scope = areServersEnabled(await getSettings(db)) ? isNull(reports.serverId) : undefined;
    const r = (await db.select().from(reports)
      .where(scope ? and(eq(reports.id, req.params.id), scope) : eq(reports.id, req.params.id)).limit(1))[0];
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

