-- User-scoped bookmarks on chat messages. Lightweight: a single row per
-- (user, message) pair carrying an optional free-form category string and
-- note. Categories aren't normalized into their own table — they're
-- user-defined tags, and the small dataset doesn't justify the schema
-- weight. The unique index makes re-bookmarking idempotent (UPSERT-style
-- updates re-use the existing row).
--
-- Cascades: dropping the user takes their bookmarks with them; dropping
-- a message via hard-delete (admin sweep) auto-removes orphaned
-- bookmark rows so no dangling references survive. Soft-deletes don't
-- touch this table — the bookmark stays, the modal renders
-- "[message removed]" in place of the body.
CREATE TABLE `bookmarks` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `message_id` text NOT NULL REFERENCES `messages`(`id`) ON DELETE CASCADE,
  `category` text NOT NULL DEFAULT '',
  `note` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookmarks_user_msg_uq` ON `bookmarks` (`user_id`, `message_id`);
--> statement-breakpoint
CREATE INDEX `bookmarks_user_idx` ON `bookmarks` (`user_id`);
