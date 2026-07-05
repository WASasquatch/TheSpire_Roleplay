/**
 * Per-server Events (community calendar) — Multi-Server Lift.
 *
 * The server-scoped calendar: a server owner/mod holding `manage_events`
 * schedules one-off events (a session, a tournament, a lore night); any
 * participant RSVPs going/maybe/declined as an identity of their choosing, and
 * an opt-in reminder pings the going/maybe crowd once, a lead-time before the
 * event starts. Structurally this clones `servers/announcements.ts`:
 *
 *   GET    /servers/:id/events?from&to   list (viewer RSVP + aggregate counts),
 *                                        readable by any participant.
 *   POST   /servers/:id/events           create (manage_events)
 *   PATCH  /servers/:id/events/:eventId  edit / cancel (manage_events)
 *   DELETE /servers/:id/events/:eventId  delete (manage_events)
 *   PUT    /servers/:id/events/:eventId/rsvp  upsert the caller's RSVP.
 *
 * The reminder sweep ({@link sweepEventRemindersOnce}) mirrors
 * admin/announcements.ts' `runDueAnnouncements`: it finds scheduled events whose
 * reminder window has opened and not yet fired, notifies every going/maybe
 * RSVP (deduped by account), and stamps `reminderFiredAt` so it fires at most
 * once. index.ts starts it beside the announcement scheduler.
 *
 * Flag-gated + cross-server safe: every route 404s when `!serversEnabled` and
 * scopes every row on `server_id = :id`; a client-supplied event id from
 * another server is invisible (404), never editable.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Server as IoServer } from "socket.io";
import type {
  ClientToServerEvents,
  ServerEvent,
  ServerEventRsvp,
  ServerToClientEvents,
} from "@thekeep/shared";
import {
  auditLog,
  characters,
  forums,
  rooms,
  serverEventRsvps,
  serverEvents,
  users,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import { sanitizeBio } from "../auth/html.js";
import { getSessionUser } from "../routes/auth.js";
import { areServersEnabled, getSettings } from "../settings.js";
import { serverAuthority, serverCan } from "./authority.js";
import { notifyMany, type NotifyInput } from "../notifications/engine.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

const TITLE_MAX = 140;
const DESCRIPTION_MAX = 8000;
/** RSVP status vocabulary (mirrors the shared ServerEventRsvpStatus union). */
const RSVP_STATUSES = ["going", "maybe", "declined"] as const;
/** Allowed reminder leads (ms). null = no reminder. The client offers these. */
const REMINDER_LEADS_MS = new Set<number>([
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  24 * 60 * 60_000,
]);

const createSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  descriptionHtml: z.string().max(DESCRIPTION_MAX).nullable().optional(),
  startsAt: z.number().int().positive(),
  endsAt: z.number().int().positive().nullable().optional(),
  hostCharacterId: z.string().nullable().optional(),
  linkedRoomId: z.string().nullable().optional(),
  linkedForumId: z.string().nullable().optional(),
  reminderLeadMs: z.number().int().positive().nullable().optional(),
}).strict();

const updateSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX).optional(),
  descriptionHtml: z.string().max(DESCRIPTION_MAX).nullable().optional(),
  startsAt: z.number().int().positive().optional(),
  endsAt: z.number().int().positive().nullable().optional(),
  hostCharacterId: z.string().nullable().optional(),
  linkedRoomId: z.string().nullable().optional(),
  linkedForumId: z.string().nullable().optional(),
  reminderLeadMs: z.number().int().positive().nullable().optional(),
  // Lifecycle change (cancel / re-schedule). Only these are settable here.
  status: z.enum(["scheduled", "live", "ended", "cancelled"]).optional(),
}).strict();

const rsvpSchema = z.object({
  status: z.enum(RSVP_STATUSES),
  characterId: z.string().nullable().optional(),
}).strict();

/**
 * Best-effort server-scoped audit row (direct insert, mirrors `auditServer` in
 * routes/servers.ts). A logging failure never fails the action it records.
 */
async function auditServerEvent(
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
    console.error("[server-events] failed to record audit", { action: entry.action, err });
  }
}

