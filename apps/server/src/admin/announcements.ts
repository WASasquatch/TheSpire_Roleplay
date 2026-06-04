import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { and, asc, eq, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Server as IoServer } from "socket.io";
import type {
  ClientToServerEvents,
  PermissionKey,
  Role,
  ServerToClientEvents,
} from "@thekeep/shared";
import {
  ANNOUNCEMENT_BANNER_BODY_MAX,
  COLOR_TOKEN_OR_HEX_RE,
  SCHEDULED_ANNOUNCEMENT_BODY_MAX,
  parseScheduleSpec,
} from "@thekeep/shared";
import { announcementBanners, rooms, scheduledAnnouncements, users } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { requireSessionPermission } from "../auth/requireSessionPermission.js";
import { sanitizeBio } from "../auth/html.js";
import { recordAudit } from "../audit.js";
import { addMessageDirect } from "../realtime/broadcast.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

interface SessionUserCtx {
  id: string;
  role: Role;
}

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
 * CRUD + scheduler launcher for the two announcement surfaces.
 *
 *   - `announcement_banners` — admin-curated rotating banners the
 *     chat shell paints above the timeline. Markdown is converted to
 *     HTML client-side at save time; the storage shape is sanitized
 *     HTML so the read path is one shape.
 *
 *   - `scheduled_announcements` — cron-like rows the in-process
 *     scheduler tick fires through the same `/announce` code path
 *     that the in-chat builtin uses. The spec is parsed at save
 *     time (server) AND re-parsed in the editor (client) so a
 *     malformed spec rejects with the same error text on both sides.
 *
 * Both expose three permission gates:
 *   - `view_admin_announcements` — admin tab visibility
 *   - `manage_banner_announcements` — banner CRUD
 *   - `manage_scheduled_announcements` — schedule CRUD
 *
 * The public-banners route is mounted separately in
 * `routes/announcements.ts` so anonymous splash visitors can paint
 * the marquee without an auth handshake.
 */
