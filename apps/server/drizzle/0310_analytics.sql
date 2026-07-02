-- 0310: First-party analytics / usage metrics (plan_ext.md §4, §6, §7).
--
-- A single first-party events layer inside the existing better-sqlite3 DB:
--   * analytics_page_view  PUBLIC, anonymous, cookieless site hits (raw, short-retention)
--   * analytics_event      USER in-app navigation (raw, short-retention)
--   * analytics_daily      pre-aggregated rollups (long-retention; the reporting source)
--
-- Privacy posture (§7): the raw client IP NEVER enters these tables. Geo is
-- resolved in-memory to a coarse ISO country and discarded; `fly_region` is a
-- weak edge-PoP fallback tag, not the visitor's country. `visitor_hash` is a
-- daily-rotating salted hash (salt dropped within 24h) so unique counts stay
-- pseudonymous and non-reversible. Raw rows are swept after
-- `analytics_raw_retention_days`; only `analytics_daily` persists.
--
-- Raw tables are deliberately index-light (created_at + one grouping index
-- each) to protect the single SQLite writer; `analytics_daily` carries a unique
-- (day, metric, dim1, dim2) index so the nightly rollup can upsert counts.
--
-- Additive only: three site_settings columns all have safe defaults so existing
-- installs keep identical behavior (analytics ON, 30-day retention, DNT honored).

-- ---------- analytics_page_view (PUBLIC, raw, short-retention) ----------
CREATE TABLE `analytics_page_view` (
  `id` TEXT PRIMARY KEY,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `path` TEXT NOT NULL,
  `ref_host` TEXT,
  `ref_source` TEXT,
  `ref_medium` TEXT,
  `utm_source` TEXT,
  `utm_medium` TEXT,
  `utm_campaign` TEXT,
  `geo_country` TEXT,
  `geo_region` TEXT,
  `fly_region` TEXT,
  `visitor_hash` TEXT,
  `is_bot` INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX `analytics_pv_created_idx` ON `analytics_page_view` (`created_at`);
--> statement-breakpoint
CREATE INDEX `analytics_pv_path_idx` ON `analytics_page_view` (`path`);
--> statement-breakpoint

-- ---------- analytics_event (USER in-app nav, raw, short-retention) ----------
CREATE TABLE `analytics_event` (
  `id` TEXT PRIMARY KEY,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `kind` TEXT NOT NULL,
  `key` TEXT NOT NULL,
  `meta` TEXT,
  `user_id` TEXT,
  `server_id` TEXT,
  `is_bot` INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX `analytics_ev_created_idx` ON `analytics_event` (`created_at`);
--> statement-breakpoint
CREATE INDEX `analytics_ev_kind_key_idx` ON `analytics_event` (`kind`, `key`);
--> statement-breakpoint

-- ---------- analytics_daily (rollup, long-retention, the reporting source) ----------
CREATE TABLE `analytics_daily` (
  `id` TEXT PRIMARY KEY,
  `day` TEXT NOT NULL,
  `metric` TEXT NOT NULL,
  `dim1` TEXT,
  `dim2` TEXT,
  `count` INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_daily_day_metric_idx` ON `analytics_daily` (`day`, `metric`, `dim1`, `dim2`);
--> statement-breakpoint

-- ---------- site_settings: analytics master switch + retention + DNT gate ----------
ALTER TABLE `site_settings` ADD COLUMN `analytics_enabled` INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `site_settings` ADD COLUMN `analytics_raw_retention_days` INTEGER NOT NULL DEFAULT 30;
--> statement-breakpoint
ALTER TABLE `site_settings` ADD COLUMN `analytics_respect_dnt` INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint

-- ---------- permission seed: view_admin_analytics (masteradmin) ----------
-- masteradmin bypasses permission checks (see auth/permissions.ts) but is
-- seeded here for clarity/adjustability, mirroring 0257's email seed. It stays
-- grantable to admins via the Roles & Permissions matrix (it is a canonical
-- admin_panel_tabs key), left off the admin default like view_system_metrics.
INSERT OR IGNORE INTO `role_permission_grants` (`role`, `permission_key`) VALUES
  ('masteradmin', 'view_admin_analytics');
