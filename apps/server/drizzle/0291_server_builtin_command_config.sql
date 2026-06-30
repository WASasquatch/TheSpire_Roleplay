-- Admin Partition: per-server social-game (built-in command) config. The global
-- `builtin_command_config` (PK = command_name) can't hold per-server rows, so
-- this is a sibling override table keyed by (server_id, command_name). The
-- runtime read order is: this server's override → the legacy global default →
-- the code default. Each server tunes its own game rewards/durations in its
-- Server Admin → Commands & Titles tab.
CREATE TABLE `server_builtin_command_config` (
  `server_id` text NOT NULL REFERENCES `servers`(`id`) ON DELETE CASCADE,
  `command_name` text NOT NULL,
  `reward_xp` integer NOT NULL DEFAULT 0,
  `reward_currency` integer NOT NULL DEFAULT 0,
  `reward_item_key` text REFERENCES `items`(`key`) ON DELETE SET NULL,
  `reward_item_count` integer NOT NULL DEFAULT 0,
  `duration_ms` integer,
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  PRIMARY KEY (`server_id`, `command_name`)
);
--> statement-breakpoint
-- Carry the home server's existing tuned games into its per-server config so
-- nothing resets and The Spire's config becomes editable in its own console.
INSERT OR IGNORE INTO `server_builtin_command_config`
  (`server_id`, `command_name`, `reward_xp`, `reward_currency`, `reward_item_key`, `reward_item_count`, `duration_ms`, `updated_at`, `updated_by_user_id`)
SELECT 'server_spire_system', `command_name`, `reward_xp`, `reward_currency`, `reward_item_key`, `reward_item_count`, `duration_ms`,
  COALESCE(`updated_at`, unixepoch() * 1000), `updated_by_user_id`
FROM `builtin_command_config`;
