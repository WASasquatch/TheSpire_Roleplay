import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { PermissionKey, Role } from "@thekeep/shared";
import { DEFAULT_EMAIL_CATEGORY, isEmailCategory } from "@thekeep/shared";
import { emailCampaigns, emailOutbox, users } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { requireSessionPermission } from "../auth/requireSessionPermission.js";
import { sanitizeBio } from "../auth/html.js";
import { recordAudit } from "../audit.js";
import { getSettings } from "../settings.js";
import { sendEmail, mailerConfigured } from "../lib/mailer.js";
import { renderBrandedEmail } from "../email/layout.js";
import { drainEmailQueue } from "../email/queue.js";

interface SessionUserCtx {
  id: string;
  role: Role;
}

const SUBJECT_MAX = 200;
const BODY_MAX = 200_000;

const sendSchema = z.object({
  toUserId: z.string().min(1),
  subject: z.string().min(1).max(SUBJECT_MAX),
  html: z.string().min(1).max(BODY_MAX),
}).strict();

const broadcastSchema = z.object({
  subject: z.string().min(1).max(SUBJECT_MAX),
  html: z.string().min(1).max(BODY_MAX),
  // Validated against the shared category set below; defaults if omitted.
  category: z.string().optional(),
  // ms epoch to START sending; omitted/past = send immediately.
  scheduledAt: z.number().int().positive().optional(),
}).strict();

/**
 * Admin emailer. Gated by `view_admin_email` (read) / `send_admin_email`
 * (send), seeded to admin + masteradmin by migration 0257. Bodies are
 * composed in the Email tab (tiptap) and sanitized with the bio allow-list
 * before storage/send. Single sends go out immediately; broadcasts enqueue
 * into email_outbox and drain via the throttled queue (daily cap).
 */
