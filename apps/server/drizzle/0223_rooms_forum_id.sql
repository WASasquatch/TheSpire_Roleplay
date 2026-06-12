-- Forums Phase 0: rooms.forum_id — non-null marks the room as a BOARD
-- inside that forum. The chat room list filters on forum_id (NOT on
-- reply_mode, so standalone nested rooms a user made via /replymode stay
-- listed); boards render inside the Forums Catalog instead. ON DELETE SET
-- NULL: forum deletion archives its boards first, so an orphaned row is
-- already archived and never resurfaces in the chat list.
ALTER TABLE `rooms` ADD COLUMN `forum_id` text REFERENCES `forums`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `rooms_forum_idx` ON `rooms` (`forum_id`);
