-- Standing system foundation — XP + Currency + Ranks + Cosmetics.
--
-- Adds the full table set described in plan.md:
--   ranks                     ladder definition (6 default rows; admin extensible)
--   rank_tiers                tiers within a rank (4 default per rank; capstone unlocks border)
--   name_styles               admin-authored HTML+CSS templates for displayed names
--   cosmetics                 purchasable feature catalog (inline_avatar, rank_border)
--   user_standing             per-master pool (XP, Currency, current rank, max ever held)
--   character_standing        per-character pool (mirrors user_standing)
--   standing_ledger           append-only audit of every delta on either scope
--   user_owned_borders        which rank borders a user has purchased
--   user_owned_name_styles    which styles a user has purchased + their config
--   user_active_cosmetics     currently-equipped cosmetic state (inline avatar, name style)
--   standing_notifications    persistent rank-up events for the ribbon
--
-- This migration is structure-only — seed data lands in 0065 so the
-- seed step can be re-run independently (the catalog rows reference
-- bundled asset paths that may shift if admins later upload
-- replacements, and the seed migration is the place to re-establish
-- a sane baseline).

CREATE TABLE `ranks` (
  `key` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `order` integer NOT NULL DEFAULT 0,
  `enabled` integer NOT NULL DEFAULT 1,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

CREATE TABLE `rank_tiers` (
  `id` text PRIMARY KEY NOT NULL,
  `rank_key` text NOT NULL REFERENCES `ranks`(`key`) ON DELETE CASCADE,
  `tier` integer NOT NULL,
  `label` text NOT NULL,
  `xp_threshold` integer NOT NULL DEFAULT 0,
  `sigil_image_url` text NOT NULL DEFAULT '',
  `border_image_url` text,
  `border_cost` integer,
  `enabled` integer NOT NULL DEFAULT 1,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rank_tiers_rank_tier_uq` ON `rank_tiers` (`rank_key`, `tier`);
--> statement-breakpoint
CREATE INDEX `rank_tiers_xp_idx` ON `rank_tiers` (`xp_threshold`);
--> statement-breakpoint

CREATE TABLE `name_styles` (
  `key` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `template` text NOT NULL,
  `style_css` text NOT NULL DEFAULT '',
  `cost` integer NOT NULL DEFAULT 0,
  `enabled` integer NOT NULL DEFAULT 1,
  `is_builtin` integer NOT NULL DEFAULT 0,
  `order` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

CREATE TABLE `cosmetics` (
  `key` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `cost` integer NOT NULL DEFAULT 0,
  `enabled` integer NOT NULL DEFAULT 1,
  `config_json` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

CREATE TABLE `user_standing` (
  `user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `xp` integer NOT NULL DEFAULT 0,
  `currency` integer NOT NULL DEFAULT 0,
  `rank_key` text,
  `tier` integer,
  `max_rank_key_ever_held` text,
  `max_tier_ever_held` integer,
  `hide_currency_count` integer NOT NULL DEFAULT 0,
  `selected_border_rank_key` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

CREATE TABLE `character_standing` (
  `character_id` text PRIMARY KEY NOT NULL REFERENCES `characters`(`id`) ON DELETE CASCADE,
  `xp` integer NOT NULL DEFAULT 0,
  `currency` integer NOT NULL DEFAULT 0,
  `rank_key` text,
  `tier` integer,
  `max_rank_key_ever_held` text,
  `max_tier_ever_held` integer,
  `selected_border_rank_key` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

-- Append-only audit. No FK on owner_id because the column points at
-- two different tables depending on `scope`. Same pattern used by
-- audit_log's loose target columns.
CREATE TABLE `standing_ledger` (
  `id` text PRIMARY KEY NOT NULL,
  `scope` text NOT NULL,
  `owner_id` text NOT NULL,
  `xp_delta` integer NOT NULL DEFAULT 0,
  `currency_delta` integer NOT NULL DEFAULT 0,
  `reason` text NOT NULL,
  `metadata_json` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX `standing_ledger_owner_time_idx`
  ON `standing_ledger` (`scope`, `owner_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `standing_ledger_reason_idx`
  ON `standing_ledger` (`reason`, `created_at`);
--> statement-breakpoint

CREATE TABLE `user_owned_borders` (
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `rank_key` text NOT NULL REFERENCES `ranks`(`key`) ON DELETE CASCADE,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`user_id`, `rank_key`)
);
--> statement-breakpoint
CREATE INDEX `user_owned_borders_user_idx` ON `user_owned_borders` (`user_id`);
--> statement-breakpoint

CREATE TABLE `user_owned_name_styles` (
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `style_key` text NOT NULL REFERENCES `name_styles`(`key`) ON DELETE CASCADE,
  `config_json` text,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`user_id`, `style_key`)
);
--> statement-breakpoint
CREATE INDEX `user_owned_name_styles_user_idx` ON `user_owned_name_styles` (`user_id`);
--> statement-breakpoint

CREATE TABLE `user_active_cosmetics` (
  `user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `inline_avatar_enabled` integer NOT NULL DEFAULT 0,
  `active_name_style_key` text REFERENCES `name_styles`(`key`) ON DELETE SET NULL,
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

CREATE TABLE `standing_notifications` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL DEFAULT 'rankup',
  `scope` text NOT NULL,
  `character_id` text,
  `from_rank_key` text,
  `from_tier` integer,
  `to_rank_key` text NOT NULL,
  `to_tier` integer NOT NULL,
  `newly_eligible_border_keys` text NOT NULL DEFAULT '',
  `acknowledged_at` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX `standing_notifications_user_unread_idx`
  ON `standing_notifications` (`user_id`, `acknowledged_at`);
