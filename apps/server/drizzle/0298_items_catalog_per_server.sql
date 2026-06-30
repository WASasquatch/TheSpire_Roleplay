-- Servers Lift — per-server earning CATALOGS, part 4 of 5: ITEMS.
--
-- The item catalog becomes per-server: PK widens from (key) to (server_id,
-- key). Same house rebuild idiom as 0283/0284/0285; one file = one
-- transaction. Every existing item + holding row homes to
-- 'server_spire_system', so The Spire's catalog, prices, sale windows, and
-- everyone's inventory / collection / pet collection are unchanged.
--
-- FK-BEARING parent. The enumerated children (identity_inventory,
-- identity_collection, identity_pet_collection) already carry server_id (0284);
-- their FK to the parent becomes COMPOSITE (server_id, item_key) ->
-- items(server_id, key) ON DELETE CASCADE. Parent rebuilt FIRST. Each child's
-- slot CHECK constraint, owner/item indexes, and PK are preserved verbatim.
--
-- EXTRA inbound FKs (single-column FK into items(key) that the widened PK would
-- leave dangling -> runtime "foreign key mismatch"; NONE are in the enumerated
-- child list):
--   eidolon_state.pet_item_key             (ON DELETE SET NULL)
--   builtin_command_config.reward_item_key (ON DELETE SET NULL) -- GLOBAL table
--   server_builtin_command_config.reward_item_key (ON DELETE SET NULL)
-- All three are ON DELETE SET NULL, which can't be expressed as a composite FK
-- because SET NULL would also null the NOT NULL server_id (builtin_command_config
-- has no server_id at all). We therefore DROP each FK constraint and keep the
-- column as plain text; these item keys are validated against the live catalog
-- by their write paths, and the read paths tolerate a missing item the same way
-- SET NULL's null would (no pet sprite / no reward grant). The runner runs with
-- foreign_keys = OFF so the interim DROP of items is safe.

