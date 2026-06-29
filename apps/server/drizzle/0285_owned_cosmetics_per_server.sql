-- Servers Lift, Phase 5.7 (per-server economy) — OWNED cosmetics + active equip.
--
-- Owned name-styles / borders / freeform-borders (per user AND per character)
-- and the user_active_cosmetics equip row are all bought with per-server
-- Currency, so they become per-server holdings: a person can own a style in
-- one server but not another, and equip a different look in each. server_id
-- joins each PK. Same house rebuild idiom as 0187 / 0283; one transaction.
--
-- Each row homes to 'server_spire_system' (the Phase-2 backfill target + only
-- server until the flag flips), so no owned cosmetic, per-identity config_json
-- customization, or active equip moves. The straight copy preserves every
-- config_json blob (color picks etc.) untouched.
--
-- FK-SAFE: no inbound FKs to any of these (verified empty grep). Outbound FKs
-- (users.id, characters.id, ranks.key, name_styles.key, freeform_borders.key)
-- are recreated verbatim so cascade cleanup (and active_name_style_key's
-- set-null-on-style-delete) is preserved. Indexes recreated after each RENAME.

-- ============================================================
-- user_owned_name_styles -> PK (server_id, user_id, style_key)
-- ============================================================
CREATE TABLE `user_owned_name_styles_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `style_key` text NOT NULL REFERENCES `name_styles`(`key`) ON DELETE CASCADE,
  `config_json` text,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `user_id`, `style_key`)
);
--> statement-breakpoint
INSERT INTO `user_owned_name_styles_new` (
  `server_id`, `user_id`, `style_key`, `config_json`, `acquired_at`
)
SELECT
  'server_spire_system', `user_id`, `style_key`, `config_json`, `acquired_at`
FROM `user_owned_name_styles`;
--> statement-breakpoint
DROP TABLE `user_owned_name_styles`;
--> statement-breakpoint
ALTER TABLE `user_owned_name_styles_new` RENAME TO `user_owned_name_styles`;
--> statement-breakpoint
CREATE INDEX `user_owned_name_styles_user_idx`
  ON `user_owned_name_styles` (`user_id`);
--> statement-breakpoint

-- ============================================================
-- user_owned_borders -> PK (server_id, user_id, rank_key)
-- ============================================================
CREATE TABLE `user_owned_borders_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `rank_key` text NOT NULL REFERENCES `ranks`(`key`) ON DELETE CASCADE,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `user_id`, `rank_key`)
);
--> statement-breakpoint
INSERT INTO `user_owned_borders_new` (
  `server_id`, `user_id`, `rank_key`, `acquired_at`
)
SELECT
  'server_spire_system', `user_id`, `rank_key`, `acquired_at`
FROM `user_owned_borders`;
--> statement-breakpoint
DROP TABLE `user_owned_borders`;
--> statement-breakpoint
ALTER TABLE `user_owned_borders_new` RENAME TO `user_owned_borders`;
--> statement-breakpoint
CREATE INDEX `user_owned_borders_user_idx`
  ON `user_owned_borders` (`user_id`);
--> statement-breakpoint

-- ============================================================
-- user_owned_freeform_borders -> PK (server_id, user_id, border_key)
-- ============================================================
CREATE TABLE `user_owned_freeform_borders_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `border_key` text NOT NULL REFERENCES `freeform_borders`(`key`) ON DELETE CASCADE,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `config_json` text,
  PRIMARY KEY (`server_id`, `user_id`, `border_key`)
);
--> statement-breakpoint
INSERT INTO `user_owned_freeform_borders_new` (
  `server_id`, `user_id`, `border_key`, `acquired_at`, `config_json`
)
SELECT
  'server_spire_system', `user_id`, `border_key`, `acquired_at`, `config_json`
FROM `user_owned_freeform_borders`;
--> statement-breakpoint
DROP TABLE `user_owned_freeform_borders`;
--> statement-breakpoint
ALTER TABLE `user_owned_freeform_borders_new` RENAME TO `user_owned_freeform_borders`;
--> statement-breakpoint
CREATE INDEX `user_owned_freeform_borders_user_idx`
  ON `user_owned_freeform_borders` (`user_id`);
--> statement-breakpoint

-- ============================================================
-- character_owned_name_styles -> PK (server_id, character_id, style_key)
-- ============================================================
CREATE TABLE `character_owned_name_styles_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `character_id` text NOT NULL REFERENCES `characters`(`id`) ON DELETE CASCADE,
  `style_key` text NOT NULL REFERENCES `name_styles`(`key`) ON DELETE CASCADE,
  `config_json` text,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `character_id`, `style_key`)
);
--> statement-breakpoint
INSERT INTO `character_owned_name_styles_new` (
  `server_id`, `character_id`, `style_key`, `config_json`, `acquired_at`
)
SELECT
  'server_spire_system', `character_id`, `style_key`, `config_json`, `acquired_at`
