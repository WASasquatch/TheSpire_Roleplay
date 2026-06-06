-- Track who originally created a room (never changes), and who held
-- ownership immediately before the current owner (updated on each
-- ownership change OR on resurrection of an archived room). Surfaced
-- to admins in the room management UI so transfer history is
-- traceable without trawling the audit log.
--
-- Both columns are nullable: system rooms and pre-existing rows
-- backfill to the current ownerId where set, NULL otherwise.

ALTER TABLE `rooms` ADD COLUMN `original_owner_user_id` TEXT REFERENCES `users`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `rooms` ADD COLUMN `last_owner_user_id` TEXT REFERENCES `users`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
-- Backfill: every existing room's history collapses to whatever the
-- current owner is at the moment of this migration. New transfers
-- after this point will move last_owner_user_id; original stays put.
UPDATE `rooms` SET `original_owner_user_id` = `owner_id` WHERE `owner_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `rooms` SET `last_owner_user_id` = `owner_id` WHERE `owner_id` IS NOT NULL;
