-- Rename the Standing system to Earning.
--
-- The XP / Currency / Rank pool was originally introduced under the
-- "Standing" name (migrations 0063..0067). User feedback shifted the
-- public framing to "Earning", every user-facing surface (tab label,
-- help copy, slash command, asset folder, etc.) now uses that name.
-- This migration brings the schema into alignment so the codebase
-- stops carrying two names for the same system.
--
-- Renamed in one go: four tables, one site_settings column, and three
-- supporting indexes. Foreign keys, primary keys, and column data are
-- untouched, SQLite's RENAME TO / RENAME COLUMN updates all internal
-- references automatically. Indexes can't be renamed in place, so we
-- drop + recreate them against the renamed tables.

ALTER TABLE `user_standing` RENAME TO `user_earning`;
--> statement-breakpoint
ALTER TABLE `character_standing` RENAME TO `character_earning`;
--> statement-breakpoint
ALTER TABLE `standing_ledger` RENAME TO `earning_ledger`;
--> statement-breakpoint
ALTER TABLE `standing_notifications` RENAME TO `earning_notifications`;
--> statement-breakpoint

ALTER TABLE `site_settings` RENAME COLUMN `standing_config_json` TO `earning_config_json`;
--> statement-breakpoint

DROP INDEX IF EXISTS `standing_ledger_owner_time_idx`;
--> statement-breakpoint
CREATE INDEX `earning_ledger_owner_time_idx`
  ON `earning_ledger` (`scope`, `owner_id`, `created_at`);
--> statement-breakpoint

DROP INDEX IF EXISTS `standing_ledger_reason_idx`;
--> statement-breakpoint
CREATE INDEX `earning_ledger_reason_idx`
  ON `earning_ledger` (`reason`, `created_at`);
--> statement-breakpoint

DROP INDEX IF EXISTS `standing_notifications_user_unread_idx`;
--> statement-breakpoint
CREATE INDEX `earning_notifications_user_unread_idx`
  ON `earning_notifications` (`user_id`, `acknowledged_at`);
