-- Forums Phase 0: forum membership/roles + membership applications.
--
-- forum_members holds the relational roles (NOT sitewide permission keys,
-- same philosophy as room owner/mod):
--   owner  - exactly one per forum (the approved applicant)
--   mod    - owner-assigned; topic-level powers only (no category
--            management, never touches owner-authored content)
--   member - approved applicant on posting_mode='application' forums
-- Open-posting forums don't need member rows to post.
CREATE TABLE `forum_members` (
  `forum_id` text NOT NULL REFERENCES `forums`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `role` text NOT NULL DEFAULT 'member',
  `joined_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`forum_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `forum_members_user_idx` ON `forum_members` (`user_id`);
--> statement-breakpoint

-- Membership applications, reviewed by the forum owner + forum mods in
-- the forum settings page (world_applications lifecycle; one PENDING per
-- (forum, applicant) via partial unique index).
CREATE TABLE `forum_membership_applications` (
  `id` text PRIMARY KEY NOT NULL,
  `forum_id` text NOT NULL REFERENCES `forums`(`id`) ON DELETE CASCADE,
  `applicant_user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `answer` text,
  `status` text NOT NULL DEFAULT 'pending',
  `submitted_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `reviewed_at` integer,
  `reviewed_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `review_note` text
);
--> statement-breakpoint
CREATE INDEX `forum_membership_apps_forum_idx`
  ON `forum_membership_applications` (`forum_id`, `status`);
--> statement-breakpoint
CREATE INDEX `forum_membership_apps_applicant_idx`
  ON `forum_membership_applications` (`applicant_user_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `forum_membership_apps_one_pending_uq`
  ON `forum_membership_applications` (`forum_id`, `applicant_user_id`)
  WHERE `status` = 'pending';
