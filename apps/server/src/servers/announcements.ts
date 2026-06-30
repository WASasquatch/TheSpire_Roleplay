/**
 * Per-server Announcements admin (Multi-Server Lift — Admin Partition §4).
 *
 * The server-scoped twin of `admin/announcements.ts`. A server owner/mod with
 * `manage_announcements` curates THIS server's rotating banner + scheduled
 * `/announce` cronjobs, exactly mirroring the global admin surface but with
 * every row stamped + filtered on `server_id = :id`.
 *
 *   - `announcement_banners.server_id`  — the rotating marquee, scoped so it
 *     paints only above this server's rooms (migration 0278d).
 *   - `scheduled_announcements.server_id` — cron-like rows the SHARED
 *     in-process scheduler (`startAnnouncementScheduler`, admin/announcements.ts)
 *     fires (migration 0278e).
 *
 * CRON FAN-OUT (plan_ext.md §4, row 132): a scheduled row with a NULL
 * `target_room_id` "fans out to every room". The shared `fireScheduled`
 * ALREADY clamps that fan-out to the owning server's rooms when servers are
 * enabled — `WHERE rooms.server_id = row.serverId` for a server-stamped row,
 * `WHERE rooms.server_id IS NULL` for a platform (NULL-server) row. So the ONLY
 * thing this module must guarantee is that every server-created schedule is
 * stamped `server_id = :id`; the dispatcher then targets this server's rooms
 * with no change required there. (See the orchestrator note in the deliverable
 * summary — no cron edit needed.)
 *
 * Self-gated per §3: depends only on the EXPORTED `getSessionUser`,
 * `serverAuthority`, `serverCan`, plus the flag check — no coupling to the
 * `registerServerRoutes` closures. Audit rows are written directly with
 * `serverId` (mirror of `auditServer` in routes/servers.ts).
 *
 * Flag-gated: every route 404s when `!serversEnabled`, so flag-off is
 * byte-identical to today.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import {
  ANNOUNCEMENT_BANNER_BODY_MAX,
  COLOR_TOKEN_OR_HEX_RE,
  SCHEDULED_ANNOUNCEMENT_BODY_MAX,
  parseScheduleSpec,
  validateAuthorUiRouteTokens,
} from "@thekeep/shared";
import { announcementBanners, auditLog, rooms, scheduledAnnouncements } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { sanitizeBio } from "../auth/html.js";
import { getSessionUser } from "../routes/auth.js";
import { areServersEnabled, getSettings } from "../settings.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

const colorSchema = z.string().regex(COLOR_TOKEN_OR_HEX_RE).nullable();

const bannerCreateSchema = z.object({
  bodyHtml: z.string().min(1).max(ANNOUNCEMENT_BANNER_BODY_MAX),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(-1000).max(1000).optional(),
}).strict();

const bannerUpdateSchema = bannerCreateSchema.partial();

const scheduledCreateSchema = z.object({
  scheduleSpec: z.string().min(1).max(80),
  bodyMarkdown: z.string().min(1).max(SCHEDULED_ANNOUNCEMENT_BODY_MAX),
  bodyHtml: z.string().min(1).max(SCHEDULED_ANNOUNCEMENT_BODY_MAX),
  color: colorSchema.optional(),
  targetRoomId: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
}).strict();

const scheduledUpdateSchema = scheduledCreateSchema.partial();

/**
 * Best-effort server-scoped audit row (direct insert, mirrors `auditServer` in
 * routes/servers.ts). A logging failure never fails the action it records.
 */
async function auditServerAnnouncement(
  db: Db,
  entry: {
    serverId: string;
    actorUserId: string;
    action: string;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: nanoid(),
      actorUserId: entry.actorUserId,
      action: entry.action,
      metadataJson: entry.metadata ? JSON.stringify(entry.metadata) : null,
      serverId: entry.serverId,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[server-announcements] failed to record audit", { action: entry.action, err });
  }
}

/**
 * Resolve + gate the caller against `manage_announcements` for this server.
 * On any failure, sets the reply code and returns null so the handler can
 * `return { error }`. The flag is checked here so every route is inert
 * flag-off.
 */