FROM `character_owned_name_styles`;
--> statement-breakpoint
DROP TABLE `character_owned_name_styles`;
--> statement-breakpoint
ALTER TABLE `character_owned_name_styles_new` RENAME TO `character_owned_name_styles`;
--> statement-breakpoint
CREATE INDEX `character_owned_name_styles_character_idx`
  ON `character_owned_name_styles` (`character_id`);
--> statement-breakpoint

-- ============================================================
-- character_owned_borders -> PK (server_id, character_id, rank_key)
-- ============================================================
CREATE TABLE `character_owned_borders_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `character_id` text NOT NULL REFERENCES `characters`(`id`) ON DELETE CASCADE,
  `rank_key` text NOT NULL REFERENCES `ranks`(`key`) ON DELETE CASCADE,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `character_id`, `rank_key`)
);
--> statement-breakpoint
INSERT INTO `character_owned_borders_new` (
  `server_id`, `character_id`, `rank_key`, `acquired_at`
)
SELECT
  'server_spire_system', `character_id`, `rank_key`, `acquired_at`
FROM `character_owned_borders`;
--> statement-breakpoint
DROP TABLE `character_owned_borders`;
--> statement-breakpoint
ALTER TABLE `character_owned_borders_new` RENAME TO `character_owned_borders`;
--> statement-breakpoint
CREATE INDEX `character_owned_borders_character_idx`
  ON `character_owned_borders` (`character_id`);
--> statement-breakpoint

-- ============================================================
-- character_owned_freeform_borders -> PK (server_id, character_id, border_key)
-- ============================================================
CREATE TABLE `character_owned_freeform_borders_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `character_id` text NOT NULL REFERENCES `characters`(`id`) ON DELETE CASCADE,
  `border_key` text NOT NULL REFERENCES `freeform_borders`(`key`) ON DELETE CASCADE,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `config_json` text,
  PRIMARY KEY (`server_id`, `character_id`, `border_key`)
);
--> statement-breakpoint
INSERT INTO `character_owned_freeform_borders_new` (
  `server_id`, `character_id`, `border_key`, `acquired_at`, `config_json`
)
SELECT
  'server_spire_system', `character_id`, `border_key`, `acquired_at`, `config_json`
FROM `character_owned_freeform_borders`;
--> statement-breakpoint
DROP TABLE `character_owned_freeform_borders`;
--> statement-breakpoint
ALTER TABLE `character_owned_freeform_borders_new` RENAME TO `character_owned_freeform_borders`;
--> statement-breakpoint
CREATE INDEX `character_owned_freeform_borders_character_idx`
  ON `character_owned_freeform_borders` (`character_id`);
--> statement-breakpoint

-- ============================================================
-- user_active_cosmetics -> PK (server_id, user_id)
-- ============================================================
-- The master/OOC equip row. Per-server: equip a different inline-avatar /
-- name-style / room-transition / banner per server. active_name_style_key
-- keeps its set-null-on-style-delete FK.
CREATE TABLE `user_active_cosmetics_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `inline_avatar_enabled` integer NOT NULL DEFAULT 0,
  `lurking_master_enabled` integer NOT NULL DEFAULT 0,
  `active_name_style_key` text REFERENCES `name_styles`(`key`) ON DELETE SET NULL,
  `active_room_transition_key` text,
  `profile_banner_url` text,
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `user_id`)
);
--> statement-breakpoint
INSERT INTO `user_active_cosmetics_new` (
  `server_id`, `user_id`, `inline_avatar_enabled`, `lurking_master_enabled`,
  `active_name_style_key`, `active_room_transition_key`, `profile_banner_url`,
  `updated_at`
)
SELECT
  'server_spire_system', `user_id`, `inline_avatar_enabled`, `lurking_master_enabled`,
  `active_name_style_key`, `active_room_transition_key`, `profile_banner_url`,
  `updated_at`
FROM `user_active_cosmetics`;
--> statement-breakpoint
DROP TABLE `user_active_cosmetics`;
--> statement-breakpoint
ALTER TABLE `user_active_cosmetics_new` RENAME TO `user_active_cosmetics`;
