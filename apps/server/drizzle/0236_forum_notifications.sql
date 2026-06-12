-- Forums: notification center + per-topic unread + topic watches.
--
-- forum_topic_reads: one row per (user, topic) - the topic shows as
-- unread while its lastActivityAt outruns last_read_at (or no row
-- exists). Upserted when the user opens the topic in the catalog.
CREATE TABLE `forum_topic_reads` (
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `topic_id` text NOT NULL REFERENCES `messages`(`id`) ON DELETE CASCADE,
  `last_read_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`user_id`, `topic_id`)
);

-- forum_topic_watches: explicit subscriptions. Authors auto-watch their
-- own topics; repliers auto-watch what they reply to. Watchers are
-- notified of new replies.
CREATE TABLE `forum_topic_watches` (
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `topic_id` text NOT NULL REFERENCES `messages`(`id`) ON DELETE CASCADE,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`user_id`, `topic_id`)
);

-- forum_notifications: the inbox rows. Display fields (actor name, topic
-- title, snippet) are SNAPSHOTS so the inbox stays readable even after
-- renames; the FK CASCADEs mean a deleted post/topic/forum takes its
-- notifications with it.
CREATE TABLE `forum_notifications` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL,
  `forum_id` text NOT NULL REFERENCES `forums`(`id`) ON DELETE CASCADE,
  `board_room_id` text NOT NULL REFERENCES `rooms`(`id`) ON DELETE CASCADE,
  `topic_id` text NOT NULL REFERENCES `messages`(`id`) ON DELETE CASCADE,
  `message_id` text NOT NULL REFERENCES `messages`(`id`) ON DELETE CASCADE,
  `actor_user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `actor_name` text NOT NULL,
  `topic_title` text NOT NULL,
  `snippet` text NOT NULL DEFAULT '',
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `read_at` integer
);
CREATE INDEX `forum_notifications_user_idx` ON `forum_notifications` (`user_id`, `created_at`);
CREATE INDEX `forum_notifications_unread_idx` ON `forum_notifications` (`user_id`, `read_at`);