export async function registerAdminAnnouncementRoutes(
  app: FastifyInstance,
  deps: { db: Db; io: Io },
): Promise<void> {
  const { db, io } = deps;

  const requirePermission = (req: FastifyRequest, reply: FastifyReply, key: PermissionKey) =>
    requireSessionPermission(req, reply, key, db);

  /* ---------- banners ---------- */

  app.get("/admin/announcements/banners", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_announcements"))) return;
    const rows = await db
      .select()
      .from(announcementBanners)
      .orderBy(asc(announcementBanners.sortOrder), asc(announcementBanners.createdAt));
    return {
      banners: rows.map((r) => ({
        id: r.id,
        bodyHtml: r.bodyHtml,
        enabled: r.enabled,
        sortOrder: r.sortOrder,
        createdByUserId: r.createdByUserId,
        createdAt: +r.createdAt,
        updatedAt: +r.updatedAt,
      })),
    };
  });

  app.post<{ Body: unknown }>("/admin/announcements/banners", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_banner_announcements"))) return;
    const body = bannerCreateSchema.parse(req.body);
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    const id = nanoid();
    const safeHtml = sanitizeBio(body.bodyHtml);
    await db.insert(announcementBanners).values({
      id,
      bodyHtml: safeHtml,
      enabled: body.enabled ?? true,
      sortOrder: body.sortOrder ?? 0,
      createdByUserId: sessionUser.id,
    });
    io.emit("announcements:banners-changed");
    await recordAudit(db, {
      actorUserId: sessionUser.id,
      action: "announcement_banner_create",
      metadata: { id },
    });
    return { id };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/admin/announcements/banners/:id",
    async (req, reply) => {
      if (!(await requirePermission(req, reply, "manage_banner_announcements"))) return;
      const body = bannerUpdateSchema.parse(req.body);
      const existing = (await db
        .select()
        .from(announcementBanners)
        .where(eq(announcementBanners.id, req.params.id))
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
        .where(eq(announcementBanners.id, req.params.id));
      io.emit("announcements:banners-changed");
      const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
      await recordAudit(db, {
        actorUserId: sessionUser.id,
        action: "announcement_banner_update",
        metadata: { id: req.params.id, keys: Object.keys(body) },
      });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/announcements/banners/:id",
    async (req, reply) => {
      if (!(await requirePermission(req, reply, "manage_banner_announcements"))) return;
      await db.delete(announcementBanners).where(eq(announcementBanners.id, req.params.id));
      io.emit("announcements:banners-changed");
      const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
      await recordAudit(db, {
        actorUserId: sessionUser.id,
        action: "announcement_banner_delete",
        metadata: { id: req.params.id },
      });
      return { ok: true };
    },
  );

  /* ---------- scheduled announcements ---------- */

  // Lightweight target-room picker source. Returns `(id, name)` for
  // every room so the scheduler editor's "target" dropdown can
  // populate without forcing the announcement admin to also hold
  // `view_admin_rooms`. Gated on `view_admin_announcements` so
  // anyone who can SEE the tab can read the picker options.
  app.get("/admin/announcements/rooms", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_announcements"))) return;
    const all = await db
      .select({ id: rooms.id, name: rooms.name })
      .from(rooms)
      .orderBy(asc(rooms.name));
    return { rooms: all };
  });

  app.get("/admin/announcements/scheduled", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_announcements"))) return;
    const rows = await db
      .select()
      .from(scheduledAnnouncements)
      .orderBy(asc(scheduledAnnouncements.createdAt));
    return {
      scheduled: rows.map(wireScheduled),
    };
  });

  app.post<{ Body: unknown }>("/admin/announcements/scheduled", async (req, reply) => {
    if (!(await requirePermission(req, reply, "manage_scheduled_announcements"))) return;
    const body = scheduledCreateSchema.parse(req.body);
    const parsed = parseScheduleSpec(body.scheduleSpec);
    if (!parsed.ok) {
      reply.code(400);
      return { error: parsed.message };
    }
    if (body.targetRoomId) {
      const room = (await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(eq(rooms.id, body.targetRoomId))
        .limit(1))[0];
      if (!room) {
        reply.code(400);
        return { error: "target room not found" };
      }
    }
    const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
    const id = nanoid();
    // For interval rows the first fire is one interval AFTER creation
    // (admin's "every 3h" reads as "first ping 3h from now"); a
    // create+immediate-fire would surprise the admin who's just
    // testing the editor.
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
      createdByUserId: sessionUser.id,
    });
    await recordAudit(db, {
      actorUserId: sessionUser.id,
      action: "scheduled_announcement_create",
      metadata: { id, kind: parsed.parsed.kind, spec: body.scheduleSpec },
    });
    return { id };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/admin/announcements/scheduled/:id",
    async (req, reply) => {
      if (!(await requirePermission(req, reply, "manage_scheduled_announcements"))) return;
      const body = scheduledUpdateSchema.parse(req.body);
      const existing = (await db
        .select()
        .from(scheduledAnnouncements)
        .where(eq(scheduledAnnouncements.id, req.params.id))
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
        // Re-arm the next-fire when the schedule changes. Recurring:
        // next fire is one full interval out so an admin who edits
        // the spec doesn't accidentally trigger an immediate broadcast.
        const now = Date.now();
        patch.nextRunAt = parsed.parsed.kind === "interval"
          ? now + parsed.parsed.intervalMs
          : parsed.parsed.runAt;
        patch.lastRunAt = null;
      }
      if (body.bodyHtml !== undefined) patch.bodyHtml = sanitizeBio(body.bodyHtml);
      if (body.bodyMarkdown !== undefined) patch.bodyMarkdown = body.bodyMarkdown;
      if (body.color !== undefined) patch.color = body.color;
      if (body.targetRoomId !== undefined) patch.targetRoomId = body.targetRoomId;
      if (body.enabled !== undefined) {
        patch.enabled = body.enabled;
        // Re-arming a previously-completed row: a recurring row whose
        // owner toggles it back on resumes from "now + interval", and
        // a one-shot stays inert (its runAt is in the past now).
        if (body.enabled && !patch.scheduleSpec) {
          const kind = existing.kind;
          if (kind === "interval" && existing.intervalMs) {
            patch.nextRunAt = Date.now() + existing.intervalMs;
          }
        } else if (!body.enabled) {
          patch.nextRunAt = null;
        }
      }
      await db
        .update(scheduledAnnouncements)
        .set(patch)
        .where(eq(scheduledAnnouncements.id, req.params.id));
      const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
      await recordAudit(db, {
        actorUserId: sessionUser.id,
        action: "scheduled_announcement_update",
        metadata: { id: req.params.id, keys: Object.keys(body) },
      });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/announcements/scheduled/:id",
    async (req, reply) => {
      if (!(await requirePermission(req, reply, "manage_scheduled_announcements"))) return;
      await db.delete(scheduledAnnouncements).where(eq(scheduledAnnouncements.id, req.params.id));
      const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
      await recordAudit(db, {
        actorUserId: sessionUser.id,
        action: "scheduled_announcement_delete",
        metadata: { id: req.params.id },
      });
      return { ok: true };
    },
  );

  // Manual fire — lets the admin verify their schedule's content +
  // target without waiting on the tick. Does NOT advance the
  // schedule's bookkeeping (lastRunAt / nextRunAt stay where they
  // are) so a test fire of an "every 3h" row doesn't push the next
  // automatic broadcast out by another 3h. The audit row carries
  // `manual: true` so the log distinguishes admin tests from
  // scheduler-driven fires.
  app.post<{ Params: { id: string } }>(
    "/admin/announcements/scheduled/:id/fire",
    async (req, reply) => {
      if (!(await requirePermission(req, reply, "manage_scheduled_announcements"))) return;
      const row = (await db
        .select()
        .from(scheduledAnnouncements)
        .where(eq(scheduledAnnouncements.id, req.params.id))
        .limit(1))[0];
      if (!row) {
        reply.code(404);
        return { error: "not found" };
      }
      try {
        await fireScheduled(db, io, row, Date.now(), { skipAdvance: true });
      } catch (err) {
        reply.code(500);
        // eslint-disable-next-line no-console
        console.error("[announcements] manual fire failed", { id: row.id, err });
        return { error: err instanceof Error ? err.message : "fire failed" };
      }
      const sessionUser = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;
      await recordAudit(db, {
        actorUserId: sessionUser.id,
        action: "scheduled_announcement_update",
        metadata: { id: req.params.id, manual: true },
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

/* ============================================================
 *  Scheduler tick — fires due `scheduled_announcements` rows
 *  through the same code path the in-chat `/announce` builtin
 *  uses (`addMessageDirect`, which is the broadcast.ts shape
 *  that skips the slash-command parser and writes a message
 *  row + emits `message:new`).
 * ============================================================ */

/**
 * How often we poll for due rows. 15s gives a one-minute schedule
 * a worst-case ~15s slip past its target — fine for an
 * admin-authored broadcast and short enough that a freshly-saved
 * `1m` interval ("does this even work?") fires within roughly a
 * minute instead of waiting two full 60s ticks. Sub-minute schedules
 * are still rejected by the spec parser, so the CPU floor of the
 * check itself (one indexed query against `next_run_at`) stays
 * trivially small.
 */
const SCHEDULER_TICK_MS = 15_000;

let schedulerTimer: NodeJS.Timeout | null = null;

export function startAnnouncementScheduler(deps: { db: Db; io: Io }): () => void {
  const { db, io } = deps;
  if (schedulerTimer) {
    // Idempotent — multiple boot paths (dev hot-reload, tests)
    // shouldn't stack timers and double-fire every row.
    return () => stopAnnouncementScheduler();
  }
  // First tick fires on the next event loop turn so the boot path
  // doesn't block waiting on `runDueAnnouncements`; subsequent ticks
  // are spaced SCHEDULER_TICK_MS apart. Boot log is a one-shot so an
  // operator can confirm the timer engaged after deploy without
  // tailing every tick.
  // eslint-disable-next-line no-console
  console.info("[announcements] scheduler started", { tickMs: SCHEDULER_TICK_MS });
  schedulerTimer = setInterval(() => { void runDueAnnouncements({ db, io }); }, SCHEDULER_TICK_MS);
  setImmediate(() => { void runDueAnnouncements({ db, io }); });
  return () => stopAnnouncementScheduler();
}

export function stopAnnouncementScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

async function runDueAnnouncements(deps: { db: Db; io: Io }): Promise<void> {
  const { db, io } = deps;
  const now = Date.now();
  let dueRows: (typeof scheduledAnnouncements.$inferSelect)[];
  try {
    dueRows = await db
      .select()
      .from(scheduledAnnouncements)
      .where(and(
        eq(scheduledAnnouncements.enabled, true),
        lte(scheduledAnnouncements.nextRunAt, now),
      ));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[announcements] scheduler tick failed to read due rows", err);
    return;
  }
  if (dueRows.length === 0) return;
  // eslint-disable-next-line no-console
  console.info("[announcements] firing due rows", {
    count: dueRows.length,
    ids: dueRows.map((r) => r.id),
  });
  for (const row of dueRows) {
    try {
      await fireScheduled(db, io, row, now);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[announcements] failed to fire scheduled row", { id: row.id, err });
    }
  }
}

async function fireScheduled(
  db: Db,
  io: Io,
  row: typeof scheduledAnnouncements.$inferSelect,
  now: number,
  opts: { skipAdvance?: boolean } = {},
): Promise<void> {
  // Resolve the author display name once — the row stores the
  // creator id, and we want the chat line to read with their
  // username (matching the audit-coherent posture every other
  // server-fired event uses).
  //
  // Fallback chain: row's `created_by_user_id` (alive) → the
  // 'system' sentinel user (lookup by username, NOT the literal
  // string — `messages.user_id` is a FK to `users.id` and the
  // sentinel's id is a nanoid). If neither resolves we bail
  // silently rather than throw an FK violation that would tank
  // the entire tick.
  const author = row.createdByUserId
    ? (await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(eq(users.id, row.createdByUserId))
        .limit(1))[0]
    : null;
  let actorId: string | null = author?.id ?? null;
  let actorName: string = author?.username ?? "system";
  if (!actorId) {
    const sys = (await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, "system"))
      .limit(1))[0];
    if (!sys) {
      // eslint-disable-next-line no-console
      console.error(
        "[announcements] no creator and no system sentinel — skipping fire",
        { id: row.id },
      );
      return;
    }
    actorId = sys.id;
  }

  // Resolve the target-room set. NULL targetRoomId = sitewide; we
  // iterate every room. Otherwise just the one. Either way we fan
  // through addMessageDirect so each room ends up with its own
  // persisted history row + filtered emit, matching the manual
  // `/announce all` behavior.
  let targetRoomIds: string[];
  if (row.targetRoomId) {
    targetRoomIds = [row.targetRoomId];
  } else {
    const allRooms = await db.select({ id: rooms.id }).from(rooms);
    targetRoomIds = allRooms.map((r) => r.id);
  }
  for (const rid of targetRoomIds) {
    await addMessageDirect({
      db,
      io,
      roomId: rid,
      userId: actorId,
      displayName: actorName,
      kind: "announce",
      body: row.bodyMarkdown,
      bodyHtml: row.bodyHtml,
      color: row.color,
    });
  }
  // eslint-disable-next-line no-console
  console.info("[announcements] fired", {
    id: row.id,
    kind: row.kind,
    rooms: targetRoomIds.length,
    manual: !!opts.skipAdvance,
  });

  // Manual "Fire now" path — leave bookkeeping alone so the test
  // broadcast doesn't push the next automatic fire out.
  if (opts.skipAdvance) return;

  // Advance bookkeeping. Recurring rows arm the next fire one
  // interval out from NOW (not from the originally-planned firing
  // time) so a missed tick — server restart, a long-running migration
  // — doesn't catch up by hammering the chat with back-to-back
  // broadcasts. One-shots disable themselves and clear nextRunAt so
  // the scheduler never re-fetches them.
  if (row.kind === "interval" && row.intervalMs) {
    await db
      .update(scheduledAnnouncements)
      .set({ lastRunAt: now, nextRunAt: now + row.intervalMs })
      .where(eq(scheduledAnnouncements.id, row.id));
  } else {
    await db
      .update(scheduledAnnouncements)
      .set({ lastRunAt: now, nextRunAt: null, enabled: false })
      .where(eq(scheduledAnnouncements.id, row.id));
  }
}
