-- Eidolon Tamer lineage batch:
--   * eidolon_state.variant  — rare variant (e.g. "prismatic") rolled at hatch
--     (visual prestige + sale-value bump; no decay change). Nullable.
--   * eidolon_state.bonus_xp — non-sellable XP head-start inherited from a
--     predecessor (lineage). Counts toward level/visual but is subtracted
--     before sale value, so a hatch->sell loop can't farm it.
--   * eidolon_hall            — a memorial record per departed familiar
--     (sold/released). Powers The Hall gallery + lineage inheritance.

ALTER TABLE `eidolon_state` ADD COLUMN `variant` TEXT;
--> statement-breakpoint
ALTER TABLE `eidolon_state` ADD COLUMN `bonus_xp` REAL NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE `eidolon_hall` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `owner_scope` TEXT NOT NULL,
  `owner_id` TEXT NOT NULL,
  `name` TEXT NOT NULL DEFAULT '',
  `kind` TEXT NOT NULL DEFAULT 'species',
  `species_id` TEXT,
  `trait` TEXT,
  `variant` TEXT,
  `peak_level` INTEGER NOT NULL DEFAULT 1,
  `age_hours` REAL NOT NULL DEFAULT 0,
  `depart_reason` TEXT NOT NULL DEFAULT 'released',
  `departed_at` INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX `eidolon_hall_owner_idx` ON `eidolon_hall` (`owner_scope`, `owner_id`, `departed_at`);
