import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  AffiliateClickDirection,
  AffiliateKind,
  AffiliateStatus,
} from "@thekeep/shared";
import { id, ts } from "./_helpers.js";
import { users } from "./users.js";

/* ---------- affiliates / partners / sponsors ---------- */
/**
 * Affiliate / partner / sponsor entries surfaced as the "Roleplay Communities"
 * mini top-sites section (migration 0307, additive over 0027).
 *
 * Two shapes coexist, discriminated by `kind`:
 *   - `card`  → structured, self-service community cards (icon/banner/title/
 *     description/target URL). Rendered as text + `<img>`/`<a>` only, so no XSS
 *     surface. Members submit them (status='pending') and a global admin
 *     approves them (status='approved'); only approved cards show publicly.
 *   - `html`  → legacy raw-HTML carousel rows. `html` is admin-trusted and NOT
 *     sanitized server-side (admins paste the affiliate's provided anchor +
 *     tracking-pixel snippet verbatim; same posture as customHeadHtml). These
 *     keep working in the admin tab but never render as cards.
 *
 * `label` is an admin-only nickname for sorting/identification; never rendered.
 * `hash` is a unique link-back token (`/a/<hash>`) the partner places on their
 * site; `clicksIn`/`clicksOut` are the top-sites traffic counters (both ways).
 */
export const affiliates = sqliteTable(
  "affiliates",
  {
    id: id(),
    /** 'card' (structured, self-service) | 'html' (legacy raw-HTML row). */
    kind: text("kind").$type<AffiliateKind>().notNull().default("card"),
    /** Review/visibility state; only 'approved' cards render publicly. */
    status: text("status").$type<AffiliateStatus>().notNull().default("approved"),
    /** Submitter (null for admin-authored cards and legacy html rows). */
    ownerUserId: text("owner_user_id").references(() => users.id),
    label: text("label").notNull(),
    html: text("html").notNull(),
    title: text("title"),
    description: text("description"),
    iconUrl: text("icon_url"),
    bannerUrl: text("banner_url"),
    targetUrl: text("target_url"),
    /** Unique link-back token; NULL for legacy html rows (see unique index). */
    hash: text("hash"),
    reviewNote: text("review_note"),
    reviewedBy: text("reviewed_by").references(() => users.id),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    /** Top-sites traffic: inbound link-back hits / outbound card click-throughs. */
    clicksIn: integer("clicks_in").notNull().default(0),
    clicksOut: integer("clicks_out").notNull().default(0),
    /** Traffic padding (global-admin only): optional SYNTHETIC in/out traffic so a
     *  quiet listing still shows some life. Kept separate from clicks_in/out; a
     *  rolling-24h random ceiling (1..max) is spread across the period and banked
     *  as each period completes. See affiliates/padding.ts + migrations 0311/0322. */
    padInEnabled: integer("pad_in_enabled", { mode: "boolean" }).notNull().default(false),
    padInMax: integer("pad_in_max").notNull().default(0),
    padInBanked: integer("pad_in_banked").notNull().default(0),
    padInTarget: integer("pad_in_target").notNull().default(0),
    padOutEnabled: integer("pad_out_enabled", { mode: "boolean" }).notNull().default(false),
    padOutMax: integer("pad_out_max").notNull().default(0),
    padOutBanked: integer("pad_out_banked").notNull().default(0),
    padOutTarget: integer("pad_out_target").notNull().default(0),
    /** LEGACY (0311): calendar YYYY-MM-DD the pad targets belonged to. Superseded
     *  by padPeriodStart (0322); retained so old rows still read. */
    padDay: text("pad_day"),
    /** Shared rolling-period anchor (epoch ms); NULL until first initialized. The
     *  current pad ceilings + ramp curve are seeded from this. */
    padPeriodStart: integer("pad_period_start"),
    /** Discovery tags (JSON string[]); NULL when empty. Mirrors server/forum tags;
     *  round-trip through serializeTags/parseTagsJson. */
    tagsJson: text("tags_json"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    sortIdx: index("affiliates_sort_idx").on(t.enabled, t.sortOrder, t.createdAt),
    hashUq: uniqueIndex("affiliates_hash_uq").on(t.hash),
    statusIdx: index("affiliates_status_idx").on(t.kind, t.status, t.sortOrder, t.createdAt),
    ownerIdx: index("affiliates_owner_idx").on(t.ownerUserId),
  }),
);

/**
 * One row per counted affiliate link-back hit, keyed by (affiliate, direction,
 * ip). Used to throttle refresh-inflation of `clicksIn`/`clicksOut`: a hit is
 * only counted when no matching row exists inside the throttle window
 * (AFFILIATE_LIMITS.clickThrottleMs). Cascades on affiliate delete.
 */
export const affiliateClickLog = sqliteTable(
  "affiliate_click_log",
  {
    id: id(),
    affiliateId: text("affiliate_id")
      .notNull()
      .references(() => affiliates.id, { onDelete: "cascade" }),
    direction: text("direction").$type<AffiliateClickDirection>().notNull(),
    ip: text("ip").notNull(),
    at: ts("at"),
  },
  (t) => ({
    dedupIdx: index("affiliate_click_dedup_idx").on(t.affiliateId, t.direction, t.ip, t.at),
  }),
);
export type DbAffiliate = typeof affiliates.$inferSelect;
export type DbAffiliateClickLog = typeof affiliateClickLog.$inferSelect;
