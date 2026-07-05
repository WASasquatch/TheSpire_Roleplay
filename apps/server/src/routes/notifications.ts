import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { z } from "zod";
import type { ClientToServerEvents, ServerToClientEvents, NotificationCategory } from "@thekeep/shared";
import { NOTIFICATION_CATEGORIES } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { badgeFor, getNotificationPrefs, listNotifications, markRead, markSeen, setNotificationPrefs } from "../notifications/engine.js";
import { getSessionUser } from "./auth.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

const readBody = z.object({
  ids: z.union([z.array(z.string().max(64)).max(500), z.literal("all")]),
}).strict();

const prefsBody = z.object({
  mutedCategories: z.array(z.string().max(32)).max(32),
}).strict();

/**
 * Notification Center routes (the unified inbox). The bell boots from
 * `/me/notifications/unread`, opens to `/me/notifications`, clears the badge
 * with `/me/notifications/seen`, and acknowledges rows with
 * `/me/notifications/read`. Writes/badges are pushed live via the engine.
 */
export async function registerNotificationRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /** Cheap boot/poll fetch: just the unread totals (+ per-server for rail dots). */
  // Bell boot + live poll fetch. Cheap per call, but it's a poll endpoint, so a
  // reconnect/poll loop hits the same failure mode as /rooms did. Cap per-IP;
  // legit use (boot + occasional live refresh across a few tabs) is well under.
  app.get("/me/notifications/unread", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    return badgeFor(db, me.id);
  });

  /** Newest-first inbox page (optionally filtered by category). */
  app.get<{ Querystring: { cursor?: string; limit?: string; category?: string } }>("/me/notifications", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
    const cursor = req.query.cursor ? Number(req.query.cursor) : null;
    const category = NOTIFICATION_CATEGORIES.includes(req.query.category as NotificationCategory)
      ? (req.query.category as NotificationCategory)
      : null;
    return listNotifications(db, me.id, { limit, cursor: Number.isFinite(cursor) ? cursor : null, category });
  });

  /** Mark specific rows (or everything) read. Returns the fresh badge. */
  app.post<{ Body: unknown }>("/me/notifications/read", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof readBody>;
    try { body = readBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const badge = await markRead(db, io, me.id, body.ids);
    return { ok: true, ...badge };
  });

  /** Acknowledge the badge (mark all seen) without consuming the rows. */
  app.post("/me/notifications/seen", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    await markSeen(db, me.id);
    return { ok: true };
  });

  /** Read the viewer's category-mute preferences. */
  app.get("/me/notification-prefs", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    return getNotificationPrefs(db, me.id);
  });

  /** Replace the viewer's muted-category list. Unknown categories are dropped. */
  app.put<{ Body: unknown }>("/me/notification-prefs", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof prefsBody>;
    try { body = prefsBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const allowed = new Set<string>(NOTIFICATION_CATEGORIES);
    const mutedCategories = body.mutedCategories.filter((c): c is NotificationCategory => allowed.has(c));
    await setNotificationPrefs(db, me.id, { mutedCategories });
    return { ok: true, mutedCategories };
  });
}
