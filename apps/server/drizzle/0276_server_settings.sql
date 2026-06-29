-- Servers Lift, Phase 1 (additive): per-server settings row. Canonical DDL:
-- plan.md §5.2.
--
-- The site_settings singleton (id='singleton') conflates THREE concerns:
--   (1) platform/operational  — session TTL, email verification + daily cap,
--       registration toggle, VAPID push keys, worldsSeedVersion, SEO meta,
--       custom head HTML  -> STAY on the singleton (master-admin only).
--   (2) per-server identity   — name/logo/banner/theme -> moved to `servers`
--       columns in 0275 (so the rail icon + chat shell read them directly).
--   (3) per-server behavior   — retention, room caps, content-length caps, edit
--       grace, default theme/style, welcome/rules HTML, forum caps, earning
--       config, flash sale toggle -> moved HERE, one row per server keyed by
--       server_id.
--
-- Splitting into a child table (rather than fattening `servers`) keeps the hot
-- identity row narrow for the catalog/rail query and matches how the settings
-- cache becomes Map<serverId, ServerSettings>. Every getSettings(db) caller
-- that reads a behavior knob must learn which server it's acting in; the
-- singleton getSettings() keeps serving platform fields unchanged.
--
-- NULL columns mean "inherit the platform default" (the existing singleton
-- value), so a freshly-provisioned server with an all-NULL row behaves exactly
-- like the legacy global config until the owner tunes something.
CREATE TABLE `server_settings` (
  `server_id` text PRIMARY KEY NOT NULL REFERENCES `servers`(`id`) ON DELETE CASCADE,
  -- chat behavior (NULL = inherit platform default)
  `message_retention_ms` integer,
  `max_rooms_per_owner` integer,
  `max_message_length` integer,
  `edit_grace_ms` integer,
  -- per-server default look (scoped to this server's shell; never the user's
  -- global profile theme — the non-bleed caveat that applies to forums/worlds)
  `default_theme_json` text,
  `default_style_key` text,
  `theme_design_map` text,
  -- per-community content (re-homed rulesHtml / securityNoticeHtml /
  -- newUserWelcomeHtml; platform ToS/splash welcome stay on the singleton).
  -- welcome_html = the server's own welcome copy; new_user_welcome_html mirrors
  -- the singleton field name for a byte-identical default-server seed.
  `rules_html` text,
  `security_notice_html` text,
  `welcome_html` text,
  `new_user_welcome_html` text,
  -- per-server forum caps (re-homed from the singleton's forum knobs)
  `max_forum_post_length` integer,
  `forum_topics_per_page` integer,
  -- per-server economy: earning faucet/sinks (award rates, caps, multi-char
  -- divisor, transfer gates) + the flash-sale enable. NULL = use the platform/
  -- shared earning config. The full per-server economy lands in Phase 5b
  -- (migrations 0282-0287); this column is its settings home.
  `earning_config_json` text,
  `flash_sale_enabled` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_by_id` text REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint

-- Per-(user, server) one-time welcome dismissal (the singleton's per-account
-- users.welcome_seen_hash can't express "seen server A's welcome but not B's").
-- Absent row = not yet seen; the hash gates re-show when the owner edits it.
CREATE TABLE `server_welcome_seen` (
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `server_id` text NOT NULL REFERENCES `servers`(`id`) ON DELETE CASCADE,
  `seen_hash` text NOT NULL DEFAULT '',
  `seen_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`user_id`, `server_id`)
);
