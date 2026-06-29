-- Servers Lift, Phase 5.7 (per-server economy) — identity HOLDINGS.
--
-- Inventories, collections, pet collections, game stats, Eidolon saves, and
-- story copies are all per-(ownerScope, ownerId) identity holdings today. Per
-- the per-server economy, holdings are SEPARATE per server (you carry your own
-- items / familiar / arcade record in each server). So server_id joins each
-- composite PK. Same house rebuild idiom as 0187 / 0283; one transaction.
--
-- Every existing holding homes to 'server_spire_system' (the Phase-2 backfill
-- target + only server until the flag flips), so no item, collection pin, win
-- count, familiar, hall record, visit cooldown, or bought story copy moves.
--
-- FK-SAFE: no table has an inbound FK to any of these (verified empty grep of
-- REFERENCES). The OUTBOUND FKs (items.key, users.id, characters.id, stories.id)
-- are recreated verbatim on the __new tables so cascade-cleanup behavior is
-- preserved. Indexes are recreated after each RENAME.

-- ============================================================
-- identity_inventory -> PK (server_id, owner_scope, owner_id, item_key)
-- ============================================================
CREATE TABLE `identity_inventory_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `owner_scope` text NOT NULL,
  `owner_id` text NOT NULL,
  `item_key` text NOT NULL REFERENCES `items`(`key`) ON DELETE CASCADE,
  `quantity` integer NOT NULL DEFAULT 0,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `owner_scope`, `owner_id`, `item_key`)
);
--> statement-breakpoint
INSERT INTO `identity_inventory_new` (
  `server_id`, `owner_scope`, `owner_id`, `item_key`, `quantity`,
  `acquired_at`, `updated_at`
)
SELECT
  'server_spire_system', `owner_scope`, `owner_id`, `item_key`, `quantity`,
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
-- identity_collection -> PK (server_id, owner_scope, owner_id, slot)
-- ============================================================
CREATE TABLE `identity_collection_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `owner_scope` text NOT NULL,
  `owner_id` text NOT NULL,
  `slot` integer NOT NULL,
  `item_key` text NOT NULL REFERENCES `items`(`key`) ON DELETE CASCADE,
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `owner_scope`, `owner_id`, `slot`),
  CHECK (`slot` >= 0 AND `slot` < 10)
);
--> statement-breakpoint
INSERT INTO `identity_collection_new` (
  `server_id`, `owner_scope`, `owner_id`, `slot`, `item_key`, `updated_at`
)
SELECT
  'server_spire_system', `owner_scope`, `owner_id`, `slot`, `item_key`, `updated_at`
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
-- identity_pet_collection -> PK (server_id, owner_scope, owner_id, slot)
-- ============================================================
CREATE TABLE `identity_pet_collection_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `owner_scope` text NOT NULL,
  `owner_id` text NOT NULL,
  `slot` integer NOT NULL,
  `item_key` text NOT NULL REFERENCES `items`(`key`) ON DELETE CASCADE,
  `nickname` text,
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `owner_scope`, `owner_id`, `slot`),
  CHECK (`slot` >= 0 AND `slot` < 5)
);
--> statement-breakpoint
INSERT INTO `identity_pet_collection_new` (
  `server_id`, `owner_scope`, `owner_id`, `slot`, `item_key`, `nickname`, `updated_at`
)
SELECT
  'server_spire_system', `owner_scope`, `owner_id`, `slot`, `item_key`, `nickname`, `updated_at`
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
-- game_stats -> PK (server_id, owner_scope, owner_id, game_kind)
-- ============================================================
CREATE TABLE `game_stats_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `owner_scope` text NOT NULL,
  `owner_id` text NOT NULL,
  `game_kind` text NOT NULL,
  `wins` integer NOT NULL DEFAULT 0,
  `points` integer NOT NULL DEFAULT 0,
  `last_won_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `owner_scope`, `owner_id`, `game_kind`)
);
--> statement-breakpoint
INSERT INTO `game_stats_new` (
  `server_id`, `owner_scope`, `owner_id`, `game_kind`, `wins`, `points`, `last_won_at`
)
SELECT
  'server_spire_system', `owner_scope`, `owner_id`, `game_kind`, `wins`, `points`, `last_won_at`
FROM `game_stats`;
--> statement-breakpoint
DROP TABLE `game_stats`;
--> statement-breakpoint
ALTER TABLE `game_stats_new` RENAME TO `game_stats`;
--> statement-breakpoint

-- ============================================================
-- eidolon_state -> PK (server_id, owner_scope, owner_id)
-- ============================================================
CREATE TABLE `eidolon_state_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `owner_scope` text NOT NULL,
  `owner_id` text NOT NULL,
  `stage` text NOT NULL DEFAULT 'alive',
  `kind` text NOT NULL DEFAULT 'species',
  `species_id` text,
  `pet_item_key` text REFERENCES `items`(`key`) ON DELETE SET NULL,
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
  'server_spire_system', `owner_scope`, `owner_id`, `stage`, `kind`, `species_id`,
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
-- eidolon_hall -> id PK kept; server_id added to the owner index
-- ============================================================
-- The Hall keeps its surrogate `id` PK (it's an append-only history, not an
-- identity-grain table). But its memorial records ARE per-server holdings, so
-- server_id joins the owner index and every row homes to the default server.
CREATE TABLE `eidolon_hall_new` (
  `id` text PRIMARY KEY NOT NULL,
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `owner_scope` text NOT NULL,
  `owner_id` text NOT NULL,
  `name` text NOT NULL DEFAULT '',
  `kind` text NOT NULL DEFAULT 'species',
  `species_id` text,
  `trait` text,
  `variant` text,
  `peak_level` integer NOT NULL DEFAULT 1,
  `age_hours` real NOT NULL DEFAULT 0,
  `depart_reason` text NOT NULL DEFAULT 'released',
  `departed_at` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO `eidolon_hall_new` (
  `id`, `server_id`, `owner_scope`, `owner_id`, `name`, `kind`, `species_id`,
  `trait`, `variant`, `peak_level`, `age_hours`, `depart_reason`, `departed_at`
)
SELECT
  `id`, 'server_spire_system', `owner_scope`, `owner_id`, `name`, `kind`, `species_id`,
  `trait`, `variant`, `peak_level`, `age_hours`, `depart_reason`, `departed_at`
FROM `eidolon_hall`;
--> statement-breakpoint
DROP TABLE `eidolon_hall`;
--> statement-breakpoint
ALTER TABLE `eidolon_hall_new` RENAME TO `eidolon_hall`;
--> statement-breakpoint
CREATE INDEX `eidolon_hall_owner_idx`
  ON `eidolon_hall` (`server_id`, `owner_scope`, `owner_id`, `departed_at`);
--> statement-breakpoint

-- ============================================================
-- eidolon_visits -> PK (server_id, visitor_user_id, target_owner_scope, target_owner_id)
-- ============================================================
-- The pat cooldown is per-server: a familiar lives in one server's economy, so
-- the same visitor's cooldown is tracked per (server, target).
CREATE TABLE `eidolon_visits_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `visitor_user_id` text NOT NULL,
  `target_owner_scope` text NOT NULL,
  `target_owner_id` text NOT NULL,
  `visited_at` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`server_id`, `visitor_user_id`, `target_owner_scope`, `target_owner_id`)
);
--> statement-breakpoint
INSERT INTO `eidolon_visits_new` (
  `server_id`, `visitor_user_id`, `target_owner_scope`, `target_owner_id`, `visited_at`
)
SELECT
  'server_spire_system', `visitor_user_id`, `target_owner_scope`, `target_owner_id`, `visited_at`
FROM `eidolon_visits`;
--> statement-breakpoint
DROP TABLE `eidolon_visits`;
--> statement-breakpoint
ALTER TABLE `eidolon_visits_new` RENAME TO `eidolon_visits`;
--> statement-breakpoint

-- ============================================================
-- story_copies -> server_id into the ownership uniqueness + indexes
-- ============================================================
-- A bought story copy is a per-server holding (the Currency that paid for it is
-- per-server). Keeps the surrogate `id` PK; server_id joins the "one copy per
-- identity per story" unique index and the showcase index.
CREATE TABLE `story_copies_new` (
  `id` text PRIMARY KEY NOT NULL,
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `story_id` text NOT NULL REFERENCES `stories`(`id`) ON DELETE CASCADE,
  `owner_scope` text NOT NULL,
  `owner_id` text NOT NULL,
  `owner_user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `price_paid` integer NOT NULL DEFAULT 0,
  `showcase_slot` integer,
  `purchased_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
INSERT INTO `story_copies_new` (
  `id`, `server_id`, `story_id`, `owner_scope`, `owner_id`, `owner_user_id`,
  `price_paid`, `showcase_slot`, `purchased_at`
)
SELECT
  `id`, 'server_spire_system', `story_id`, `owner_scope`, `owner_id`, `owner_user_id`,
  `price_paid`, `showcase_slot`, `purchased_at`
FROM `story_copies`;
--> statement-breakpoint
DROP TABLE `story_copies`;
--> statement-breakpoint
ALTER TABLE `story_copies_new` RENAME TO `story_copies`;
--> statement-breakpoint
CREATE UNIQUE INDEX `story_copies_owner_story_uq`
  ON `story_copies` (`server_id`, `owner_scope`, `owner_id`, `story_id`);
--> statement-breakpoint
CREATE INDEX `story_copies_showcase_idx`
  ON `story_copies` (`server_id`, `owner_scope`, `owner_id`, `showcase_slot`);
--> statement-breakpoint
CREATE INDEX `story_copies_story_idx`
  ON `story_copies` (`story_id`);
