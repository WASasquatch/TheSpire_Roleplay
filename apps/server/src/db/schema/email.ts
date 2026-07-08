import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { id, ts } from "./_helpers.js";
import { ignores } from "./moderation.js";
import { users } from "./users.js";

/* ---------- email tokens (password reset + verification) ---------- */
/**
 * Single-use tokens for transactional account email (migration 0257).
 * `purpose` discriminates password-reset from email-verification. We store
 * a SHA-256 HASH of the token, never the raw value, so a DB leak can't be
 * used to reset accounts. The raw token only ever lives in the emailed
 * link. `usedAt` marks consumption (single-use); `expiresAt` bounds the
 * window (reset ~1h, verify ~24h, enforced at the call site).
 */
export const emailTokens = sqliteTable(
  "email_tokens",
  {
    id: id(),
    purpose: text("purpose", { enum: ["password_reset", "email_verify"] }).notNull(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    tokenHashIdx: index("email_tokens_hash_idx").on(t.tokenHash),
    userPurposeIdx: index("email_tokens_user_purpose_idx").on(t.userId, t.purpose),
  }),
);
export type DbEmailToken = typeof emailTokens.$inferSelect;

/* ---------- admin email campaigns (broadcast) ---------- */
/**
 * One admin-authored broadcast (migration 0257). The body is composed in
 * the admin Email tab (tiptap → sanitized HTML) and frozen here at send
 * time. The throttled queue (see email_outbox) drains recipients within
 * the daily cap; `sentCount`/`total` track progress for the admin UI.
 */
export const emailCampaigns = sqliteTable(
  "email_campaigns",
  {
    id: id(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html").notNull(),
    /** Broadcast category (see shared EMAIL_CATEGORY_KEYS). Recipients can
     *  unsubscribe per-category; this is what the footer link drops. */
    category: text("category").notNull().default("announcements"),
    /** When to START sending (ms epoch). Null = send immediately. A future
     *  value parks the campaign as `scheduled` until the queue promotes it. */
    scheduledAt: integer("scheduled_at", { mode: "timestamp_ms" }),
    status: text("status", { enum: ["scheduled", "sending", "done", "canceled"] }).notNull().default("sending"),
    total: integer("total").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    statusIdx: index("email_campaigns_status_idx").on(t.status, t.createdAt),
  }),
);
export type DbEmailCampaign = typeof emailCampaigns.$inferSelect;

/* ---------- admin email outbox (throttled per-recipient queue) ---------- */
/**
 * One queued recipient of a campaign (migration 0257). The queue worker
 * sends `pending` rows up to the daily cap, marking each `sent`/`failed`;
 * `sentAt` is what the daily-cap counter sums over the current calendar
 * day. Recipients opted out of bulk mail are written as `skipped` so the
 * campaign totals still reconcile.
 */
export const emailOutbox = sqliteTable(
  "email_outbox",
  {
    id: id(),
    campaignId: text("campaign_id").notNull().references(() => emailCampaigns.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed", "skipped"] }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    statusIdx: index("email_outbox_status_idx").on(t.status),
    campaignIdx: index("email_outbox_campaign_idx").on(t.campaignId),
    sentAtIdx: index("email_outbox_sent_at_idx").on(t.sentAt),
  }),
);
export type DbEmailOutbox = typeof emailOutbox.$inferSelect;

/* ---------- per-category email unsubscribes ---------- */
/**
 * A user's opt-out of one broadcast CATEGORY (migration 0257). Presence of
 * a row = unsubscribed from that category; absence = subscribed. The
 * one-click footer link writes the row for the campaign's category, so
 * dropping "newsletter" doesn't stop "announcements". Transactional mail
 * is never a category and ignores this table entirely.
 */
export const emailUnsubscribes = sqliteTable(
  "email_unsubscribes",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    createdAt: ts("created_at"),
  },
  (t) => ({
    userCatUq: uniqueIndex("email_unsub_user_cat_uq").on(t.userId, t.category),
  }),
);
export type DbEmailUnsubscribe = typeof emailUnsubscribes.$inferSelect;