-- ============================================================
-- items -> PK (server_id, key)
-- ============================================================
CREATE TABLE `items_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `key` text NOT NULL,
  `name` text NOT NULL,
  `name_plural` text,
  `description` text NOT NULL DEFAULT '',
  `icon_url` text,
  `price` integer NOT NULL DEFAULT 0,
  `stack_limit` integer NOT NULL DEFAULT 99,
  `give_messages_json` text NOT NULL DEFAULT '[]',
  `throw_messages_json` text NOT NULL DEFAULT '[]',
  `drop_messages_json` text NOT NULL DEFAULT '[]',
  `aliases_json` text NOT NULL DEFAULT '[]',
  `category` text NOT NULL DEFAULT 'misc',
  `enabled` integer NOT NULL DEFAULT 1,
  `for_sale` integer NOT NULL DEFAULT 1,
  `sale_starts_at` integer,
  `sale_ends_at` integer,
  `order` integer NOT NULL DEFAULT 0,
  `is_builtin` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `key`)
);
--> statement-breakpoint
INSERT INTO `items_new` (
  `server_id`, `key`, `name`, `name_plural`, `description`, `icon_url`,
  `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`,
  `drop_messages_json`, `aliases_json`, `category`, `enabled`, `for_sale`,
  `sale_starts_at`, `sale_ends_at`, `order`, `is_builtin`, `created_at`,
  `updated_at`
)
SELECT
  'server_spire_system', `key`, `name`, `name_plural`, `description`, `icon_url`,
  `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`,
  `drop_messages_json`, `aliases_json`, `category`, `enabled`, `for_sale`,
  `sale_starts_at`, `sale_ends_at`, `order`, `is_builtin`, `created_at`,
  `updated_at`
FROM `items`;
--> statement-breakpoint
DROP TABLE `items`;
--> statement-breakpoint
ALTER TABLE `items_new` RENAME TO `items`;
--> statement-breakpoint
CREATE INDEX `items_order_idx` ON `items` (`order`);
--> statement-breakpoint
CREATE INDEX `items_enabled_for_sale_idx` ON `items` (`enabled`, `for_sale`);
--> statement-breakpoint
CREATE INDEX `items_category_idx` ON `items` (`category`);
--> statement-breakpoint

-- ============================================================
-- identity_inventory -> composite FK (server_id, item_key) -> items
-- ============================================================
CREATE TABLE `identity_inventory_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `owner_scope` text NOT NULL,
  `owner_id` text NOT NULL,
  `item_key` text NOT NULL,
  `quantity` integer NOT NULL DEFAULT 0,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `owner_scope`, `owner_id`, `item_key`),
  FOREIGN KEY (`server_id`, `item_key`) REFERENCES `items`(`server_id`, `key`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `identity_inventory_new` (
  `server_id`, `owner_scope`, `owner_id`, `item_key`, `quantity`,
  `acquired_at`, `updated_at`
)
SELECT
  `server_id`, `owner_scope`, `owner_id`, `item_key`, `quantity`,
  `acquired_at`, `updated_at`
FROM `identity_inventory`;
--> statement-breakpoint
DROP TABLE `identity_inventory`;
--> statement-breakpoint
ALTER TABLE `identity_inventory_new` RENAME TO `identity_inventory`;
--> statement-breakpoint
CREATE INDEX `identity_inventory_owner_idx`
  ON `identity_inventory` (`owner_scope`, `owner_id`);
--> statement-breakpoint
CREATE INDEX `identity_inventory_item_idx`
  ON `identity_inventory` (`item_key`);
--> statement-breakpoint

-- ============================================================
-- identity_collection -> composite FK (server_id, item_key) -> items
-- ============================================================
CREATE TABLE `identity_collection_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `owner_scope` text NOT NULL,
  `owner_id` text NOT NULL,
  `slot` integer NOT NULL,
  `item_key` text NOT NULL,
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `owner_scope`, `owner_id`, `slot`),
  CHECK (`slot` >= 0 AND `slot` < 10),
  FOREIGN KEY (`server_id`, `item_key`) REFERENCES `items`(`server_id`, `key`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `identity_collection_new` (
  `server_id`, `owner_scope`, `owner_id`, `slot`, `item_key`, `updated_at`
)
SELECT
  `server_id`, `owner_scope`, `owner_id`, `slot`, `item_key`, `updated_at`
FROM `identity_collection`;
--> statement-breakpoint
DROP TABLE `identity_collection`;
--> statement-breakpoint
ALTER TABLE `identity_collection_new` RENAME TO `identity_collection`;
--> statement-breakpoint
CREATE INDEX `identity_collection_owner_idx`
  ON `identity_collection` (`owner_scope`, `owner_id`);
--> statement-breakpoint

-- ============================================================
-- identity_pet_collection -> composite FK (server_id, item_key) -> items
-- ============================================================
CREATE TABLE `identity_pet_collection_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `owner_scope` text NOT NULL,
  `owner_id` text NOT NULL,
  `slot` integer NOT NULL,
  `item_key` text NOT NULL,
  `nickname` text,
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `owner_scope`, `owner_id`, `slot`),
  CHECK (`slot` >= 0 AND `slot` < 5),
  FOREIGN KEY (`server_id`, `item_key`) REFERENCES `items`(`server_id`, `key`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `identity_pet_collection_new` (
  `server_id`, `owner_scope`, `owner_id`, `slot`, `item_key`, `nickname`, `updated_at`
)
SELECT
  `server_id`, `owner_scope`, `owner_id`, `slot`, `item_key`, `nickname`, `updated_at`
FROM `identity_pet_collection`;
--> statement-breakpoint
DROP TABLE `identity_pet_collection`;
--> statement-breakpoint
ALTER TABLE `identity_pet_collection_new` RENAME TO `identity_pet_collection`;
--> statement-breakpoint
CREATE INDEX `identity_pet_collection_owner_idx`
  ON `identity_pet_collection` (`owner_scope`, `owner_id`);
--> statement-breakpoint

-- ============================================================
-- eidolon_state -> drop the now-invalid items FK (keep pet_item_key column)
-- ============================================================
-- Already PK(server_id, owner_scope, owner_id) from 0284. Rebuilt only to drop
-- the single-column pet_item_key -> items(key) FK the widened PK invalidated.
-- Every column, default, and the PK are preserved verbatim; pet_item_key stays
-- a nullable plain-text column (read path renders no pet sprite for a missing
-- key, the same outcome SET NULL produced). Straight copy.
CREATE TABLE `eidolon_state_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `owner_scope` text NOT NULL,
  `owner_id` text NOT NULL,
  `stage` text NOT NULL DEFAULT 'alive',
  `kind` text NOT NULL DEFAULT 'species',
  `species_id` text,
  `pet_item_key` text,
  `name` text NOT NULL DEFAULT '',
  `satiety` real NOT NULL DEFAULT 80,
  `joy` real NOT NULL DEFAULT 75,
  `vigor` real NOT NULL DEFAULT 85,
  `hygiene` real NOT NULL DEFAULT 80,
  `health` real NOT NULL DEFAULT 100,
  `sick` integer NOT NULL DEFAULT 0,
  `asleep` integer NOT NULL DEFAULT 0,
  `age_hours` real NOT NULL DEFAULT 0,
  `sim_hour` real NOT NULL DEFAULT 8,
  `mess_count` integer NOT NULL DEFAULT 0,
  `xp` real NOT NULL DEFAULT 0,
  `trait` text,
  `variant` text,
  `bonus_xp` real NOT NULL DEFAULT 0,
  `streak_count` integer NOT NULL DEFAULT 0,
  `last_checkin_day_key` text,
  `best_streak` integer NOT NULL DEFAULT 0,
  `nudge_optin` integer NOT NULL DEFAULT 1,
  `last_nudge_day_key` text,
  `last_seen_ms` integer NOT NULL DEFAULT 0,
  `hatched_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `owner_scope`, `owner_id`)
);
--> statement-breakpoint
INSERT INTO `eidolon_state_new` (
  `server_id`, `owner_scope`, `owner_id`, `stage`, `kind`, `species_id`,
  `pet_item_key`, `name`, `satiety`, `joy`, `vigor`, `hygiene`, `health`,
  `sick`, `asleep`, `age_hours`, `sim_hour`, `mess_count`, `xp`, `trait`,
  `variant`, `bonus_xp`, `streak_count`, `last_checkin_day_key`, `best_streak`,
  `nudge_optin`, `last_nudge_day_key`, `last_seen_ms`, `hatched_at`,
  `created_at`, `updated_at`
)
SELECT
  `server_id`, `owner_scope`, `owner_id`, `stage`, `kind`, `species_id`,
  `pet_item_key`, `name`, `satiety`, `joy`, `vigor`, `hygiene`, `health`,
  `sick`, `asleep`, `age_hours`, `sim_hour`, `mess_count`, `xp`, `trait`,
  `variant`, `bonus_xp`, `streak_count`, `last_checkin_day_key`, `best_streak`,
  `nudge_optin`, `last_nudge_day_key`, `last_seen_ms`, `hatched_at`,
  `created_at`, `updated_at`
