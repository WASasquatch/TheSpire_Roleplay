/**
 * Throttled broadcast queue. Campaign recipients land in `email_outbox`
 * as `pending`; this worker drains them within the admin-configured daily
 * cap (Brevo free = 300/day), auto-resuming the next day. Sending is
 * sequential to stay friendly to the provider's per-second limits, and
 * each tick is bounded so a big campaign never hogs the event loop.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { emailCategoryLabel } from "@thekeep/shared";
import { emailCampaigns, emailOutbox, emailUnsubscribes } from "../db/schema.js";
import { getSettings } from "../settings.js";
import { sendEmail } from "../lib/mailer.js";
import { renderBrandedEmail, publicBaseUrl } from "./layout.js";
import { unsubscribeUrl } from "./unsubscribe.js";
import type { Db } from "../db/index.js";

const TICK_MS = 60_000;
/** Max sends per tick — bounds event-loop time and provider burst rate. */
const PER_TICK = 25;
const MAX_ATTEMPTS = 3;

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Emails already sent today (across all campaigns), for the daily cap. */
async function sentToday(db: Db): Promise<number> {
  const row = (await db
    .select({ n: sql<number>`count(*)` })
    .from(emailOutbox)
    .where(and(
      eq(emailOutbox.status, "sent"),
      gte(emailOutbox.sentAt, new Date(startOfTodayMs())),
    )))[0];
  return row?.n ?? 0;
}

/**
 * Send one batch of pending broadcast emails, respecting the daily cap.
 * Returns the number actually sent this pass.
 */
export async function drainEmailQueue(db: Db): Promise<number> {
  const settings = await getSettings(db);
  const cap = settings.emailDailyCap > 0 ? settings.emailDailyCap : 300;

  // Promote any scheduled campaign whose start time has arrived so its
  // pending rows become eligible below. (Null scheduled_at campaigns are
  // already 'sending'.)
  await db.run(sql`
    UPDATE email_campaigns SET status = 'sending', updated_at = ${Date.now()}
    WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ${Date.now()}`);

  const remaining = cap - (await sentToday(db));
  if (remaining <= 0) return 0;

  const batch = await db
    .select({
      id: emailOutbox.id,
      campaignId: emailOutbox.campaignId,
      userId: emailOutbox.userId,
      email: emailOutbox.email,
      attempts: emailOutbox.attempts,
      subject: emailCampaigns.subject,
      bodyHtml: emailCampaigns.bodyHtml,
      category: emailCampaigns.category,
    })
    .from(emailOutbox)
    .innerJoin(emailCampaigns, eq(emailOutbox.campaignId, emailCampaigns.id))
    // Only drain campaigns that are actively sending — excludes not-yet-due
    // scheduled campaigns and canceled ones.
    .where(and(eq(emailOutbox.status, "pending"), eq(emailCampaigns.status, "sending")))
    .limit(Math.min(PER_TICK, remaining));
  if (batch.length === 0) return 0;

  const base = publicBaseUrl(settings);
  let sent = 0;
  for (const row of batch) {
    // Re-check opt-out at SEND time, not just enqueue time. A scheduled
    // newsletter can sit for days; if the recipient unsubscribed from this
    // category in the meantime, skip them now instead of mailing anyway.
    if (row.userId) {
      const optedOut = (await db
        .select({ x: sql`1` })
        .from(emailUnsubscribes)
        .where(and(eq(emailUnsubscribes.userId, row.userId), eq(emailUnsubscribes.category, row.category)))
        .limit(1))[0];
      if (optedOut) {
        await db.update(emailOutbox).set({ status: "skipped" }).where(eq(emailOutbox.id, row.id));
        continue;
      }
    }
    const html = renderBrandedEmail(settings, {
      heading: row.subject,
      bodyHtml: row.bodyHtml,
      ...(row.userId
        ? { unsubscribeUrl: unsubscribeUrl(base, row.userId, row.category), unsubscribeLabel: emailCategoryLabel(row.category) }
        : {}),
    });
    const res = await sendEmail({ to: row.email, subject: row.subject, html });
    if (res.ok) {
      await db.update(emailOutbox).set({ status: "sent", sentAt: new Date() }).where(eq(emailOutbox.id, row.id));
      await db.update(emailCampaigns).set({ sentCount: sql`${emailCampaigns.sentCount} + 1`, updatedAt: new Date() }).where(eq(emailCampaigns.id, row.campaignId));
      sent++;
    } else if (res.skipped) {
      // No API key configured — stop the pass quietly; nothing will send.
      break;
    } else {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await db.update(emailOutbox).set({ status: "failed", attempts, error: res.error ?? "send failed" }).where(eq(emailOutbox.id, row.id));
        await db.update(emailCampaigns).set({ failedCount: sql`${emailCampaigns.failedCount} + 1`, updatedAt: new Date() }).where(eq(emailCampaigns.id, row.campaignId));
      } else {
        await db.update(emailOutbox).set({ attempts, error: res.error ?? "send failed" }).where(eq(emailOutbox.id, row.id));
      }
    }
  }

  // Mark any campaign with no remaining pending rows as done.
  await db.run(sql`
    UPDATE email_campaigns SET status = 'done', updated_at = ${Date.now()}
    WHERE status = 'sending'
      AND NOT EXISTS (
        SELECT 1 FROM email_outbox
        WHERE email_outbox.campaign_id = email_campaigns.id
          AND email_outbox.status = 'pending'
      )`);
  return sent;
}

/** Start the periodic drain. `.unref()` so it never holds the process open. */
export function startEmailQueue(db: Db): void {
  const timer = setInterval(() => {
    void drainEmailQueue(db).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[email-queue] drain failed", err);
    });
  }, TICK_MS);
  timer.unref();
}
