-- Poll posts. A `kind = "poll"` message carries its option list + settings in
-- poll_data_json (question rides body/title); each ballot is a poll_votes row
-- so concurrent voting never read-modify-writes a JSON array. Works in both
-- chat rooms and forum boards off the one message model.
ALTER TABLE `messages` ADD COLUMN `poll_data_json` TEXT;
--> statement-breakpoint
CREATE TABLE `poll_votes` (
  `poll_message_id` TEXT NOT NULL REFERENCES `messages`(`id`) ON DELETE CASCADE,
  `option_id` TEXT NOT NULL,
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`poll_message_id`, `user_id`, `option_id`)
);
--> statement-breakpoint
CREATE INDEX `poll_votes_poll_idx` ON `poll_votes` (`poll_message_id`);
