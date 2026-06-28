-- Per-account NPCs + NPC post stat snapshots (migration 0267).
--
-- A saved NPC belongs to an ACCOUNT and is reusable in any forum (subject to
-- the forum's `use_npc` grant). An NPC is a name + an optional list of stat
-- lines (JSON [{label,value}]). When a post is voiced as an NPC, its stats
-- are SNAPSHOT onto the message (`messages.npc_stats_json`) so the post still
-- renders its stat block after the saved NPC is edited or deleted.
CREATE TABLE `user_npcs` (
  `id` TEXT PRIMARY KEY,
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `name` TEXT NOT NULL,
  `stats_json` TEXT NOT NULL DEFAULT '[]',
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX `user_npcs_user_idx` ON `user_npcs` (`user_id`, `updated_at`);
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `npc_stats_json` TEXT;