async function gate(
  req: FastifyRequest,
  reply: FastifyReply,
  db: Db,
  serverId: string,
): Promise<{ meId: string; serverId: string } | null> {
  if (!areServersEnabled(await getSettings(db))) {
    reply.code(404);
    return null;
  }
  const me = await getSessionUser(req, db);
  if (!me) {
    reply.code(401);
    return null;
  }
  const { serverAuthority, serverCan } = await import("../servers/authority.js");
  const a = await serverAuthority(db, me, serverId);
  if (!a.server) {
    reply.code(404);
    return null;
  }
  if (!serverCan(a, "manage_announcements")) {
    reply.code(403);
    return null;
  }
  return { meId: me.id, serverId: a.server.id };
}

/**
 * Register the per-server announcements CRUD under `/servers/:id/announcements`.
 * Mounted once by `registerServerRoutes` (orchestrator wires the single call).
 */
export async function registerServerAnnouncementRoutes(
  app: FastifyInstance,
  db: Db,
  io: Io,
): Promise<void> {
  /* ---------- banners ---------- */

  app.get<{ Params: { id: string } }>(
    "/servers/:id/announcements/banners",
    async (req, reply) => {
      const g = await gate(req, reply, db, req.params.id);
      if (!g) return { error: "forbidden" };
      const list = await db
        .select()
        .from(announcementBanners)
        .where(eq(announcementBanners.serverId, g.serverId))
        .orderBy(asc(announcementBanners.sortOrder), asc(announcementBanners.createdAt));
      return {
        banners: list.map((r) => ({
          id: r.id,
          bodyHtml: r.bodyHtml,
          enabled: r.enabled,
          sortOrder: r.sortOrder,
          createdByUserId: r.createdByUserId,
          createdAt: +r.createdAt,
          updatedAt: +r.updatedAt,
        })),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/servers/:id/announcements/banners",
    async (req, reply) => {
      const g = await gate(req, reply, db, req.params.id);
      if (!g) return { error: "forbidden" };
      const body = bannerCreateSchema.parse(req.body);
      const id = nanoid();
      await db.insert(announcementBanners).values({
        id,
        bodyHtml: sanitizeBio(body.bodyHtml),
        enabled: body.enabled ?? true,
        sortOrder: body.sortOrder ?? 0,
        createdByUserId: g.meId,
        serverId: g.serverId,
      });
      io.emit("announcements:banners-changed");
      await auditServerAnnouncement(db, {
        serverId: g.serverId,
        actorUserId: g.meId,
        action: "server_announcement_banner_create",
        metadata: { id },
      });
      return { id };
    },
  );

  app.patch<{ Params: { id: string; bannerId: string }; Body: unknown }>(
    "/servers/:id/announcements/banners/:bannerId",
    async (req, reply) => {
      const g = await gate(req, reply, db, req.params.id);
      if (!g) return { error: "forbidden" };
      const body = bannerUpdateSchema.parse(req.body);
      // Scope the lookup so a row from another server is invisible (404),
      // never editable, even with a known id.
      const existing = (await db
        .select({ id: announcementBanners.id })
        .from(announcementBanners)
        .where(and(
          eq(announcementBanners.id, req.params.bannerId),
          eq(announcementBanners.serverId, g.serverId),
        ))
        .limit(1))[0];
      if (!existing) {
        reply.code(404);
        return { error: "not found" };
      }
      await db
        .update(announcementBanners)
        .set({
          ...(body.bodyHtml !== undefined ? { bodyHtml: sanitizeBio(body.bodyHtml) } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(announcementBanners.id, req.params.bannerId), eq(announcementBanners.serverId, g.serverId)));
      io.emit("announcements:banners-changed");
      await auditServerAnnouncement(db, {
        serverId: g.serverId,
        actorUserId: g.meId,
        action: "server_announcement_banner_update",
        metadata: { id: req.params.bannerId, keys: Object.keys(body) },
      });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; bannerId: string } }>(
    "/servers/:id/announcements/banners/:bannerId",
    async (req, reply) => {
      const g = await gate(req, reply, db, req.params.id);
      if (!g) return { error: "forbidden" };
      // server_id in the WHERE clause is the cross-server guard: a delete only
      // ever touches a row that belongs to this server.
      await db
        .delete(announcementBanners)
        .where(and(
          eq(announcementBanners.id, req.params.bannerId),
          eq(announcementBanners.serverId, g.serverId),
        ));
      io.emit("announcements:banners-changed");
      await auditServerAnnouncement(db, {
        serverId: g.serverId,
        actorUserId: g.meId,
        action: "server_announcement_banner_delete",
        metadata: { id: req.params.bannerId },
      });
      return { ok: true };
    },
  );

  /* ---------- scheduled announcements ---------- */

  // Target-room picker source, scoped to THIS server's rooms so the editor's
  // "target" dropdown can only ever schedule into a room this server owns.
  app.get<{ Params: { id: string } }>(
    "/servers/:id/announcements/rooms",
    async (req, reply) => {
      const g = await gate(req, reply, db, req.params.id);
      if (!g) return { error: "forbidden" };
      const all = await db
        .select({ id: rooms.id, name: rooms.name })
        .from(rooms)
        .where(eq(rooms.serverId, g.serverId))
        .orderBy(asc(rooms.name));
      return { rooms: all };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/servers/:id/announcements/scheduled",
    async (req, reply) => {
      const g = await gate(req, reply, db, req.params.id);
      if (!g) return { error: "forbidden" };
      const list = await db
        .select()
        .from(scheduledAnnouncements)
        .where(eq(scheduledAnnouncements.serverId, g.serverId))
        .orderBy(asc(scheduledAnnouncements.createdAt));
      return { scheduled: list.map(wireScheduled) };
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/servers/:id/announcements/scheduled",
    async (req, reply) => {
      const g = await gate(req, reply, db, req.params.id);
      if (!g) return { error: "forbidden" };
      const body = scheduledCreateSchema.parse(req.body);
      const parsed = parseScheduleSpec(body.scheduleSpec);
      if (!parsed.ok) {
        reply.code(400);
        return { error: parsed.message };
      }
      // A target room MUST belong to this server. Without the server_id clamp
      // an owner could aim a schedule at another community's room.
      if (body.targetRoomId) {
        const room = (await db
          .select({ id: rooms.id })
          .from(rooms)
          .where(and(eq(rooms.id, body.targetRoomId), eq(rooms.serverId, g.serverId)))
          .limit(1))[0];
        if (!room) {
          reply.code(400);
          return { error: "target room not found in this server" };
        }
      }
      const id = nanoid();
      // Recurring rows arm one interval AFTER creation (an "every 3h" reads as
      // "first ping 3h from now") so a test save doesn't fire immediately.
      const now = Date.now();
      const nextRunAt = parsed.parsed.kind === "interval"
        ? now + parsed.parsed.intervalMs
        : parsed.parsed.runAt;
      await db.insert(scheduledAnnouncements).values({
        id,
        scheduleSpec: body.scheduleSpec,
        kind: parsed.parsed.kind,
        intervalMs: parsed.parsed.kind === "interval" ? parsed.parsed.intervalMs : null,
        runAt: parsed.parsed.kind === "oneShot" ? parsed.parsed.runAt : null,
        lastRunAt: null,
        nextRunAt,
        bodyHtml: sanitizeBio(body.bodyHtml),
        bodyMarkdown: body.bodyMarkdown,
        color: body.color ?? null,
        targetRoomId: body.targetRoomId ?? null,
        enabled: body.enabled ?? true,
        createdByUserId: g.meId,
        // The load-bearing stamp: a NULL-target row fired by the shared
        // scheduler clamps its fan-out to `rooms.server_id = :id` because of
        // THIS column. Drop it and the row would fan across the platform
        // (server_id IS NULL) rooms instead.
        serverId: g.serverId,
      });
      await auditServerAnnouncement(db, {
        serverId: g.serverId,
        actorUserId: g.meId,
        action: "server_scheduled_announcement_create",
        metadata: { id, kind: parsed.parsed.kind, spec: body.scheduleSpec },
      });
      return { id };
    },
  );

  app.patch<{ Params: { id: string; schedId: string }; Body: unknown }>(
    "/servers/:id/announcements/scheduled/:schedId",
    async (req, reply) => {
      const g = await gate(req, reply, db, req.params.id);
      if (!g) return { error: "forbidden" };
      const body = scheduledUpdateSchema.parse(req.body);
      const existing = (await db
        .select()
        .from(scheduledAnnouncements)
        .where(and(
          eq(scheduledAnnouncements.id, req.params.schedId),
          eq(scheduledAnnouncements.serverId, g.serverId),
        ))
        .limit(1))[0];
      if (!existing) {
        reply.code(404);
        return { error: "not found" };
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.scheduleSpec !== undefined) {
        const parsed = parseScheduleSpec(body.scheduleSpec);
        if (!parsed.ok) {
          reply.code(400);
          return { error: parsed.message };
        }
        patch.scheduleSpec = body.scheduleSpec;
        patch.kind = parsed.parsed.kind;
        patch.intervalMs = parsed.parsed.kind === "interval" ? parsed.parsed.intervalMs : null;
        patch.runAt = parsed.parsed.kind === "oneShot" ? parsed.parsed.runAt : null;
        // Re-arm so editing the spec never triggers an immediate broadcast.
        const now = Date.now();
        patch.nextRunAt = parsed.parsed.kind === "interval"
          ? now + parsed.parsed.intervalMs
          : parsed.parsed.runAt;
        patch.lastRunAt = null;
      }
      if (body.targetRoomId !== undefined && body.targetRoomId !== null) {
        const room = (await db
          .select({ id: rooms.id })
          .from(rooms)
          .where(and(eq(rooms.id, body.targetRoomId), eq(rooms.serverId, g.serverId)))
          .limit(1))[0];
        if (!room) {
          reply.code(400);
          return { error: "target room not found in this server" };
        }
      }
      if (body.bodyHtml !== undefined) patch.bodyHtml = sanitizeBio(body.bodyHtml);
      if (body.bodyMarkdown !== undefined) patch.bodyMarkdown = body.bodyMarkdown;
      if (body.color !== undefined) patch.color = body.color;
      if (body.targetRoomId !== undefined) patch.targetRoomId = body.targetRoomId;
      if (body.enabled !== undefined) {
        patch.enabled = body.enabled;
        // Re-arm a re-enabled recurring row from now+interval; a re-enabled
        // one-shot stays inert (its runAt is in the past).
        if (body.enabled && !patch.scheduleSpec) {
          if (existing.kind === "interval" && existing.intervalMs) {
            patch.nextRunAt = Date.now() + existing.intervalMs;
          }
        } else if (!body.enabled) {
          patch.nextRunAt = null;
        }
      }
      await db
        .update(scheduledAnnouncements)
        .set(patch)
        .where(and(eq(scheduledAnnouncements.id, req.params.schedId), eq(scheduledAnnouncements.serverId, g.serverId)));
      await auditServerAnnouncement(db, {
        serverId: g.serverId,
        actorUserId: g.meId,
        action: "server_scheduled_announcement_update",
        metadata: { id: req.params.schedId, keys: Object.keys(body) },
      });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; schedId: string } }>(
    "/servers/:id/announcements/scheduled/:schedId",
    async (req, reply) => {
      const g = await gate(req, reply, db, req.params.id);
      if (!g) return { error: "forbidden" };
      await db
        .delete(scheduledAnnouncements)
        .where(and(
          eq(scheduledAnnouncements.id, req.params.schedId),
          eq(scheduledAnnouncements.serverId, g.serverId),
        ));
      await auditServerAnnouncement(db, {
        serverId: g.serverId,
        actorUserId: g.meId,
        action: "server_scheduled_announcement_delete",
        metadata: { id: req.params.schedId },
      });
      return { ok: true };
    },
  );
}

function wireScheduled(r: typeof scheduledAnnouncements.$inferSelect) {
  return {
    id: r.id,
    scheduleSpec: r.scheduleSpec,
    kind: r.kind,
    intervalMs: r.intervalMs,
    runAt: r.runAt,
    lastRunAt: r.lastRunAt,
    nextRunAt: r.nextRunAt,
    bodyHtml: r.bodyHtml,
    bodyMarkdown: r.bodyMarkdown,
    color: r.color,
    targetRoomId: r.targetRoomId,
    enabled: r.enabled,
    createdByUserId: r.createdByUserId,
    createdAt: +r.createdAt,
    updatedAt: +r.updatedAt,
  };
}
