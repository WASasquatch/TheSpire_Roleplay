-- Granular forum-moderator permissions (migration 0264).
--
-- Forum mods used to have a fixed power set (lock/sticky/move/edit/delete +
-- review apps). Now the owner grants each mod an explicit subset, stored as
-- a JSON array of permission keys (see FORUM_MOD_PERMISSIONS in shared). The
-- owner + manage_any_forum staff implicitly hold ALL keys and never read
-- this column; a `member` holds none.
ALTER TABLE `forum_members` ADD COLUMN `permissions_json` TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
-- Backfill existing mods to the classic fixed powerset they had before this
-- change, so nobody silently loses moderation powers on deploy. (Sorted to
-- match the shared serializer's canonical output.)
UPDATE `forum_members`
SET `permissions_json` = '["delete_posts","edit_posts","lock_topics","move_topics","pin_topics","review_applications"]'
WHERE `role` = 'mod';
