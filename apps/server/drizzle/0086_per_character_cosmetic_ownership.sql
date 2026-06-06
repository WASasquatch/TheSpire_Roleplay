-- Per-character ownership of cosmetics.
--
-- Before: `user_owned_name_styles` and `user_owned_borders` were a
-- single account-wide list. Once any identity (master or a
-- character) bought a style, the Owned list showed it for every
-- character of that user, Kaal saw Embers in their Owned tab even
-- though WAS spent the currency from master's pool.
--
-- After: ownership splits by identity:
--   master / OOC purchases → `user_owned_*` (existing tables, now
--                            reinterpreted as master-only)
--   character purchases    → `character_owned_*` (new tables, keyed
--                            by character_id)
--
-- Existing `user_owned_*` rows stay as master-only, no row movement,
-- just a semantic shift. Characters start with empty owned lists and
-- have to purchase from their own currency pool to use a style on
-- that identity.
--
-- The configJson per ownership row stays on each table so a
-- character can tune their colors independently of the master's
-- equipped version of the same style.

CREATE TABLE `character_owned_name_styles` (
  `character_id` TEXT NOT NULL REFERENCES `characters`(`id`) ON DELETE CASCADE,
  `style_key`    TEXT NOT NULL REFERENCES `name_styles`(`key`) ON DELETE CASCADE,
  `config_json`  TEXT,
  `acquired_at`  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`character_id`, `style_key`)
);
--> statement-breakpoint

CREATE INDEX `character_owned_name_styles_character_idx` ON `character_owned_name_styles`(`character_id`);
--> statement-breakpoint

CREATE TABLE `character_owned_borders` (
  `character_id` TEXT NOT NULL REFERENCES `characters`(`id`) ON DELETE CASCADE,
  `rank_key`     TEXT NOT NULL REFERENCES `ranks`(`key`) ON DELETE CASCADE,
  `acquired_at`  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`character_id`, `rank_key`)
);
--> statement-breakpoint

CREATE INDEX `character_owned_borders_character_idx` ON `character_owned_borders`(`character_id`);
