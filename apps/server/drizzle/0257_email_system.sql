-- Email system foundation (migration 0257): password reset, optional
-- email verification, and the admin emailer (single send + throttled
-- broadcast). Sending itself goes through Brevo (see lib/mailer.ts).

-- 1. Per-account verification.
ALTER TABLE `users` ADD COLUMN `email_verified_at` INTEGER;
--> statement-breakpoint
-- Grandfather every EXISTING account as verified (set to their createdAt)
-- so turning verification on later never nags or blocks current members.
UPDATE `users` SET `email_verified_at` = `created_at` WHERE `email_verified_at` IS NULL;
--> statement-breakpoint

-- 2. Site settings: verification toggle + mode, and the broadcast daily cap.
ALTER TABLE `site_settings` ADD COLUMN `email_verification_enabled` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `site_settings` ADD COLUMN `email_verification_mode` TEXT NOT NULL DEFAULT 'nudge';
--> statement-breakpoint
ALTER TABLE `site_settings` ADD COLUMN `email_daily_cap` INTEGER NOT NULL DEFAULT 300;
--> statement-breakpoint

-- 3. Single-use transactional tokens (reset + verify). Token HASH only.
CREATE TABLE `email_tokens` (
  `id` TEXT PRIMARY KEY,
  `purpose` TEXT NOT NULL,
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `token_hash` TEXT NOT NULL,
  `expires_at` INTEGER NOT NULL,
  `used_at` INTEGER,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX `email_tokens_hash_idx` ON `email_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `email_tokens_user_purpose_idx` ON `email_tokens` (`user_id`, `purpose`);
--> statement-breakpoint

-- 4. Admin broadcast campaigns + the throttled per-recipient outbox.
CREATE TABLE `email_campaigns` (
  `id` TEXT PRIMARY KEY,
  `subject` TEXT NOT NULL,
  `body_html` TEXT NOT NULL,
  `category` TEXT NOT NULL DEFAULT 'announcements',
  `scheduled_at` INTEGER,
  `status` TEXT NOT NULL DEFAULT 'sending',
  `total` INTEGER NOT NULL DEFAULT 0,
  `sent_count` INTEGER NOT NULL DEFAULT 0,
  `failed_count` INTEGER NOT NULL DEFAULT 0,
  `created_by_user_id` TEXT REFERENCES `users`(`id`) ON DELETE SET NULL,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX `email_campaigns_status_idx` ON `email_campaigns` (`status`, `created_at`);
--> statement-breakpoint
CREATE TABLE `email_outbox` (
  `id` TEXT PRIMARY KEY,
  `campaign_id` TEXT NOT NULL REFERENCES `email_campaigns`(`id`) ON DELETE CASCADE,
  `user_id` TEXT REFERENCES `users`(`id`) ON DELETE SET NULL,
  `email` TEXT NOT NULL,
  `status` TEXT NOT NULL DEFAULT 'pending',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `error` TEXT,
  `sent_at` INTEGER,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX `email_outbox_status_idx` ON `email_outbox` (`status`);
--> statement-breakpoint
CREATE INDEX `email_outbox_campaign_idx` ON `email_outbox` (`campaign_id`);
--> statement-breakpoint
CREATE INDEX `email_outbox_sent_at_idx` ON `email_outbox` (`sent_at`);
--> statement-breakpoint

-- 4b. Per-category unsubscribes. A row = opted out of that broadcast
-- category; absence = subscribed. The footer link drops only its category.
CREATE TABLE `email_unsubscribes` (
  `id` TEXT PRIMARY KEY,
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `category` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_unsub_user_cat_uq` ON `email_unsubscribes` (`user_id`, `category`);
--> statement-breakpoint

-- 5. Permissions: see the Email admin tab + send mail. Granted to admin and
-- masteradmin (masteradmin bypasses, but seed for clarity/adjustability).
INSERT OR IGNORE INTO `role_permission_grants` (`role`, `permission_key`) VALUES
  ('admin', 'view_admin_email'),
  ('admin', 'send_admin_email'),
  ('masteradmin', 'view_admin_email'),
  ('masteradmin', 'send_admin_email');
