-- Forums: per-section "members only" gating. A board (room with a forumId)
-- or a thread category can be marked private so only the forum's owner, mods,
-- and members may read it. Logged-out guests AND logged-in non-members are
-- blocked even when the forum has public_browsing on; the section still LISTS
-- (shown-but-locked) but its contents are withheld. Off by default.
ALTER TABLE `rooms` ADD COLUMN `forum_members_only` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `room_thread_categories` ADD COLUMN `members_only` INTEGER NOT NULL DEFAULT 0;
