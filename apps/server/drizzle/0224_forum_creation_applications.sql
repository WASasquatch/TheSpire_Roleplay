-- Forums Phase 0: forum-creation applications ("Create your Forum").
-- Reviewed by SITE staff (`review_forum_applications`), not forum owners.
-- Mirrors world_applications: terminal rows (approved/rejected/withdrawn)
-- stay as audit trail; the partial unique index enforces at most one
-- PENDING application per applicant without blocking a re-apply after a
-- rejection (the route also enforces the 7-day cooldown).
CREATE TABLE `forum_creation_applications` (
  `id` text PRIMARY KEY NOT NULL,
  `applicant_user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `requested_name` text NOT NULL,
  `requested_slug` text NOT NULL,
  `purpose` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `submitted_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `reviewed_at` integer,
  `reviewed_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `review_note` text
);
--> statement-breakpoint
CREATE INDEX `forum_creation_apps_status_idx`
  ON `forum_creation_applications` (`status`, `submitted_at`);
--> statement-breakpoint
CREATE INDEX `forum_creation_apps_applicant_idx`
  ON `forum_creation_applications` (`applicant_user_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `forum_creation_apps_one_pending_uq`
  ON `forum_creation_applications` (`applicant_user_id`)
  WHERE `status` = 'pending';