/** Serialize a stored event row to the shared wire shape. */
function wireEvent(r: typeof serverEvents.$inferSelect): ServerEvent {
  return {
    id: r.id,
    serverId: r.serverId,
    createdByUserId: r.createdByUserId ?? null,
    hostCharacterId: r.hostCharacterId ?? null,
    title: r.title,
    descriptionHtml: r.descriptionHtml ?? null,
    startsAt: +r.startsAt,
    endsAt: r.endsAt != null ? +r.endsAt : null,
    linkedRoomId: r.linkedRoomId ?? null,
    linkedForumId: r.linkedForumId ?? null,
    status: r.status as ServerEvent["status"],
    reminderLeadMs: r.reminderLeadMs != null ? +r.reminderLeadMs : null,
    reminderFiredAt: r.reminderFiredAt != null ? +r.reminderFiredAt : null,
    recurrenceJson: r.recurrenceJson ?? null,
    createdAt: +r.createdAt,
    updatedAt: +r.updatedAt,
  };
}

/** Serialize an RSVP row to the shared wire shape. */
function wireRsvp(r: typeof serverEventRsvps.$inferSelect): ServerEventRsvp {
  return {
    id: r.id,
    eventId: r.eventId,
    userId: r.userId,
    characterId: r.characterId ?? null,
    status: r.status as ServerEventRsvp["status"],
    updatedAt: +r.updatedAt,
  };
}

/**
 * Resolve the caller + this server's authority. `manage` true requires the
 * `manage_events` permission; otherwise the caller only needs to be able to
 * participate (read/RSVP). Sets the reply code + returns null on failure so the
 * handler can `return { error }`. Flag-checked here so every route is inert
 * when servers are disabled.
 */
async function gate(
  req: FastifyRequest,
  reply: FastifyReply,
  db: Db,
  serverId: string,
  opts: { manage: boolean },
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
  const a = await serverAuthority(db, me, serverId);
  if (!a.server) {
    reply.code(404);
    return null;
  }
  if (opts.manage) {
    if (!serverCan(a, "manage_events")) {
      reply.code(403);
      return null;
    }
  } else if (!a.canParticipate) {
    // Reading/RSVPing requires being able to participate in the server (member
    // of an application/invite server, any signed-in user on an open server,
    // never a banned/moderated-out user).
    reply.code(403);
    return null;
  }
  return { meId: me.id, serverId: a.server.id };
}

/** A host character must belong to the caller (never trust a client id). */
async function callerOwnsCharacter(db: Db, userId: string, characterId: string): Promise<boolean> {
  const row = (await db
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.userId, userId)))
    .limit(1))[0];
  return !!row;
}

/** A linked room must belong to THIS server. */
async function roomInServer(db: Db, serverId: string, roomId: string): Promise<boolean> {
  const row = (await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.id, roomId), eq(rooms.serverId, serverId)))
    .limit(1))[0];
  return !!row;
}

/** A linked forum must belong to THIS server. */
async function forumInServer(db: Db, serverId: string, forumId: string): Promise<boolean> {
  const row = (await db
    .select({ id: forums.id })
    .from(forums)
    .where(and(eq(forums.id, forumId), eq(forums.serverId, serverId)))
    .limit(1))[0];
  return !!row;
}

/**
 * Register the per-server events CRUD + RSVP under `/servers/:id/events`.
 * Mounted once by `registerServerRoutes`.
 */
