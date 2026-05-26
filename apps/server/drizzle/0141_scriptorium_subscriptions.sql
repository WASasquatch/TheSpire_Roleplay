-- 0141_scriptorium_subscriptions.sql
--
-- Phase 7: per-reader story subscriptions. One row per (story, user)
-- with an opt-in push flag. When a chapter publishes, every subscriber
-- gets:
--   - an in-app system notification (server-emitted socket event,
--     surfaced as a one-line system message in the reader's current
--     room — mirrors the friend-online pattern)
--   - an optional web-push notification if push_enabled = 1
--
-- Author cannot see WHO is subscribed; only the rollup count.

CREATE TABLE IF NOT EXISTS `story_subscriptions` (
  `story_id`        TEXT NOT NULL REFERENCES `stories`(`id`) ON DELETE CASCADE,
  `user_id`         TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `push_enabled`    INTEGER NOT NULL DEFAULT 0,
  `subscribed_at`   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`story_id`, `user_id`)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `story_subscriptions_user_idx`
  ON `story_subscriptions` (`user_id`, `subscribed_at`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `story_subscriptions_story_idx`
  ON `story_subscriptions` (`story_id`);
