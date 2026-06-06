-- Phase 2 feature batch:
--   * Mood tags        (users.current_mood, messages.mood_snapshot)
--   * /npc command     (rooms.npc_disabled, messages.npc_voiced_by)
--   * Edit/delete grace (messages.edited_at, messages.deleted_at)
--   * /scene message kind: no DDL, `kind` is enforced in code, not at the
--     SQLite layer; the existing TEXT column accepts the new value.
--   * Multi-portrait gallery (new character_portraits table).

ALTER TABLE `users` ADD `current_mood` text;--> statement-breakpoint

ALTER TABLE `rooms` ADD `npc_disabled` integer NOT NULL DEFAULT 0;--> statement-breakpoint

ALTER TABLE `messages` ADD `mood_snapshot` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `npc_voiced_by` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `edited_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `deleted_at` integer;--> statement-breakpoint

CREATE TABLE `character_portraits` (
  `id` text PRIMARY KEY NOT NULL,
  `character_id` text NOT NULL,
  `url` text NOT NULL,
  `label` text,
  `sort_order` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);--> statement-breakpoint

CREATE INDEX `character_portraits_char_idx` ON `character_portraits` (`character_id`, `sort_order`);