export async function registerServerEventRoutes(
  app: FastifyInstance,
  db: Db,
  _io: Io,
): Promise<void> {
  /* ---------- list ---------- */

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    "/servers/:id/events",
    async (req, reply) => {
      const g = await gate(req, reply, db, req.params.id, { manage: false });
      if (!g) return { error: "forbidden" };

      // Optional [from,to] window over startsAt (ms epoch). Absent bounds are
      // open-ended; the server_events_server_time_idx covers (serverId,startsAt).
      const from = req.query.from ? Number(req.query.from) : null;
      const to = req.query.to ? Number(req.query.to) : null;
      const conds = [eq(serverEvents.serverId, g.serverId)];
      if (from != null && Number.isFinite(from)) conds.push(gte(serverEvents.startsAt, from));
      if (to != null && Number.isFinite(to)) conds.push(lte(serverEvents.startsAt, to));

      const rows = await db
        .select()
        .from(serverEvents)
        .where(and(...conds))
        .orderBy(asc(serverEvents.startsAt));

      const eventIds = rows.map((r) => r.id);

      // Aggregate RSVP counts per event/status (one grouped read), plus the
      // viewer's own RSVP rows across their identities.
      const countsBy = new Map<string, { going: number; maybe: number; declined: number }>();
      const myRsvpsBy = new Map<string, ServerEventRsvp[]>();
      if (eventIds.length) {
        const counts = await db
          .select({
            eventId: serverEventRsvps.eventId,
            status: serverEventRsvps.status,
            n: sql<number>`count(*)`,
          })
          .from(serverEventRsvps)
          .where(inArray(serverEventRsvps.eventId, eventIds))
          .groupBy(serverEventRsvps.eventId, serverEventRsvps.status);
        for (const c of counts) {
          const bucket = countsBy.get(c.eventId) ?? { going: 0, maybe: 0, declined: 0 };
          if (c.status === "going" || c.status === "maybe" || c.status === "declined") {
            bucket[c.status] = Number(c.n);
          }
          countsBy.set(c.eventId, bucket);
        }
        const mine = await db
          .select()
          .from(serverEventRsvps)
          .where(and(
            inArray(serverEventRsvps.eventId, eventIds),
            eq(serverEventRsvps.userId, g.meId),
          ));
        for (const m of mine) {
          const list = myRsvpsBy.get(m.eventId) ?? [];
          list.push(wireRsvp(m));
          myRsvpsBy.set(m.eventId, list);
        }
      }

      return {
        events: rows.map((r) => ({
          event: wireEvent(r),
          counts: countsBy.get(r.id) ?? { going: 0, maybe: 0, declined: 0 },
          myRsvps: myRsvpsBy.get(r.id) ?? [],
        })),
      };
    },
  );

  /* ---------- create ---------- */

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/servers/:id/events",
    async (req, reply) => {
      const g = await gate(req, reply, db, req.params.id, { manage: true });
      if (!g) return { error: "forbidden" };
      const body = createSchema.parse(req.body);

      if (body.endsAt != null && body.endsAt <= body.startsAt) {
        reply.code(400);
        return { error: "The event's end time must be after its start time." };
      }
      if (body.reminderLeadMs != null && !REMINDER_LEADS_MS.has(body.reminderLeadMs)) {
        reply.code(400);
        return { error: "Unsupported reminder lead time." };
      }
      if (body.hostCharacterId && !(await callerOwnsCharacter(db, g.meId, body.hostCharacterId))) {
        reply.code(400);
        return { error: "That host character isn't yours." };
      }
      if (body.linkedRoomId && !(await roomInServer(db, g.serverId, body.linkedRoomId))) {
        reply.code(400);
        return { error: "The linked room isn't in this server." };
      }
      if (body.linkedForumId && !(await forumInServer(db, g.serverId, body.linkedForumId))) {
        reply.code(400);
        return { error: "The linked forum isn't in this server." };
      }

      const id = nanoid();
      await db.insert(serverEvents).values({
        id,
        serverId: g.serverId,
        createdByUserId: g.meId,
        hostCharacterId: body.hostCharacterId ?? null,
        title: body.title,
        descriptionHtml: body.descriptionHtml ? sanitizeBio(body.descriptionHtml) : null,
        startsAt: body.startsAt,
        endsAt: body.endsAt ?? null,
        linkedRoomId: body.linkedRoomId ?? null,
        linkedForumId: body.linkedForumId ?? null,
        reminderLeadMs: body.reminderLeadMs ?? null,
      });
      await auditServerEvent(db, {
        serverId: g.serverId,
        actorUserId: g.meId,
        action: "server_event_create",
        metadata: { id, title: body.title, startsAt: body.startsAt },
      });
      const row = (await db.select().from(serverEvents).where(eq(serverEvents.id, id)).limit(1))[0];
      return { event: row ? wireEvent(row) : null, id };
    },
  );

  /* ---------- edit / cancel ---------- */

  app.patch<{ Params: { id: string; eventId: string }; Body: unknown }>(
    "/servers/:id/events/:eventId",
    async (req, reply) => {
      const g = await gate(req, reply, db, req.params.id, { manage: true });
      if (!g) return { error: "forbidden" };
      const body = updateSchema.parse(req.body);

      // Scope the lookup so an event from another server is invisible (404),
      // never editable, even with a known id.
      const existing = (await db
        .select()
        .from(serverEvents)
        .where(and(eq(serverEvents.id, req.params.eventId), eq(serverEvents.serverId, g.serverId)))
        .limit(1))[0];
      if (!existing) {
        reply.code(404);
        return { error: "not found" };
      }

      const nextStart = body.startsAt ?? +existing.startsAt;
      const nextEnd = body.endsAt !== undefined ? body.endsAt : (existing.endsAt != null ? +existing.endsAt : null);
      if (nextEnd != null && nextEnd <= nextStart) {
        reply.code(400);
        return { error: "The event's end time must be after its start time." };
      }
      if (body.reminderLeadMs != null && !REMINDER_LEADS_MS.has(body.reminderLeadMs)) {
        reply.code(400);
        return { error: "Unsupported reminder lead time." };
      }
      if (body.hostCharacterId && !(await callerOwnsCharacter(db, g.meId, body.hostCharacterId))) {
        reply.code(400);
        return { error: "That host character isn't yours." };
      }
      if (body.linkedRoomId && !(await roomInServer(db, g.serverId, body.linkedRoomId))) {
        reply.code(400);
        return { error: "The linked room isn't in this server." };
      }
      if (body.linkedForumId && !(await forumInServer(db, g.serverId, body.linkedForumId))) {
        reply.code(400);
        return { error: "The linked forum isn't in this server." };
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.title !== undefined) patch.title = body.title;
      if (body.descriptionHtml !== undefined) {
        patch.descriptionHtml = body.descriptionHtml ? sanitizeBio(body.descriptionHtml) : null;
      }
      if (body.startsAt !== undefined) patch.startsAt = body.startsAt;
      if (body.endsAt !== undefined) patch.endsAt = body.endsAt;
      if (body.hostCharacterId !== undefined) patch.hostCharacterId = body.hostCharacterId;
      if (body.linkedRoomId !== undefined) patch.linkedRoomId = body.linkedRoomId;
      if (body.linkedForumId !== undefined) patch.linkedForumId = body.linkedForumId;
      if (body.status !== undefined) patch.status = body.status;
      if (body.reminderLeadMs !== undefined) {
        patch.reminderLeadMs = body.reminderLeadMs;
        // Re-arm: changing the lead (or clearing it) resets the once-only fire
        // guard so an edited event can still remind. A cancelled event never
        // reminds regardless (the sweep skips non-scheduled rows).
        patch.reminderFiredAt = null;
      }
      // Moving the start time re-arms the reminder too (the window shifted).
      if (body.startsAt !== undefined && body.reminderLeadMs === undefined) {
        patch.reminderFiredAt = null;
      }

      await db
        .update(serverEvents)
        .set(patch)
        .where(and(eq(serverEvents.id, req.params.eventId), eq(serverEvents.serverId, g.serverId)));
      await auditServerEvent(db, {
        serverId: g.serverId,
        actorUserId: g.meId,
        action: "server_event_update",
        metadata: { id: req.params.eventId, keys: Object.keys(body) },
      });
      const row = (await db.select().from(serverEvents).where(eq(serverEvents.id, req.params.eventId)).limit(1))[0];
      return { event: row ? wireEvent(row) : null };
    },
  );

  /* ---------- delete ---------- */

  app.delete<{ Params: { id: string; eventId: string } }>(
    "/servers/:id/events/:eventId",
    async (req, reply) => {
      const g = await gate(req, reply, db, req.params.id, { manage: true });
      if (!g) return { error: "forbidden" };
      // server_id in the WHERE clause is the cross-server guard. RSVP rows cascade
      // via the FK (server_event_rsvps.event_id ON DELETE CASCADE).
      await db
        .delete(serverEvents)
        .where(and(eq(serverEvents.id, req.params.eventId), eq(serverEvents.serverId, g.serverId)));
      await auditServerEvent(db, {
        serverId: g.serverId,
        actorUserId: g.meId,
        action: "server_event_delete",
        metadata: { id: req.params.eventId },
      });
      return { ok: true };
    },
  );

  /* ---------- RSVP (any participant) ---------- */

  app.put<{ Params: { id: string; eventId: string }; Body: unknown }>(
    "/servers/:id/events/:eventId/rsvp",
    async (req, reply) => {
      const g = await gate(req, reply, db, req.params.id, { manage: false });
      if (!g) return { error: "forbidden" };
      const body = rsvpSchema.parse(req.body);

      // The event must exist in THIS server (scoped lookup).
      const event = (await db
        .select({ id: serverEvents.id, status: serverEvents.status })
        .from(serverEvents)
        .where(and(eq(serverEvents.id, req.params.eventId), eq(serverEvents.serverId, g.serverId)))
        .limit(1))[0];
      if (!event) {
        reply.code(404);
        return { error: "not found" };
      }
      if (event.status === "cancelled" || event.status === "ended") {
        reply.code(409);
        return { error: "This event is closed to RSVPs." };
      }
      const characterId = body.characterId ?? null;
      if (characterId && !(await callerOwnsCharacter(db, g.meId, characterId))) {
        reply.code(400);
        return { error: "That character isn't yours." };
      }

      // Upsert per identity. The DB unique (eventId,userId,characterId) treats a
      // NULL characterId as DISTINCT, so an OOC RSVP can't ride onConflict — we
      // enforce OOC-single here: find any existing row for this identity and
      // UPDATE it, else INSERT.
      const existing = (await db
        .select({ id: serverEventRsvps.id })
        .from(serverEventRsvps)
        .where(and(
          eq(serverEventRsvps.eventId, req.params.eventId),
          eq(serverEventRsvps.userId, g.meId),
          characterId === null
            ? isNull(serverEventRsvps.characterId)
            : eq(serverEventRsvps.characterId, characterId),
        ))
        .limit(1))[0];

      if (existing) {
        await db
          .update(serverEventRsvps)
          .set({ status: body.status, updatedAt: new Date() })
          .where(eq(serverEventRsvps.id, existing.id));
      } else {
        await db.insert(serverEventRsvps).values({
          id: nanoid(),
          eventId: req.params.eventId,
          userId: g.meId,
          characterId,
          status: body.status,
        });
      }

      // Return this event's fresh counts + the caller's RSVP rows so the client
      // can reconcile without a full reload.
      const counts = { going: 0, maybe: 0, declined: 0 };
      for (const c of await db
        .select({ status: serverEventRsvps.status, n: sql<number>`count(*)` })
        .from(serverEventRsvps)
        .where(eq(serverEventRsvps.eventId, req.params.eventId))
        .groupBy(serverEventRsvps.status)) {
        if (c.status === "going" || c.status === "maybe" || c.status === "declined") {
          counts[c.status] = Number(c.n);
        }
      }
      const myRsvps = (await db
        .select()
        .from(serverEventRsvps)
        .where(and(eq(serverEventRsvps.eventId, req.params.eventId), eq(serverEventRsvps.userId, g.meId))))
        .map(wireRsvp);
      return { counts, myRsvps };
    },
  );
}

