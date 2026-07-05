-- 0314: Bookmarks — display snapshots + archive + survive message deletion.
--
-- Two changes, both additive to how a bookmark reads:
--
-- 1) SNAPSHOT COLUMNS. Today a bookmark carries only (userId, messageId,
--    category, note) and the client re-joins `messages` + `rooms` to render
--    context, so a soft-deleted or hard-deleted message leaves the bookmark
--    blank. We mirror the message reply-snapshot convention
--    (messages.reply_to_display_name / reply_to_body_snippet): freeze the
--    author's display name, body, styling, and room name onto the bookmark
--    row at save time so the saved moment stays readable forever, exactly
--    like chat history survives a rename. All nullable — legacy rows keep
--    working via the live join, new rows fill these in.
--
-- 2) message_id FK: ON DELETE CASCADE -> ON DELETE SET NULL. A bookmark
--    should OUTLIVE the message it points at (that's the whole reason for the
--    snapshots above); cascading the delete would silently erase the user's
--    saved item. SQLite can't ALTER a foreign key, so this is the canonical
--    table-rebuild: copy into __new_bookmarks with the relaxed FK, swap,
--    re-create the unique index + user index.
--
-- The `bookmarks_user_msg_uq` unique(user_id, message_id) is preserved; once
-- message_id can be NULL, SQLite treats each NULL as distinct, so a user could
-- in principle hold two bookmarks whose messages were both later deleted —
-- acceptable (they were distinct rows to begin with).
--
-- 3) One-time backfill of currently-live bookmarks so existing saves get their
--    snapshots too (best-effort join to messages + rooms; deleted-message
--    bookmarks simply stay null-snapshot and fall through to the live path).

CREATE TABLE `__new_bookmarks` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `message_id` text,
  `category` text DEFAULT '' NOT NULL,
  `note` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `snapshot_display_name` text,
  `snapshot_body` text,
  `snapshot_body_html` text,
  `snapshot_color` text,
  `snapshot_cmd_css` text,
  `snapshot_scene_image_url` text,
  `snapshot_avatar_url` text,
  `snapshot_kind` text,
  `snapshot_room_name` text,
  `snapshot_reply_to_id` text,
  `snapshot_character_id` text,
  `snapshot_msg_created_at` integer,
  `snapshot_author_user_id` text,
  `archived_at` integer,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_bookmarks` (`id`, `user_id`, `message_id`, `category`, `note`, `created_at`)
  SELECT `id`, `user_id`, `message_id`, `category`, `note`, `created_at` FROM `bookmarks`;
--> statement-breakpoint
DROP TABLE `bookmarks`;
--> statement-breakpoint
ALTER TABLE `__new_bookmarks` RENAME TO `bookmarks`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `bookmarks_user_msg_uq` ON `bookmarks` (`user_id`, `message_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bookmarks_user_idx` ON `bookmarks` (`user_id`);
--> statement-breakpoint
-- One-time backfill of live bookmarks (deleted-message rows stay null-snapshot).
UPDATE `bookmarks` SET
  `snapshot_display_name` = (SELECT m.`display_name` FROM `messages` m WHERE m.`id` = `bookmarks`.`message_id`),
  `snapshot_body` = (SELECT m.`body` FROM `messages` m WHERE m.`id` = `bookmarks`.`message_id`),
  `snapshot_body_html` = (SELECT m.`body_html` FROM `messages` m WHERE m.`id` = `bookmarks`.`message_id`),
  `snapshot_color` = (SELECT m.`color` FROM `messages` m WHERE m.`id` = `bookmarks`.`message_id`),
  `snapshot_cmd_css` = (SELECT m.`cmd_css` FROM `messages` m WHERE m.`id` = `bookmarks`.`message_id`),
  `snapshot_scene_image_url` = (SELECT m.`scene_image_url` FROM `messages` m WHERE m.`id` = `bookmarks`.`message_id`),
  `snapshot_avatar_url` = (SELECT m.`avatar_url` FROM `messages` m WHERE m.`id` = `bookmarks`.`message_id`),
  `snapshot_kind` = (SELECT m.`kind` FROM `messages` m WHERE m.`id` = `bookmarks`.`message_id`),
  `snapshot_room_name` = (SELECT r.`name` FROM `messages` m JOIN `rooms` r ON r.`id` = m.`room_id` WHERE m.`id` = `bookmarks`.`message_id`),
  `snapshot_reply_to_id` = (SELECT m.`reply_to_id` FROM `messages` m WHERE m.`id` = `bookmarks`.`message_id`),
  `snapshot_character_id` = (SELECT m.`character_id` FROM `messages` m WHERE m.`id` = `bookmarks`.`message_id`),
  `snapshot_msg_created_at` = (SELECT m.`created_at` FROM `messages` m WHERE m.`id` = `bookmarks`.`message_id`),
  `snapshot_author_user_id` = (SELECT m.`user_id` FROM `messages` m WHERE m.`id` = `bookmarks`.`message_id`)
WHERE `message_id` IS NOT NULL
  AND EXISTS (SELECT 1 FROM `messages` m WHERE m.`id` = `bookmarks`.`message_id`);
