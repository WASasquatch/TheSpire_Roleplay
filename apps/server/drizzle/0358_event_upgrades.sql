-- Event upgrades: occurrence-aware reminders, message links, external links.
-- `reminder_fired_for` stamps the occurrence start (ms epoch) the opt-in
-- reminder last fired for, so a recurring event can remind once per
-- occurrence while plain events keep the `reminder_fired_at` once-only guard.
-- `linked_message_id` holds a `<roomId>:<messageId>` pair with NO FK on
-- purpose: chat messages prune on retention, and a dead link is handled at
-- click time by the jump-to-message flow. `external_url` is an https-only
-- destination validated at write time.
ALTER TABLE `server_events` ADD COLUMN `reminder_fired_for` integer;
--> statement-breakpoint
ALTER TABLE `server_events` ADD COLUMN `linked_message_id` text;
--> statement-breakpoint
ALTER TABLE `server_events` ADD COLUMN `external_url` text;