export async function registerAdminEmailRoutes(
  app: FastifyInstance,
  deps: { db: Db },
): Promise<void> {
  const { db } = deps;
  const requirePermission = (req: FastifyRequest, reply: FastifyReply, key: PermissionKey) =>
    requireSessionPermission(req, reply, key, db);
  const sessionOf = (req: FastifyRequest) =>
    (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser!;

  // Status surface for the Email tab: whether sending is wired up + a
  // recent-campaign list with progress.
  app.get("/admin/email/status", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_email"))) return;
    const settings = await getSettings(db);
    const campaigns = await db
      .select()
      .from(emailCampaigns)
      .orderBy(desc(emailCampaigns.createdAt))
      .limit(20);
    return {
      configured: mailerConfigured,
      dailyCap: settings.emailDailyCap,
      campaigns: campaigns.map((c) => ({
        id: c.id,
        subject: c.subject,
        category: c.category,
        status: c.status,
        scheduledAt: c.scheduledAt ? +c.scheduledAt : null,
        total: c.total,
        sentCount: c.sentCount,
        failedCount: c.failedCount,
        createdAt: +c.createdAt,
        updatedAt: +c.updatedAt,
      })),
    };
  });

  // Recipient picker for single-send: search by username or email.
  app.get<{ Querystring: { q?: string } }>("/admin/email/recipients", async (req, reply) => {
    if (!(await requirePermission(req, reply, "view_admin_email"))) return;
    const q = (req.query.q ?? "").trim().toLowerCase();
    if (!q) return { users: [] };
    const rows = await db
      .select({ id: users.id, username: users.username, email: users.email })
      .from(users)
      .where(and(
        isNull(users.disabledAt),
        sql`${users.username} != 'system'`,
        sql`(lower(${users.username}) LIKE ${"%" + q + "%"} OR lower(${users.email}) LIKE ${"%" + q + "%"})`,
      ))
      .limit(15);
    return { users: rows };
  });

  // Send one email to a specific user, immediately. Not subject to the
  // bulk opt-out — the admin explicitly chose this recipient.
  app.post<{ Body: unknown }>("/admin/email/send", async (req, reply) => {
    if (!(await requirePermission(req, reply, "send_admin_email"))) return;
    const body = sendSchema.parse(req.body);
    const target = (await db.select().from(users).where(eq(users.id, body.toUserId)).limit(1))[0];
    if (!target || !target.email) { reply.code(404); return { error: "no_recipient" }; }
    const settings = await getSettings(db);
    const safe = sanitizeBio(body.html);
    const html = renderBrandedEmail(settings, { heading: body.subject, bodyHtml: safe });
    const res = await sendEmail({ to: target.email, toName: target.username, subject: body.subject, html });
    if (!res.ok) {
      reply.code(res.skipped ? 503 : 502);
      return { error: res.skipped ? "mailer_not_configured" : "send_failed" };
    }
    await recordAudit(db, { actorUserId: sessionOf(req).id, action: "admin_email_send", targetUserId: target.id });
    return { ok: true };
  });

  // Queue a broadcast to every eligible account (not system, not disabled,
  // has an email, not opted out of bulk). Returns the campaign + counts.
  app.post<{ Body: unknown }>("/admin/email/broadcast", async (req, reply) => {
    if (!(await requirePermission(req, reply, "send_admin_email"))) return;
    const body = broadcastSchema.parse(req.body);
    const safe = sanitizeBio(body.html);
    const category = isEmailCategory(body.category) ? body.category : DEFAULT_EMAIL_CATEGORY;

    // Eligible = active, has an email, not the system account, and NOT
    // opted out of THIS category (other categories don't exclude them).
    const recipients = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(
        isNull(users.disabledAt),
        sql`${users.username} != 'system'`,
        sql`${users.email} != ''`,
        sql`NOT EXISTS (SELECT 1 FROM email_unsubscribes WHERE email_unsubscribes.user_id = ${users.id} AND email_unsubscribes.category = ${category})`,
      ));
    if (recipients.length === 0) { reply.code(400); return { error: "no_recipients" }; }

    // Future scheduledAt parks the campaign as 'scheduled' until the queue
    // promotes it at send time; a missing/past value sends immediately.
    const scheduled = typeof body.scheduledAt === "number" && body.scheduledAt > Date.now();
    const campaignId = nanoid();
    await db.insert(emailCampaigns).values({
      id: campaignId,
      subject: body.subject,
      bodyHtml: safe,
      category,
      scheduledAt: scheduled ? new Date(body.scheduledAt!) : null,
      status: scheduled ? "scheduled" : "sending",
      total: recipients.length,
      createdByUserId: sessionOf(req).id,
    });
    // Bulk insert outbox rows in chunks (SQLite caps bound-variable count).
    const rows = recipients.map((r) => ({
      id: nanoid(),
      campaignId,
      userId: r.id,
      email: r.email,
      status: "pending" as const,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      await db.insert(emailOutbox).values(rows.slice(i, i + 200));
    }
    await recordAudit(db, { actorUserId: sessionOf(req).id, action: "admin_email_broadcast", metadata: { campaignId, total: recipients.length, scheduled } });
    // Kick a first drain now so an immediate broadcast goes out without
    // waiting for the next tick. Scheduled ones wait for their time.
    if (!scheduled) void drainEmailQueue(db).catch(() => {});
    return { ok: true, campaignId, total: recipients.length, scheduled };
  });

  // Cancel a not-yet-finished campaign: stop further sends by dropping its
  // pending rows and marking it canceled. Already-sent emails can't be
  // recalled; this just halts the rest (mainly useful for scheduled ones).
  app.post<{ Params: { id: string } }>("/admin/email/campaigns/:id/cancel", async (req, reply) => {
    if (!(await requirePermission(req, reply, "send_admin_email"))) return;
    const c = (await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, req.params.id)).limit(1))[0];
    if (!c) { reply.code(404); return { error: "not_found" }; }
    if (c.status === "done" || c.status === "canceled") return { ok: true, status: c.status };
    await db.delete(emailOutbox).where(and(eq(emailOutbox.campaignId, c.id), eq(emailOutbox.status, "pending")));
    await db.update(emailCampaigns).set({ status: "canceled", updatedAt: new Date() }).where(eq(emailCampaigns.id, c.id));
    return { ok: true, status: "canceled" };
  });
}
