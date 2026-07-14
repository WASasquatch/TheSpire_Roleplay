-- World maps: interactive maps attached to a world, plus their markers.
-- `world_maps.image_url` is an external https URL while image_kind =
-- 'external' ('upload' is reserved for the admin-gated upload mode).
-- `width`/`height` are natural-dimension hints measured client-side and
-- PATCHed back by editors. Marker `x`/`y` are REAL fractions 0..1 of the
-- image's natural dimensions so positions are resolution-independent.
-- `entry_kind`/`entry_slug` soft-link a marker to a knowledge-base entry
-- (route-validated, never a hard FK — @kind:slug tokens don't dangle).
-- `event_id` links a marker to a server event (SET NULL when the event
-- is deleted); `is_secret` markers are stripped server-side for viewers
-- who can't edit the world. Slug uniqueness is world-scoped via the
-- lower() expression index (migration-only; drizzle can't model it).
CREATE TABLE IF NOT EXISTS `world_maps` (
  `id` text PRIMARY KEY NOT NULL,
  `world_id` text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `image_url` text NOT NULL,
  `image_kind` text NOT NULL DEFAULT 'external',
  `width` integer,
  `height` integer,
  `sort_order` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `world_maps_world_slug_uq` ON `world_maps` (`world_id`, lower(`slug`));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `world_maps_order_idx` ON `world_maps` (`world_id`, `sort_order`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `world_map_markers` (
  `id` text PRIMARY KEY NOT NULL,
  `map_id` text NOT NULL REFERENCES world_maps(id) ON DELETE CASCADE,
  `kind` text NOT NULL DEFAULT 'poi',
  `label` text NOT NULL,
  `x` real NOT NULL DEFAULT 0.5,
  `y` real NOT NULL DEFAULT 0.5,
  `color` text,
  `icon` text,
  `size` text NOT NULL DEFAULT 'md',
  `scale_mode` text NOT NULL DEFAULT 'fixed',
  `min_zoom` real,
  `max_zoom` real,
  `entry_kind` text,
  `entry_slug` text,
  `event_id` text REFERENCES server_events(id) ON DELETE SET NULL,
  `body` text NOT NULL DEFAULT '',
  `is_secret` integer NOT NULL DEFAULT 0,
  `sort_order` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `world_map_markers_map_idx` ON `world_map_markers` (`map_id`, `sort_order`);
