-- Forums Phase 0: per-forum bans, owner-issued (site staff with
-- manage_any_forum can lift). Scoped STRICTLY to the forum's boards — a
-- forum ban never affects the rest of the site. `until` NULL = permanent.
-- Enforced at board join, topic post/reply, and membership-application
-- submit (via forumAuthority).
CREATE TABLE `forum_bans` (
  `forum_id` text NOT NULL REFERENCES `forums`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `until` integer,
  `reason` text,
  `issued_by_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`forum_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `forum_bans_user_idx` ON `forum_bans` (`user_id`);
