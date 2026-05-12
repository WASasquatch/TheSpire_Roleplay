-- Per-room thread categories. Only meaningful for rooms in nested reply
-- mode where top-level messages anchor persistent threads; admin defines
-- the categories and users pick one when starting a new thread.
--
-- A SET NULL FK on messages.thread_category_id means deleting a category
-- doesn't lose its threads — they fall back to the "Uncategorized" bucket
-- that the client renders for null values.
CREATE TABLE `room_thread_categories` (
  `id` text PRIMARY KEY NOT NULL,
  `room_id` text NOT NULL REFERENCES `rooms`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `sort_order` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
-- Case-insensitive uniqueness per room so "Active Scenes" and
-- "active scenes" can't both exist in the same room and confuse picker
-- UX. The expression-based index lives in the migration because drizzle-
-- kit's typed builder doesn't expose `lower()` partial indexes cleanly.
CREATE UNIQUE INDEX `room_thread_categories_room_name_uq`
  ON `room_thread_categories` (`room_id`, lower(`name`));
--> statement-breakpoint
CREATE INDEX `room_thread_categories_room_idx`
  ON `room_thread_categories` (`room_id`);
--> statement-breakpoint
-- Thread anchor. Only set on top-level messages (replies inherit their
-- parent's category implicitly via the thread the renderer derives).
-- ON DELETE SET NULL preserves message history when a category is
-- removed; the renderer maps null to "Uncategorized".
ALTER TABLE `messages`
  ADD COLUMN `thread_category_id` text
  REFERENCES `room_thread_categories`(`id`) ON DELETE SET NULL;
