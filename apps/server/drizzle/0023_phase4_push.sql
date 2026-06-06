-- Phase 4, Web Push subscriptions + VAPID key persistence.
--   * push_subscriptions  (one row per browser/device a user has opted in)
--   * site_settings.vapid_public_key / vapid_private_key, generated at first
--     boot if missing; persisted so deploys don't churn keys (which would
--     invalidate every existing subscription).

CREATE TABLE `push_subscriptions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `endpoint` text NOT NULL,
  `p256dh_key` text NOT NULL,
  `auth_key` text NOT NULL,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `last_seen_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);--> statement-breakpoint

CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
-- A user can register the same endpoint at most once. If a browser
-- re-subscribes (after the user re-enabled push, e.g.) we upsert.
CREATE UNIQUE INDEX `push_subscriptions_endpoint_uq` ON `push_subscriptions` (`user_id`, `endpoint`);--> statement-breakpoint

ALTER TABLE `site_settings` ADD `vapid_public_key` text;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `vapid_private_key` text;