/* ============================================================
 *  Reminder sweep — fires the opt-in reminder for events whose
 *  window has opened. Clones admin/announcements.ts' runDue* shape.
 * ============================================================ */

/**
 * One pass of the event-reminder sweep. Finds scheduled events with a reminder
 * lead set, whose `starts_at - reminder_lead_ms <= now < starts_at` and which
 * haven't reminded yet (`reminder_fired_at` NULL), then notifies every going/
 * maybe RSVP (deduped by account), and stamps `reminder_fired_at` so it fires
 * at most once. Per-row try/catch so one bad row never stalls the rest; the
 * whole sweep is best-effort and never throws back into the caller.
 */
export async function sweepEventRemindersOnce(db: Db, io: Io): Promise<void> {
  const now = Date.now();
  let dueRows: (typeof serverEvents.$inferSelect)[];
  try {
    dueRows = await db
      .select()
      .from(serverEvents)
      .where(and(
        eq(serverEvents.status, "scheduled"),
        isNull(serverEvents.reminderFiredAt),
        sql`${serverEvents.reminderLeadMs} is not null`,
        // Reminder window has opened but the event hasn't started yet.
        sql`(${serverEvents.startsAt} - ${serverEvents.reminderLeadMs}) <= ${now}`,
        sql`${serverEvents.startsAt} > ${now}`,
      ));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[server-events] reminder sweep failed to read due rows", err);
    return;
  }
  if (dueRows.length === 0) return;

  for (const row of dueRows) {
    try {
      await fireEventReminder(db, io, row, now);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[server-events] failed to fire reminder", { id: row.id, err });
    }
  }
}

