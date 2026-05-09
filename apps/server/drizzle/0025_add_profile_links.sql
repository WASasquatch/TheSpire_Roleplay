-- Player-set links surfaced as styled chips on master/OOC and character
-- profiles. Each row is owned by a user; characterId discriminates scope:
--   * character_id IS NULL  → link belongs to the user's master/OOC profile
--   * character_id = <id>   → link belongs to that specific character
--
-- Colors are optional hex strings (#rrggbb). Null = render with theme defaults.

CREATE TABLE `profile_links` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `character_id` text,
  `title` text NOT NULL,
  `url` text NOT NULL,
  `border_color` text,
  `bg_color` text,
  `text_color` text,
  `sort_order` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);--> statement-breakpoint

CREATE INDEX `profile_links_user_idx` ON `profile_links` (`user_id`, `character_id`, `sort_order`);
