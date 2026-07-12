-- Default categories for new rooms.
-- `room_categories.is_default` marks at most one category per server as the
-- landing bucket for newly created rooms (single winner enforced by the
-- console route: flipping it on clears the previous holder in the same
-- write). `room_category_role_defaults` maps a usergroup to a category so
-- rooms created by a holder of that role land there instead — one category
-- per role (usergroup_id is the primary key), highest-sort_order held role
-- wins at creation time (the userlist-badge pick rule). Both FKs cascade,
-- so deleting a category or a role can never leave a dangling default.
-- Applied at room CREATION only; an explicit category choice always wins.
ALTER TABLE `room_categories` ADD COLUMN `is_default` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE `room_category_role_defaults` (
	`usergroup_id` text PRIMARY KEY NOT NULL REFERENCES server_usergroups(id) ON DELETE CASCADE,
	`category_id` text NOT NULL REFERENCES room_categories(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `room_category_role_defaults_category_idx` ON `room_category_role_defaults` (`category_id`);
