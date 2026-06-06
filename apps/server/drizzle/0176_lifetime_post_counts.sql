-- Lifetime post counters on users + characters.
--
-- Before this migration, profile-view counts (chat messages, forum
-- topics, forum replies) were computed by COUNT(*) over the messages
-- table. That meant the visible number drifted DOWN every time:
--   * a message hit the retention sweep,
--   * an admin or owner soft-deleted a row,
--   * a room got deleted (cascade removed its messages).
--
-- Per the user's request these counters should be lifetime statistics:
-- "added to with every post." So we add six denormalized counters
-- (three per identity scope: users for master/OOC + every character
-- they own, characters for the per-character split) and bump them at
-- message-insert time. Deletions no longer subtract.
--
-- Backfill: seed each counter from the surviving rows in `messages`
-- using the same classification the profile view used. This is an
-- UNDERESTIMATE versus true all-time because retention-purged and
-- hard-deleted messages are gone. Going forward, every new insert
-- increments the counter exactly once before any subsequent delete
-- can erase it, so the lifetime semantic holds from this point on.
--
-- Classification (mirrors `computeProfileMetrics` in
-- apps/server/src/commands/builtins/profile.ts):
--   * chat   = flat-mode room, kind in chat-shape set, no parent
--   * topic  = nested-mode room, no parent, title IS NOT NULL
--   * reply  = nested-mode room, parent IS NOT NULL
-- Whispers, system, cmd, announce rows are intentionally excluded.

ALTER TABLE `users` ADD COLUMN `lifetime_chat_messages` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `lifetime_forum_topics` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `lifetime_forum_replies` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE `characters` ADD COLUMN `lifetime_chat_messages` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `characters` ADD COLUMN `lifetime_forum_topics` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `characters` ADD COLUMN `lifetime_forum_replies` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Users backfill. Counts include soft-deleted rows on purpose:
-- "lifetime" should retain the post even when it's later hidden
-- by moderation, matching the post-this-migration insert behavior
-- where the counter is bumped before any later delete can run.
UPDATE `users` SET
  `lifetime_chat_messages` = (
    SELECT COUNT(*) FROM `messages`
    JOIN `rooms` ON `rooms`.`id` = `messages`.`room_id`
    WHERE `messages`.`user_id` = `users`.`id`
      AND `messages`.`reply_to_id` IS NULL
      AND `rooms`.`reply_mode` = 'flat'
      AND `messages`.`kind` IN ('say','me','ooc','roll','scene','npc')
  ),
  `lifetime_forum_topics` = (
    SELECT COUNT(*) FROM `messages`
    JOIN `rooms` ON `rooms`.`id` = `messages`.`room_id`
    WHERE `messages`.`user_id` = `users`.`id`
      AND `messages`.`reply_to_id` IS NULL
      AND `rooms`.`reply_mode` = 'nested'
      AND `messages`.`title` IS NOT NULL
  ),
  `lifetime_forum_replies` = (
    SELECT COUNT(*) FROM `messages`
    JOIN `rooms` ON `rooms`.`id` = `messages`.`room_id`
    WHERE `messages`.`user_id` = `users`.`id`
      AND `messages`.`reply_to_id` IS NOT NULL
      AND `rooms`.`reply_mode` = 'nested'
  );
--> statement-breakpoint

-- Characters backfill, same shape, scoped to messages tagged with
-- the character_id (so a master/OOC message under no character
-- doesn't increment any character's counter).
UPDATE `characters` SET
  `lifetime_chat_messages` = (
    SELECT COUNT(*) FROM `messages`
    JOIN `rooms` ON `rooms`.`id` = `messages`.`room_id`
    WHERE `messages`.`character_id` = `characters`.`id`
      AND `messages`.`reply_to_id` IS NULL
      AND `rooms`.`reply_mode` = 'flat'
      AND `messages`.`kind` IN ('say','me','ooc','roll','scene','npc')
  ),
  `lifetime_forum_topics` = (
    SELECT COUNT(*) FROM `messages`
    JOIN `rooms` ON `rooms`.`id` = `messages`.`room_id`
    WHERE `messages`.`character_id` = `characters`.`id`
      AND `messages`.`reply_to_id` IS NULL
      AND `rooms`.`reply_mode` = 'nested'
      AND `messages`.`title` IS NOT NULL
  ),
  `lifetime_forum_replies` = (
    SELECT COUNT(*) FROM `messages`
    JOIN `rooms` ON `rooms`.`id` = `messages`.`room_id`
    WHERE `messages`.`character_id` = `characters`.`id`
      AND `messages`.`reply_to_id` IS NOT NULL
      AND `rooms`.`reply_mode` = 'nested'
  );