FROM `eidolon_state`;
--> statement-breakpoint
DROP TABLE `eidolon_state`;
--> statement-breakpoint
ALTER TABLE `eidolon_state_new` RENAME TO `eidolon_state`;
--> statement-breakpoint

-- ============================================================
-- builtin_command_config -> drop the now-invalid items FK (GLOBAL table)
-- ============================================================
-- Singleton-per-command global config; it has NO server_id, so its
-- reward_item_key -> items(key) FK cannot be composed. Rebuilt only to drop
-- that FK; every column, default, the command_name PK, and the
-- updated_by_user_id -> users(id) FK (ON DELETE SET NULL) are preserved.
CREATE TABLE `builtin_command_config_new` (
  `command_name` text PRIMARY KEY NOT NULL,
  `reward_xp` integer NOT NULL DEFAULT 0,
  `reward_currency` integer NOT NULL DEFAULT 0,
  `reward_item_key` text,
  `reward_item_count` integer NOT NULL DEFAULT 0,
  `duration_ms` integer,
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `builtin_command_config_new` (
  `command_name`, `reward_xp`, `reward_currency`, `reward_item_key`,
  `reward_item_count`, `duration_ms`, `updated_at`, `updated_by_user_id`
)
SELECT
  `command_name`, `reward_xp`, `reward_currency`, `reward_item_key`,
  `reward_item_count`, `duration_ms`, `updated_at`, `updated_by_user_id`
FROM `builtin_command_config`;
--> statement-breakpoint
DROP TABLE `builtin_command_config`;
--> statement-breakpoint
ALTER TABLE `builtin_command_config_new` RENAME TO `builtin_command_config`;
--> statement-breakpoint

-- ============================================================
-- server_builtin_command_config -> drop the now-invalid items FK
-- ============================================================
-- Per-server override, PK (server_id, command_name). Its reward_item_key FK was
-- ON DELETE SET NULL, which can't be a composite FK (would null the NOT NULL
-- server_id). Rebuilt only to drop the items FK; the server_id -> servers(id)
-- FK (ON DELETE CASCADE), the updated_by_user_id -> users(id) FK (SET NULL), the
-- composite PK, and every column/default are preserved.
CREATE TABLE `server_builtin_command_config_new` (
  `server_id` text NOT NULL REFERENCES `servers`(`id`) ON DELETE CASCADE,
  `command_name` text NOT NULL,
  `reward_xp` integer NOT NULL DEFAULT 0,
  `reward_currency` integer NOT NULL DEFAULT 0,
  `reward_item_key` text,
  `reward_item_count` integer NOT NULL DEFAULT 0,
  `duration_ms` integer,
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  PRIMARY KEY (`server_id`, `command_name`)
);
--> statement-breakpoint
INSERT INTO `server_builtin_command_config_new` (
  `server_id`, `command_name`, `reward_xp`, `reward_currency`,
  `reward_item_key`, `reward_item_count`, `duration_ms`, `updated_at`,
  `updated_by_user_id`
)
SELECT
  `server_id`, `command_name`, `reward_xp`, `reward_currency`,
  `reward_item_key`, `reward_item_count`, `duration_ms`, `updated_at`,
  `updated_by_user_id`
FROM `server_builtin_command_config`;
--> statement-breakpoint
DROP TABLE `server_builtin_command_config`;
--> statement-breakpoint
ALTER TABLE `server_builtin_command_config_new` RENAME TO `server_builtin_command_config`;
