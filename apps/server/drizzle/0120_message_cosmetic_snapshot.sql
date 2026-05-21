-- Snapshot the author's inline-avatar and border state onto each
-- message at send time. Previously the chat renderer relied on the
-- LIVE occupant row to decide whether to paint an author's inline
-- avatar — meaning a viewer scrolling back through messages from
-- someone who has since logged out saw no inline avatar, even though
-- the message row already carried the author's avatarUrl snapshot.
--
-- These two columns mirror the existing avatarUrl / rankKey / tier
-- snapshot pattern: the renderer can fall back to the message's own
-- frozen state when the sender's occupant row is gone.
--
-- Defaults: both null/false so historical rows render as "no inline
-- avatar" (the safe default — those messages were sent before the
-- snapshot existed and we can't reconstruct intent).

ALTER TABLE `messages` ADD COLUMN `sender_inline_avatar_enabled` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE `messages` ADD COLUMN `sender_selected_border_rank_key` TEXT;
