-- Worldbuilding system. Three tables:
--
--   * worlds              - top-level container owned by a user. Visibility:
--                           private (owner only), public (anyone with link),
--                           open (catalog-listed + linkable to others' rooms).
--   * world_pages         - hierarchical pages inside a world. parent_page_id
--                           builds the tree; depth cap of 10 enforced in code.
--   * room_world_links    - one world per room. Linked by room owner / mod /
--                           admin. Surfaces a banner above the chat topic.

CREATE TABLE `worlds` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_user_id` text NOT NULL,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `visibility` text NOT NULL DEFAULT 'private',
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);--> statement-breakpoint

CREATE UNIQUE INDEX `worlds_owner_slug_uq` ON `worlds` (`owner_user_id`, lower(`slug`));--> statement-breakpoint
CREATE INDEX `worlds_visibility_idx` ON `worlds` (`visibility`, `updated_at`);--> statement-breakpoint

CREATE TABLE `world_pages` (
  `id` text PRIMARY KEY NOT NULL,
  `world_id` text NOT NULL,
  `parent_page_id` text,
  `slug` text NOT NULL,
  `title` text NOT NULL,
  `body_html` text NOT NULL DEFAULT '',
  `sort_order` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (`parent_page_id`) REFERENCES `world_pages`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);--> statement-breakpoint

CREATE INDEX `world_pages_tree_idx` ON `world_pages` (`world_id`, `parent_page_id`, `sort_order`);--> statement-breakpoint
CREATE INDEX `world_pages_slug_idx` ON `world_pages` (`world_id`, lower(`slug`));--> statement-breakpoint

CREATE TABLE `room_world_links` (
  `room_id` text PRIMARY KEY NOT NULL,
  `world_id` text NOT NULL,
  `linked_by_user_id` text,
  `linked_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (`linked_by_user_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL
);--> statement-breakpoint

CREATE INDEX `room_world_links_world_idx` ON `room_world_links` (`world_id`);