async function fireEventReminder(
  db: Db,
  io: Io,
  row: typeof serverEvents.$inferSelect,
  now: number,
): Promise<void> {
  // Stamp FIRST (idempotent guard): the conditional update only "wins" while
  // reminder_fired_at is still NULL, so two overlapping sweeps can't both
  // notify. The atomic claim runs in a synchronous transaction (mirrors the
  // server-join invite-claim in routes/servers.ts). If we didn't win the row,
  // another sweep already sent it.
  let claimed = false;
  db.transaction((tx) => {
    const claim = tx
      .update(serverEvents)
      .set({ reminderFiredAt: now })
      .where(and(eq(serverEvents.id, row.id), isNull(serverEvents.reminderFiredAt)))
      .run();
    if (claim.changes > 0) claimed = true;
  });
  if (!claimed) return;

  // Who to remind: going + maybe RSVPs, deduped to one notification per account
  // (a member RSVP'd on two identities gets a single ping).
  const rsvps = await db
    .select({ userId: serverEventRsvps.userId })
    .from(serverEventRsvps)
    .where(and(
      eq(serverEventRsvps.eventId, row.id),
      inArray(serverEventRsvps.status, ["going", "maybe"]),
    ));
  const userIds = [...new Set(rsvps.map((r) => r.userId))];
  if (userIds.length === 0) return;

  const startsIn = Math.max(0, +row.startsAt - now);
  const mins = Math.round(startsIn / 60_000);
  const whenText = mins >= 120
    ? `in about ${Math.round(mins / 60)} hours`
    : mins >= 60
      ? "in about an hour"
      : mins <= 1
        ? "shortly"
        : `in ${mins} minutes`;

  const inputs: NotifyInput[] = userIds.map((userId) => ({
    userId,
    category: "announcement",
    kind: "announcement",
    serverId: row.serverId,
    title: `Starting ${whenText}: ${row.title}`,
    snippet: "An event you're attending is about to begin.",
    target: { kind: "event", id: row.id },
    // Collapse a duplicate ping for the same event within the window.
    dedupeKey: `event-reminder:${row.id}`,
  }));
  await notifyMany(db, io, inputs);
}

/* ============================================================
 *  Sweep scheduler — its own ~60s .unref() timer, idempotent.
 * ============================================================ */

const SWEEP_TICK_MS = 60_000;
let sweepTimer: NodeJS.Timeout | null = null;

/** Start the event-reminder sweep beside startAnnouncementScheduler. Idempotent
 *  (dev hot-reload / double boot won't stack timers). Returns a stopper. */
export function startEventReminderSweep(deps: { db: Db; io: Io }): () => void {
  const { db, io } = deps;
  if (sweepTimer) return () => stopEventReminderSweep();
  // eslint-disable-next-line no-console
  console.info("[server-events] reminder sweep started", { tickMs: SWEEP_TICK_MS });
  sweepTimer = setInterval(() => { void sweepEventRemindersOnce(db, io); }, SWEEP_TICK_MS);
  // Don't hold the process open on this timer alone.
  sweepTimer.unref?.();
  setImmediate(() => { void sweepEventRemindersOnce(db, io); });
  return () => stopEventReminderSweep();
}

export function stopEventReminderSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
