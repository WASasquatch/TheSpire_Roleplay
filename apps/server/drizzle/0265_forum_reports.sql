-- Forum report queue (migration 0265).
--
-- A forum-scoped report: a member flags a topic or post to the forum's
-- owner + mods who hold the `handle_reports` grant. Distinct from the
-- site-wide `reports` table (which routes chat-message reports to SITE
-- staff) — these stay inside the forum and never reach site moderation.
--
-- `message_id` is the reported post; `topic_id` snapshots its top-level
-- topic and `board_room_id` the board, so the queue can deep-link even
-- after edits. Status: open → resolved | dismissed.
CREATE TABLE `forum_reports` (
  `id` TEXT PRIMARY KEY,
  `forum_id` TEXT NOT NULL REFERENCES `forums`(`id`) ON DELETE CASCADE,
  `message_id` TEXT NOT NULL REFERENCES `messages`(`id`) ON DELETE CASCADE,
  `board_room_id` TEXT REFERENCES `rooms`(`id`) ON DELETE SET NULL,
  `topic_id` TEXT REFERENCES `messages`(`id`) ON DELETE SET NULL,
  `reporter_user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `reason` TEXT NOT NULL,
  `status` TEXT NOT NULL DEFAULT 'open',
  `resolved_by_user_id` TEXT REFERENCES `users`(`id`) ON DELETE SET NULL,
  `resolution_note` TEXT,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `resolved_at` INTEGER
);
--> statement-breakpoint
-- Queue read: open reports per forum, newest first.
CREATE INDEX `forum_reports_forum_idx` ON `forum_reports` (`forum_id`, `status`, `created_at`);
--> statement-breakpoint
-- One OPEN report per (forum, message, reporter) — re-reporting the same
-- post is a no-op while the first is still open (anti-spam).
CREATE UNIQUE INDEX `forum_reports_one_open_uq`
  ON `forum_reports` (`forum_id`, `message_id`, `reporter_user_id`)
  WHERE `status` = 'open';
