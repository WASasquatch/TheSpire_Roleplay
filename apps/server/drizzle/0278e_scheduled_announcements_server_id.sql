-- Servers Lift, Phase 1 (additive): scope discriminator on
-- `scheduled_announcements`. Canonical DDL: plan.md §5.4. §9.3 split — ONE ADD
-- COLUMN per file.
--
-- NULL = a platform-wide scheduled broadcast (master-admin); a server_id scopes
-- the cron to that server's rooms. The NULL-targetRoomId "fan out to EVERY room"
-- behavior becomes "every room in this server" once server_id is set. ON DELETE
-- SET NULL so deleting a server un-scopes the schedule rather than destroying it.
ALTER TABLE `scheduled_announcements` ADD COLUMN `server_id` text REFERENCES `servers`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `scheduled_announcements_server_idx`
  ON `scheduled_announcements` (`server_id`, `enabled`, `next_run_at`);
