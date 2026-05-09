-- Phase 3 feature batch:
--   * Audit log    (audit_log table)
--   * Reporting    (reports table)
--   * Watch list   (watches table)
--   * Trust levels — `users.role` is a TEXT column with enum constraint
--                    enforced in code, not the DB layer; widening the union
--                    in schema.ts is enough. No DDL needed.

CREATE TABLE `audit_log` (
  `id` text PRIMARY KEY NOT NULL,
  `actor_user_id` text NOT NULL,
  `action` text NOT NULL,
  `target_user_id` text,
  `target_room_id` text,
  `target_message_id` text,
  `reason` text,
  `metadata_json` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL,
  FOREIGN KEY (`target_room_id`) REFERENCES `rooms`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL,
  FOREIGN KEY (`target_message_id`) REFERENCES `messages`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL
);--> statement-breakpoint

CREATE INDEX `audit_log_created_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor_user_id`, `created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_target_idx` ON `audit_log` (`target_user_id`, `created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_action_idx` ON `audit_log` (`action`, `created_at`);--> statement-breakpoint

CREATE TABLE `reports` (
  `id` text PRIMARY KEY NOT NULL,
  `reporter_user_id` text NOT NULL,
  `message_id` text NOT NULL,
  `room_id` text NOT NULL,
  `reason` text,
  `status` text NOT NULL DEFAULT 'open',
  `resolved_by_id` text,
  `resolved_at` integer,
  `resolution_note` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (`reporter_user_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (`resolved_by_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL
);--> statement-breakpoint

CREATE INDEX `reports_status_idx` ON `reports` (`status`, `created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `reports_reporter_msg_uq` ON `reports` (`reporter_user_id`, `message_id`);--> statement-breakpoint

CREATE TABLE `watches` (
  `watcher_user_id` text NOT NULL,
  `watched_user_id` text NOT NULL,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`watcher_user_id`, `watched_user_id`),
  FOREIGN KEY (`watcher_user_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (`watched_user_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);--> statement-breakpoint

CREATE INDEX `watches_watched_idx` ON `watches` (`watched_user_id`);
