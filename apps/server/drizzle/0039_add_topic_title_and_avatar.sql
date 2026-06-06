-- Forum-style threading for nested-mode rooms. Two columns added to the
-- messages table to support the topic+reply model that those rooms now
-- present:
--
--   `title`     , non-null on top-level "topic" posts (the master thread
--                  the replies live under). Null on replies and on every
--                  message in flat-mode rooms.
--   `avatar_url`, snapshot of the author's avatar at send time so a
--                  later rename or character delete doesn't blank out
--                  past forum posts. The forum renderer uses this for
--                  the avatar slot beside each post; flat-mode chat
--                  ignores it.
--
-- Both columns are nullable; existing rows backfill as NULL which the
-- renderer handles (titles fall back to a body excerpt, avatars fall
-- back to an initials chip).
ALTER TABLE `messages` ADD COLUMN `title` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `avatar_url` text;
