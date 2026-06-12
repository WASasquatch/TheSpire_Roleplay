-- Forums Revamp, Phase 0 (plan.md): the `forums` container table.
-- A forum is a user- or site-owned container ABOVE rooms; a room whose
-- forum_id is set (0223) is a "board" inside it. Topics/replies/stickies/
-- locks stay on messages — no message-table changes anywhere in this
-- feature. Slug is globally unique (share URLs `/f/<slug>`), immutable in
-- v1. `visibility` is public-only for now; the column exists so a future
-- "hidden" tier is a flip, not a migration.
CREATE TABLE `forums` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `tagline` text,
  `description_html` text,
  `owner_user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `is_system` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL DEFAULT 'active',
  `visibility` text NOT NULL DEFAULT 'public',
  `posting_mode` text NOT NULL DEFAULT 'open',
  `theme_json` text,
  `logo_url` text,
  `banner_image_url` text,
  `linked_world_id` text REFERENCES `worlds`(`id`) ON DELETE SET NULL,
  `board_order_json` text NOT NULL DEFAULT '[]',
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forums_slug_uq` ON `forums` (lower(`slug`));
--> statement-breakpoint
CREATE INDEX `forums_owner_idx` ON `forums` (`owner_user_id`);
--> statement-breakpoint
CREATE INDEX `forums_status_idx` ON `forums` (`status`);
