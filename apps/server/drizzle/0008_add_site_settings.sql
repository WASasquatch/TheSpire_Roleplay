CREATE TABLE `site_settings` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`message_retention_ms` integer DEFAULT 0 NOT NULL,
	`session_ttl_ms` integer DEFAULT 2592000000 NOT NULL,
	`default_theme_json` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_by_id` text,
	FOREIGN KEY (`updated_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
