-- Forums Phase 8: per-user last-visit marker, one row per (user, forum).
-- Drives the catalog rail's "new activity since you last looked" dot:
-- unseen = forum.lastActivityAt > forum_visits.last_visit_at (or no row).
-- Deliberately NOT per-topic read tracking - one timestamp per forum keeps
-- the write path one upsert on modal selection and the read path one join.
CREATE TABLE `forum_visits` (
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `forum_id` text NOT NULL REFERENCES `forums`(`id`) ON DELETE CASCADE,
  `last_visit_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`user_id`, `forum_id`)
);
