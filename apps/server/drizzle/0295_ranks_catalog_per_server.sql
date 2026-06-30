-- Servers Lift — per-server earning CATALOGS, part 1 of 5: RANKS.
--
-- "Nothing stays global — everything per-server" extends to the catalog DEFS
-- themselves. The rank catalog (and its tiers + the owned-border ledgers that
-- FK into it) becomes per-server: each server owns its own ranks, prices, and
-- tier thresholds, so a server can curate a different ladder. The grain widens
-- from PK(key) to PK(server_id, key). Same house rebuild idiom as 0283/0284/
-- 0285 (CREATE __new with the wider PK, INSERT...SELECT stamping
-- server_id = 'server_spire_system', DROP old, RENAME, recreate indexes) —
-- one file = one transaction.
--
-- Every existing rank / tier / owned-border row homes to 'server_spire_system'
-- (the default + only server until the flag flips), so The Spire's ladder,
-- prices, and everyone's owned borders are byte-for-byte unchanged.
--
-- FK-BEARING parent: rank_tiers, user_owned_borders, character_owned_borders
-- all FK into ranks. Children already carry server_id (rank_tiers gains it
-- here); their FK to the parent becomes COMPOSITE (server_id, rank_key) ->
-- ranks(server_id, key) so a server's holdings can only reference that server's
-- catalog. Order matters: ranks is rebuilt FIRST (parent), then each child, so
-- the composite FK targets the already-widened parent PK. The runner runs with
-- foreign_keys = OFF, so the interim DROP of an FK-referenced table is safe.

-- ============================================================
-- ranks -> PK (server_id, key)
-- ============================================================
CREATE TABLE `ranks_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `key` text NOT NULL,
  `name` text NOT NULL,
  `order` integer NOT NULL DEFAULT 0,
  `enabled` integer NOT NULL DEFAULT 1,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `key`)
);
--> statement-breakpoint
INSERT INTO `ranks_new` (
  `server_id`, `key`, `name`, `order`, `enabled`, `created_at`, `updated_at`
)
SELECT
  'server_spire_system', `key`, `name`, `order`, `enabled`, `created_at`, `updated_at`
FROM `ranks`;
--> statement-breakpoint
DROP TABLE `ranks`;
--> statement-breakpoint
ALTER TABLE `ranks_new` RENAME TO `ranks`;
--> statement-breakpoint

-- ============================================================
-- rank_tiers -> add server_id, composite FK (server_id, rank_key) -> ranks
-- ============================================================
-- Keeps its surrogate `id` PK; server_id joins the columns and the FK so a
-- tier belongs to one server's rank. The rank/tier uniqueness and the xp index
-- become server-scoped.
CREATE TABLE `rank_tiers_new` (
  `id` text PRIMARY KEY NOT NULL,
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `rank_key` text NOT NULL,
  `tier` integer NOT NULL,
  `label` text NOT NULL,
  `xp_threshold` integer NOT NULL DEFAULT 0,
  `sigil_image_url` text NOT NULL DEFAULT '',
  `border_image_url` text,
  `border_cost` integer,
  `enabled` integer NOT NULL DEFAULT 1,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (`server_id`, `rank_key`) REFERENCES `ranks`(`server_id`, `key`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `rank_tiers_new` (
  `id`, `server_id`, `rank_key`, `tier`, `label`, `xp_threshold`,
  `sigil_image_url`, `border_image_url`, `border_cost`, `enabled`,
  `created_at`, `updated_at`
)
SELECT
  `id`, 'server_spire_system', `rank_key`, `tier`, `label`, `xp_threshold`,
  `sigil_image_url`, `border_image_url`, `border_cost`, `enabled`,
  `created_at`, `updated_at`
FROM `rank_tiers`;
--> statement-breakpoint
DROP TABLE `rank_tiers`;
--> statement-breakpoint
ALTER TABLE `rank_tiers_new` RENAME TO `rank_tiers`;
--> statement-breakpoint
CREATE UNIQUE INDEX `rank_tiers_rank_tier_uq`
  ON `rank_tiers` (`server_id`, `rank_key`, `tier`);
--> statement-breakpoint
CREATE INDEX `rank_tiers_xp_idx`
  ON `rank_tiers` (`xp_threshold`);
--> statement-breakpoint

-- ============================================================
-- user_owned_borders -> composite FK (server_id, rank_key) -> ranks
-- ============================================================
-- Already PK(server_id, user_id, rank_key) from 0285; the only change is the
-- rank FK becoming composite so an owned border can only reference that
-- server's rank. user FK + ON DELETE CASCADE preserved. Straight copy.
CREATE TABLE `user_owned_borders_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `rank_key` text NOT NULL,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `user_id`, `rank_key`),
  FOREIGN KEY (`server_id`, `rank_key`) REFERENCES `ranks`(`server_id`, `key`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `user_owned_borders_new` (
  `server_id`, `user_id`, `rank_key`, `acquired_at`
)
SELECT
  `server_id`, `user_id`, `rank_key`, `acquired_at`
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
-- character_owned_borders -> composite FK (server_id, rank_key) -> ranks
-- ============================================================
CREATE TABLE `character_owned_borders_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `character_id` text NOT NULL REFERENCES `characters`(`id`) ON DELETE CASCADE,
  `rank_key` text NOT NULL,
  `acquired_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `character_id`, `rank_key`),
  FOREIGN KEY (`server_id`, `rank_key`) REFERENCES `ranks`(`server_id`, `key`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `character_owned_borders_new` (
  `server_id`, `character_id`, `rank_key`, `acquired_at`
)
SELECT
  `server_id`, `character_id`, `rank_key`, `acquired_at`
FROM `character_owned_borders`;
--> statement-breakpoint
DROP TABLE `character_owned_borders`;
--> statement-breakpoint
ALTER TABLE `character_owned_borders_new` RENAME TO `character_owned_borders`;
--> statement-breakpoint
CREATE INDEX `character_owned_borders_character_idx`
  ON `character_owned_borders` (`character_id`);
