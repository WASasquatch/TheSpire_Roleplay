-- Admin-configurable system limits, all stored on the singleton site_settings
-- row. Defaults match what was previously hard-coded so the upgrade is a
-- no-op for existing deployments.
ALTER TABLE `site_settings` ADD `max_characters_per_user` integer DEFAULT 100 NOT NULL;
--> statement-breakpoint
ALTER TABLE `site_settings` ADD `max_accounts_per_email` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `site_settings` ADD `max_rooms_per_owner` integer DEFAULT 25 NOT NULL;
--> statement-breakpoint
ALTER TABLE `site_settings` ADD `max_message_length` integer DEFAULT 4000 NOT NULL;
--> statement-breakpoint
ALTER TABLE `site_settings` ADD `max_bio_length` integer DEFAULT 50000 NOT NULL;
--> statement-breakpoint
ALTER TABLE `site_settings` ADD `registration_open` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- Replace the unique email index with a non-unique one. The
-- max_accounts_per_email setting is enforced in code at registration time so
-- admins can lift the cap to 2+ without a follow-up migration.
DROP INDEX IF EXISTS `users_email_uq`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `users_email_idx` ON `users` (lower(`email`));
