-- Per-user-targeted system notifications (migration 0252).
--
-- `target_user_id` scopes a system-kind message to a single recipient:
-- NULL keeps the old behaviour (visible to everyone in the room — presence,
-- /announce, game lines), while a non-NULL value marks a TARGETED line (a
-- watched friend coming online, a friend request, a followed story's
-- publish, the per-room "[Description]:" line). The room-backlog reads
-- (roomVisibilityWhere) show a targeted row ONLY to its recipient, so these
-- notifications can persist across a refetch without leaking to the room.
ALTER TABLE `messages` ADD COLUMN `target_user_id` TEXT REFERENCES `users`(`id`) ON DELETE CASCADE;
--> statement-breakpoint
-- Backs the `target_user_id = :viewer` clause in the backlog filter.
CREATE INDEX IF NOT EXISTS `messages_target_user_idx` ON `messages` (`target_user_id`);
