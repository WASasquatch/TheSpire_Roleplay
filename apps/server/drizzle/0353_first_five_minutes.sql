-- First-five-minutes retention package.
--
-- users.greeted_at: when the one-time personal greeter (a targeted system
-- message on the account's first room landing) was persisted. NULL = not yet
-- greeted; the write is an atomic claim (UPDATE ... WHERE greeted_at IS NULL)
-- so a multi-tab first connect can only greet once.
--
-- users.first_spoke_at: when the account sent its first-ever public chat
-- message (speech kinds in public, non-forum, non-role-locked rooms). Drives
-- the one-time "X just said their first words" welcome-wagon notification.
--
-- Both columns are BACKFILLED to created_at for every existing account so the
-- deploy never retroactively greets veterans or announces their next message
-- as "first words" (message retention makes an EXISTS-over-messages check
-- unreliable — expired history would misread a veteran as never having
-- spoken). Only accounts registered after this migration carry NULL.
--
-- site_settings.denote_unverified_users: admin toggle (default OFF). When on,
-- accounts whose email_verified_at is NULL wear a subtle "Unverified" chip in
-- the room userlist and on profiles. Legacy accounts were backfilled verified
-- by migration 0257, so flipping this on never stigmatizes pre-existing users.
ALTER TABLE `users` ADD COLUMN `greeted_at` INTEGER;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `first_spoke_at` INTEGER;
--> statement-breakpoint
UPDATE `users` SET `greeted_at` = `created_at`, `first_spoke_at` = `created_at`;
--> statement-breakpoint
ALTER TABLE `site_settings` ADD COLUMN `denote_unverified_users` INTEGER NOT NULL DEFAULT 0;
