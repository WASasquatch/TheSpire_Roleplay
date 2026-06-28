-- Forum topic prefixes / tags (migration 0266).
--
-- Owner-defined labels (e.g. [Guide], [Question], [Event]) shown as colored
-- chips on a forum's topic cards and filterable in the board view. The owner
-- curates the catalog (manage_prefixes); a topic carries at most one prefix
-- via `messages.prefix_id`. Scoped per forum.
CREATE TABLE `forum_prefixes` (
  `id` TEXT PRIMARY KEY,
  `forum_id` TEXT NOT NULL REFERENCES `forums`(`id`) ON DELETE CASCADE,
  `label` TEXT NOT NULL,
  `color` TEXT NOT NULL DEFAULT '#888888',
  `sort_order` INTEGER NOT NULL DEFAULT 0,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX `forum_prefixes_forum_idx` ON `forum_prefixes` (`forum_id`, `sort_order`);
--> statement-breakpoint
-- A topic's assigned prefix. NULL = none. Deleting a prefix clears it off its
-- topics (SET NULL) rather than deleting the topics.
ALTER TABLE `messages` ADD COLUMN `prefix_id` TEXT REFERENCES `forum_prefixes`(`id`) ON DELETE SET NULL;
