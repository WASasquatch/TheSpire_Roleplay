import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { id, ts } from "./_helpers.js";
import { rooms } from "./chat.js";
import { users } from "./users.js";

/**
 * Tamper-evident chat-export receipts (migration 0261). One row per
 * `/export`, recording the metadata + a SHA-256 content hash of the signed
 * canonical payload — never message bodies, so it's privacy-safe to keep
 * indefinitely and can confirm a submitted file even after its messages
 * age out of retention. `id` is the human-facing Verification ID printed
 * in the log footer; `signature` is the HMAC kept so a receipt alone can
 * re-confirm a file. See export/sign.ts + the verifier admin route.
 */
export const exportReceipts = sqliteTable(
  "export_receipts",
  {
    id: id(),
    /** SET NULL on room delete — the receipt outlives the room. */
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null" }),
    /** Snapshot of the room name at export time. */
    roomName: text("room_name").notNull(),
    exportedByUserId: text("exported_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Snapshot of the master username that ran /export. */
    exportedByUsername: text("exported_by_username").notNull(),
    generatedAt: integer("generated_at").notNull(),
    windowMs: integer("window_ms").notNull(),
    rangeStart: integer("range_start").notNull(),
    rangeEnd: integer("range_end").notNull(),
    messageCount: integer("message_count").notNull(),
    truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
    /** SHA-256 of the canonical signed payload (hex). */
    contentHash: text("content_hash").notNull(),
    /** HMAC-SHA256 signature (hex). */
    signature: text("signature").notNull(),
    createdAt: ts("created_at"),
  },
  (t) => ({
    hashIdx: index("export_receipts_hash_idx").on(t.contentHash),
    roomIdx: index("export_receipts_room_idx").on(t.roomId, t.generatedAt),
  }),
);
export type DbExportReceipt = typeof exportReceipts.$inferSelect;

/* ---------- analytics_page_view ----------
 * PUBLIC, anonymous, cookieless site hits (migration 0310, plan_ext.md §4).
 * Written server-side on the first document GET plus the /a/e client beacon.
 * Privacy: the raw client IP NEVER lands here — it is resolved to a coarse ISO
 * country in-memory and discarded. `path` is a route TEMPLATE ("/f/:slug"), not
 * a resolved slug/id. `visitor_hash` is a daily-rotating salted hash (the
 * GoatCounter/Plausible pattern) so unique counts stay non-reversible. Raw,
 * short-retention: swept after `site_settings.analyticsRawRetentionDays`; the
 * long-term data lives in `analytics_daily`. Index-light on purpose (created_at
 * + one grouping index) to protect the single SQLite writer.
 */
export const analyticsPageView = sqliteTable(
  "analytics_page_view",
  {
    id: id(),
    createdAt: ts("created_at"),
    /** Route TEMPLATE, e.g. "/f/:slug" — never the resolved slug/id. */
    path: text("path").notNull(),
    /** Referrer hostname only (path + query dropped), may be null/direct. */
    refHost: text("ref_host"),
    /** Classified named source, e.g. "google", "reddit", "chatgpt". */
    refSource: text("ref_source"),
    /** search | social | email | referral | paid | direct. */
    refMedium: text("ref_medium"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    /** ISO country code only — NO raw IP is ever stored. */
    geoCountry: text("geo_country"),
    /** Null until a GeoLite2-City DB is plugged into resolveGeo. */
    geoRegion: text("geo_region"),
    /** Fly edge-PoP region tag — a weak fallback, NOT the visitor's country. */
    flyRegion: text("fly_region"),
    /** Daily-rotating salted hash for cookieless dedupe; rolls over each day. */
    visitorHash: text("visitor_hash"),
    isBot: integer("is_bot", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({
    createdIdx: index("analytics_pv_created_idx").on(t.createdAt),
    pathIdx: index("analytics_pv_path_idx").on(t.path),
  }),
);
export type DbAnalyticsPageView = typeof analyticsPageView.$inferSelect;

/* ---------- analytics_event ----------
 * USER in-app navigation (migration 0310, plan_ext.md §4). Fed by the client
 * nav-metrics beacon: modal opens, sub-tab switches, room/server switches,
 * feature usage. `meta` is a small JSON blob (like audit.metadataJson) with a
 * scrubbed typed prop bag — no id-bearing URLs, no query strings, no free text.
 * `userId`/`serverId` are attached only when a valid session is present (authed
 * in-app events are already self-identifying). Raw, short-retention + swept;
 * rolls into `analytics_daily`. Index-light (created_at + kind/key grouping).
 */
export const analyticsEvent = sqliteTable(
  "analytics_event",
  {
    id: id(),
    createdAt: ts("created_at"),
    /** "modal" | "tab" | "room" | "server" | "page" | "feature". */
    kind: text("kind").notNull(),
    /** e.g. "affiliatesOpen", "admin:users", "roomId". */
    key: text("key").notNull(),
    /** Small scrubbed JSON prop bag; null when there's nothing to attach. */
    meta: text("meta"),
    /** Nullable; set only when the beacon carried a valid bearer. */
    userId: text("user_id"),
    /** Nullable; the active server at event time. */
    serverId: text("server_id"),
    isBot: integer("is_bot", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({
    createdIdx: index("analytics_ev_created_idx").on(t.createdAt),
    kindKeyIdx: index("analytics_ev_kind_key_idx").on(t.kind, t.key),
  }),
);
export type DbAnalyticsEvent = typeof analyticsEvent.$inferSelect;

/* ---------- analytics_daily ----------
 * Pre-aggregated rollup (migration 0310, plan_ext.md §4) — the long-retention
 * reporting source the admin dashboard reads. The nightly rollup job aggregates
 * yesterday's raw rows into (day, metric, dim1, dim2) counts, then deletes the
 * raw rows past the retention window. Tiny + kept indefinitely, so counts never
 * silently undercount the way sessions-derived DAU/WAU does past its TTL. The
 * unique (day, metric, dim1, dim2) index lets the rollup upsert counts.
 */
export const analyticsDaily = sqliteTable(
  "analytics_daily",
  {
    id: id(),
    /** 'YYYY-MM-DD' (UTC). */
    day: text("day").notNull(),
    /** "pageview" | "visitor" | "event". */
    metric: text("metric").notNull(),
    /** path | refMedium | geoCountry | event kind, depending on `metric`. */
    dim1: text("dim1"),
    /** refSource | event key | ..., depending on `metric`. */
    dim2: text("dim2"),
    count: integer("count").notNull().default(0),
  },
  (t) => ({
    dayMetricIdx: uniqueIndex("analytics_daily_day_metric_idx").on(
      t.day,
      t.metric,
      t.dim1,
      t.dim2,
    ),
  }),
);
export type DbAnalyticsDaily = typeof analyticsDaily.$inferSelect;
