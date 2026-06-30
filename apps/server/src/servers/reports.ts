/**
 * Per-server Reports admin (Multi-Server Lift — the "Admin Partition").
 *
 * The server-scoped twin of routes/reports.ts's global admin queue. A server
 * owner/mod (holding the granular `manage_reports` key) triages the reports
 * filed against THIS server's messages, inside the Server Admin console —
 * never the platform-wide queue.
 *
 * SCOPE — message reports ONLY. A room-message report carries
 * `reports.server_id` (stamped to the room's owning server at file-time in
 * routes/reports.ts). DM and profile reports carry NO room, so they stay
 * `server_id` NULL = platform/site staff; this module never surfaces them.
 * That single column is the entire seam: there is NO server_reports table.
 *
 * FLAG-OFF is byte-identical to today: every route 404s when
 * `areServersEnabled` is false, exactly like a feature that was never wired up.
 * Per-server gating runs through `serverAuthority`/`serverCan` (the one powers
 * resolver), replicated inline here because this module is standalone — it is
 * registered alongside routes/servers.ts from the same index.ts.
 *
 * Routes (all under /servers/:id/reports):
 *   GET  /servers/:id/reports      — open + recently-resolved queue for this server
 *   PATCH /servers/:id/reports/:reportId — resolve ("reviewed") or dismiss
 */
import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { and, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  ClientToServerEvents,
  ReportEntry,
  ReportStatus,
  ServerToClientEvents,
} from "@thekeep/shared";
import { auditLog, messages, reports, rooms, users } from "../db/schema.js";
import { getSessionUser } from "../routes/auth.js";
import { areServersEnabled, getSettings } from "../settings.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

const resolveReportBody = z
  .object({
    status: z.enum(["reviewed", "dismissed"]),
    note: z.string().max(500).optional(),
  })
  .strict();

export async function registerServerReportRoutes(
  app: FastifyInstance,
  db: Db,
  _io: Io,
): Promise<void> {
  /**
   * GET /servers/:id/reports — this server's message-report queue.
   *
   * Mirrors the global /admin/reports read (open first, then recently
   * resolved, newest within each group), but WHERE `reports.server_id = :id`,
   * so only message/room reports stamped to this server appear. DM/profile
   * reports (server_id NULL) never surface here.
   */
  app.get<{ Params: { id: string }; Querystring: { status?: string; limit?: string } }>(
    "/servers/:id/reports",
    async (req, reply) => {
      if (!areServersEnabled(await getSettings(db))) { reply.code(404); return { error: "not found" }; }
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const { serverAuthority, serverCan } = await import("../servers/authority.js");
      const a = await serverAuthority(db, me, req.params.id);
      if (!a.server) { reply.code(404); return { error: "no server" }; }
      if (!serverCan(a, "manage_reports")) { reply.code(403); return { error: "forbidden" }; }

      const status = req.query.status;
      const limit = Math.min(200, parseInt(req.query.limit ?? "100", 10) || 100);

      // Always scope to THIS server's message reports (the column is the seam).
      const scope = eq(reports.serverId, req.params.id);
      const statusFilter =
        status === "open" || status === "reviewed" || status === "dismissed"
          ? eq(reports.status, status)
          : undefined;
      const filter = statusFilter ? and(scope, statusFilter) : scope;

      const rows = await db
        .select()
        .from(reports)
        .where(filter)
        .orderBy(desc(reports.createdAt))
        .limit(limit);

      if (rows.length === 0) return { reports: [] };

      // Hydrate the rows with the surrounding context the mod needs to triage:
      // reporter name, message body + author name, room name, resolver. These
      // are all message/room reports (server_id is only ever stamped on the
      // message branch), so each carries `messageId` + `roomId`; we never touch
      // DM/profile snapshot fields here.
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
        return {
          id: r.id,
          reporterUserId: r.reporterUserId,
          reporterDisplayName: reporter?.username ?? "(deleted user)",
          messageId: r.messageId ?? "",
          // Soft-deleted messages return their placeholder rather than the
          // wiped body; the mod still sees what was reported, but if the
          // author already removed it the queue makes that visible.
          messageBody: msg
            ? (msg.deletedAt ? "[message removed]" : msg.body)
            : "[message gone]",
          messageDisplayName: msg?.displayName ?? "(unknown)",
          messageCreatedAt: msg ? +msg.createdAt : 0,
          roomId: r.roomId ?? "",
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
    },
  );

  /**
   * PATCH /servers/:id/reports/:reportId — resolve ("reviewed" = acted on) or
   * dismiss ("dismissed" = no action) one of THIS server's open reports.
   *
   * Mirrors the global resolve handler but the lookup is scoped to this
   * server's reports (server_id = :id), so a server mod can never touch a
   * platform-owned (NULL) report or another server's.
   */
  app.patch<{ Params: { id: string; reportId: string }; Body: unknown }>(
    "/servers/:id/reports/:reportId",
    async (req, reply) => {
      if (!areServersEnabled(await getSettings(db))) { reply.code(404); return { error: "not found" }; }
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const { serverAuthority, serverCan } = await import("../servers/authority.js");
      const a = await serverAuthority(db, me, req.params.id);
      if (!a.server) { reply.code(404); return { error: "no server" }; }
      if (!serverCan(a, "manage_reports")) { reply.code(403); return { error: "forbidden" }; }

      let body: z.infer<typeof resolveReportBody>;
      try { body = resolveReportBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const r = (await db
        .select()
        .from(reports)
        .where(and(eq(reports.id, req.params.reportId), eq(reports.serverId, req.params.id)))
        .limit(1))[0];
      if (!r) { reply.code(404); return { error: "not found" }; }
      if (r.status !== "open") { reply.code(409); return { error: `already ${r.status}` }; }

      await db
        .update(reports)
        .set({
          status: body.status,
          resolvedById: me.id,
          resolvedAt: new Date(),
          resolutionNote: body.note?.trim() || null,
        })
        .where(eq(reports.id, r.id));

      // Best-effort server-scoped audit row: stamps server_id so it lands in
      // THIS server's Mod Log (not the global feed). A logging failure must
      // never roll back the resolve that already happened.
      try {
        await db.insert(auditLog).values({
          id: nanoid(),
          serverId: req.params.id,
          actorUserId: me.id,
          action: "server_report_resolve",
          targetUserId: r.senderUserId ?? null,
          targetRoomId: r.roomId ?? null,
          targetMessageId: r.messageId ?? null,
          reason: body.note?.trim() || null,
          metadataJson: JSON.stringify({
            reportId: r.id,
            reporterUserId: r.reporterUserId,
            outcome: body.status,
          }),
        });
      } catch {
        // swallow — the report is already resolved; a missed audit row is the
        // lesser harm.
      }

      return { ok: true };
    },
  );
}
