-- Servers Lift — per-server earning CATALOGS, part 2 of 5: NAME STYLES.
--
-- The name-style catalog becomes per-server: PK widens from (key) to
-- (server_id, key). Same house rebuild idiom as 0283/0284/0285; one file =
-- one transaction. Every existing style + owned-style row homes to
-- 'server_spire_system', so The Spire's catalog, prices, and everyone's owned
-- styles (incl. per-identity config_json color picks) are unchanged.
--
-- FK-BEARING parent. The enumerated children (user_owned_name_styles,
-- character_owned_name_styles) already carry server_id (0285); their FK to the
-- parent becomes COMPOSITE (server_id, style_key) -> name_styles(server_id,
-- key) ON DELETE CASCADE (a per-server holding can only reference that server's
-- catalog). Parent rebuilt FIRST so the composite FK targets the widened PK.
--
-- EXTRA inbound FK (NOT in the enumerated child list, but a single-column FK
-- into name_styles(key) that the widened PK would leave dangling -> runtime
-- "foreign key mismatch"): user_active_cosmetics.active_name_style_key. That FK
-- was ON DELETE SET NULL, which is impossible to keep as a composite FK because
-- SET NULL would also null the NOT NULL server_id column. We therefore DROP the
-- FK constraint and keep the column as plain text; the equip read path already
-- LEFT JOINs name_styles by key (a stale key simply renders no style, the same
-- visible outcome SET NULL produced), and the equip/admin write paths validate
-- the key against the live catalog. flash_sales.name_style_key (also ON DELETE
-- SET NULL into name_styles) is handled in 0299. The runner runs with
-- foreign_keys = OFF so the interim DROP of name_styles is safe.

-- ============================================================
-- name_styles -> PK (server_id, key)
-- ============================================================
CREATE TABLE `name_styles_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `key` text NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `template` text NOT NULL,
  `style_css` text NOT NULL DEFAULT '',
  `cost` integer NOT NULL DEFAULT 0,
  `enabled` integer NOT NULL DEFAULT 1,
  `is_builtin` integer NOT NULL DEFAULT 0,
  `order` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `key`)
);
--> statement-breakpoint
INSERT INTO `name_styles_new` (
  `server_id`, `key`, `name`, `description`, `template`, `style_css`, `cost`,
  `enabled`, `is_builtin`, `order`, `created_at`, `updated_at`
)
SELECT
  'server_spire_system', `key`, `name`, `description`, `template`, `style_css`, `cost`,
  `enabled`, `is_builtin`, `order`, `created_at`, `updated_at`
FROM `name_styles`;
--> statement-breakpoint
DROP TABLE `name_styles`;
--> statement-breakpoint
ALTER TABLE `name_styles_new` RENAME TO `name_styles`;
--> statement-breakpoint

-- ============================================================
-- user_owned_name_styles -> composite FK (server_id, style_key) -> name_styles
-- ============================================================
CREATE TABLE `user_owned_name_styles_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `style_key` text NOT NULL,
  `config_json` text,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `user_id`, `style_key`),
  FOREIGN KEY (`server_id`, `style_key`) REFERENCES `name_styles`(`server_id`, `key`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `user_owned_name_styles_new` (
  `server_id`, `user_id`, `style_key`, `config_json`, `acquired_at`
)
SELECT
  `server_id`, `user_id`, `style_key`, `config_json`, `acquired_at`
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
-- character_owned_name_styles -> composite FK (server_id, style_key) -> name_styles
-- ============================================================
CREATE TABLE `character_owned_name_styles_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `character_id` text NOT NULL REFERENCES `characters`(`id`) ON DELETE CASCADE,
  `style_key` text NOT NULL,
  `config_json` text,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `character_id`, `style_key`),
  FOREIGN KEY (`server_id`, `style_key`) REFERENCES `name_styles`(`server_id`, `key`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `character_owned_name_styles_new` (
  `server_id`, `character_id`, `style_key`, `config_json`, `acquired_at`
)
SELECT
  `server_id`, `character_id`, `style_key`, `config_json`, `acquired_at`
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
-- user_active_cosmetics -> drop the now-invalid name_styles FK (keep column)
-- ============================================================
-- Already PK(server_id, user_id) from 0285. We rebuild only to remove the
-- single-column active_name_style_key -> name_styles(key) FK that the widened
-- composite PK invalidated. Every column, default, the PK, and the users FK
-- (ON DELETE CASCADE) are preserved verbatim; active_name_style_key stays a
-- nullable plain-text column. Straight copy.
CREATE TABLE `user_active_cosmetics_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `inline_avatar_enabled` integer NOT NULL DEFAULT 0,
  `lurking_master_enabled` integer NOT NULL DEFAULT 0,
  `active_name_style_key` text,
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
  `server_id`, `user_id`, `inline_avatar_enabled`, `lurking_master_enabled`,
  `active_name_style_key`, `active_room_transition_key`, `profile_banner_url`,
  `updated_at`
FROM `user_active_cosmetics`;
--> statement-breakpoint
DROP TABLE `user_active_cosmetics`;
--> statement-breakpoint
ALTER TABLE `user_active_cosmetics_new` RENAME TO `user_active_cosmetics`;
