-- Room categories + manual room ordering.
-- `room_categories` groups a server's rooms into named rail sections
-- (Discord-like table of contents). `rooms.category_id` files a room into a
-- category (SET NULL on category delete, so removing a category never removes
-- rooms — they fall back to the headerless uncategorized bucket).
-- `rooms.sort_order` is the manual within-bucket position; default 0 keeps
-- every existing room in today's alphabetical order.
CREATE TABLE `room_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
	`name` text NOT NULL,
	`icon` text,
	`sort_order` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX `room_categories_server_idx` ON `room_categories` (`server_id`);
--> statement-breakpoint
ALTER TABLE `rooms` ADD COLUMN `category_id` text REFERENCES room_categories(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `rooms` ADD COLUMN `sort_order` integer NOT NULL DEFAULT 0;
