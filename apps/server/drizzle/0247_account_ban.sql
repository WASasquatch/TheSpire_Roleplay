-- Account ban columns on users. A ban is a mod action (reason + issuer,
-- optionally timed) that ALSO sets disabled_at so every existing
-- login/chat/visibility gate blocks the account. Unban / expiry clears all.
-- See the rooms.* ban table for the per-room equivalent; this is account-wide.
ALTER TABLE `users` ADD COLUMN `banned_at` INTEGER;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `banned_until` INTEGER;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `ban_reason` TEXT;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `banned_by_id` TEXT;
