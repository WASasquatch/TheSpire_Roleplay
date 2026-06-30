-- Servers Lift — per-server earning CATALOGS, part 3 of 5: FREEFORM BORDERS.
--
-- The freeform-border catalog becomes per-server: PK widens from (key) to
-- (server_id, key). Same house rebuild idiom as 0283/0284/0285; one file = one
-- transaction. Every existing border + owned-border row homes to
-- 'server_spire_system', so The Spire's catalog, prices, and everyone's owned
-- freeform borders (incl. per-identity config_json color picks) are unchanged.
--
-- FK-BEARING parent. The enumerated children (user_owned_freeform_borders,
-- character_owned_freeform_borders) already carry server_id (0285); their FK to
-- the parent becomes COMPOSITE (server_id, border_key) ->
-- freeform_borders(server_id, key) ON DELETE CASCADE. Parent rebuilt FIRST.
--
-- The other inbound FK, flash_sales.freeform_border_key (ON DELETE SET NULL,
-- not in the enumerated child list), is handled in 0299 alongside the rest of
-- the flash-sale FKs. The runner runs with foreign_keys = OFF so the interim
-- DROP of freeform_borders is safe.

-- ============================================================
-- freeform_borders -> PK (server_id, key)
-- ============================================================
CREATE TABLE `freeform_borders_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `key` text NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `image_url` text,
  `template` text,
  `style_css` text,
  `rarity` text NOT NULL DEFAULT 'common',
  `cost` integer NOT NULL DEFAULT 0,
  `enabled` integer NOT NULL DEFAULT 1,
  `is_builtin` integer NOT NULL DEFAULT 0,
  `order` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `key`)
);
--> statement-breakpoint
INSERT INTO `freeform_borders_new` (
  `server_id`, `key`, `name`, `description`, `image_url`, `template`,
  `style_css`, `rarity`, `cost`, `enabled`, `is_builtin`, `order`,
  `created_at`, `updated_at`
)
SELECT
  'server_spire_system', `key`, `name`, `description`, `image_url`, `template`,
  `style_css`, `rarity`, `cost`, `enabled`, `is_builtin`, `order`,
  `created_at`, `updated_at`
FROM `freeform_borders`;
--> statement-breakpoint
DROP TABLE `freeform_borders`;
--> statement-breakpoint
ALTER TABLE `freeform_borders_new` RENAME TO `freeform_borders`;
--> statement-breakpoint

-- ============================================================
-- user_owned_freeform_borders -> composite FK (server_id, border_key)
-- ============================================================
CREATE TABLE `user_owned_freeform_borders_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `border_key` text NOT NULL,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `config_json` text,
  PRIMARY KEY (`server_id`, `user_id`, `border_key`),
  FOREIGN KEY (`server_id`, `border_key`) REFERENCES `freeform_borders`(`server_id`, `key`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `user_owned_freeform_borders_new` (
  `server_id`, `user_id`, `border_key`, `acquired_at`, `config_json`
)
SELECT
  `server_id`, `user_id`, `border_key`, `acquired_at`, `config_json`
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
-- character_owned_freeform_borders -> composite FK (server_id, border_key)
-- ============================================================
CREATE TABLE `character_owned_freeform_borders_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `character_id` text NOT NULL REFERENCES `characters`(`id`) ON DELETE CASCADE,
  `border_key` text NOT NULL,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `config_json` text,
  PRIMARY KEY (`server_id`, `character_id`, `border_key`),
  FOREIGN KEY (`server_id`, `border_key`) REFERENCES `freeform_borders`(`server_id`, `key`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `character_owned_freeform_borders_new` (
  `server_id`, `character_id`, `border_key`, `acquired_at`, `config_json`
)
SELECT
  `server_id`, `character_id`, `border_key`, `acquired_at`, `config_json`
FROM `character_owned_freeform_borders`;
--> statement-breakpoint
DROP TABLE `character_owned_freeform_borders`;
--> statement-breakpoint
ALTER TABLE `character_owned_freeform_borders_new` RENAME TO `character_owned_freeform_borders`;
--> statement-breakpoint
CREATE INDEX `character_owned_freeform_borders_character_idx`
  ON `character_owned_freeform_borders` (`character_id`);
