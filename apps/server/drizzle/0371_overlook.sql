-- Overlook: an infinite sketch canvas (Excalidraw scene) attached to a room
-- or a world. Nodes, arrows and freehand notes that map out places, factions
-- and how they connect; elements can carry a `{room:slug}` / `{world:slug}`
-- chip token as their link so a node jumps straight to what it represents.
--
-- ONE table for both scopes because the payload and the editor-grant logic
-- are identical; `room_id` / `world_id` discriminate and exactly one is
-- non-null (CHECK-enforced). Two partial unique indexes give each scope at
-- most one canvas without a composite key that would need a sentinel value.
--
-- `scene_json` is the whole Excalidraw scene ({elements, appState, files}).
-- It is opaque to the server EXCEPT for two validated things: the element
-- count (denormalized into `element_count` so "is this canvas blank?" can be
-- answered without shipping the scene, mirroring how `maps?` gates the world
-- Map tab) and the `files` map, which is rejected server-side when it holds
-- base64 data URLs and `site_settings.overlook_uploads_enabled` is off.
--
-- `version` is an optimistic-concurrency counter, not a history: a PUT that
-- carries a stale version is refused with 409 so two editors can't silently
-- clobber each other. There is no realtime merge; the editor set is small
-- and privileged by design.
CREATE TABLE IF NOT EXISTS `overlooks` (
  `id` text PRIMARY KEY NOT NULL,
  `room_id` text REFERENCES rooms(id) ON DELETE CASCADE,
  `world_id` text REFERENCES worlds(id) ON DELETE CASCADE,
  `scene_json` text NOT NULL DEFAULT '{"elements":[],"appState":{},"files":{}}',
  `element_count` integer NOT NULL DEFAULT 0,
  `version` integer NOT NULL DEFAULT 0,
  `updated_by_user_id` text REFERENCES users(id) ON DELETE SET NULL,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  CHECK ((`room_id` IS NULL) <> (`world_id` IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `overlooks_room_uq` ON `overlooks` (`room_id`) WHERE `room_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `overlooks_world_uq` ON `overlooks` (`world_id`) WHERE `world_id` IS NOT NULL;
--> statement-breakpoint
-- Explicit edit grants from `/overlook add <user>`, on top of the implicit
-- authority the scope already carries (room owner/mod, world owner/
-- collaborator). Keyed on the ACCOUNT, not an identity: this is authority,
-- and authority is per-account everywhere else in the app (`room_mods` is
-- display-only for the userlist crown, deliberately).
CREATE TABLE IF NOT EXISTS `overlook_editors` (
  `overlook_id` text NOT NULL REFERENCES overlooks(id) ON DELETE CASCADE,
  `user_id` text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  `added_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `added_by_user_id` text REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (`overlook_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `overlook_editors_user_idx` ON `overlook_editors` (`user_id`);
--> statement-breakpoint
-- Master switch. ON by default: the canvas stores no member bytes in the
-- default configuration (images are external https URLs proxied on read), so
-- unlike uploads it needs no opt-in.
ALTER TABLE `site_settings` ADD COLUMN `overlook_enabled` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
-- Image-upload switch, OFF by default and checked server-side on save. When
-- off, a scene may only reference images by external https URL (fetched
-- through the same-origin proxy so canvas export keeps working); any base64
-- data URL in the scene's `files` map is refused. Same reasoning as
-- `world_map_uploads_enabled` in 0360: the hosting volume is small and shared
-- with the database, so member-uploaded bytes are an explicit admin opt-in.
ALTER TABLE `site_settings` ADD COLUMN `overlook_uploads_enabled` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Per-world opt-in. Rooms get their Overlook automatically (the room bar
-- button is always there for people who can edit), but a world has a tab
-- strip that shouldn't grow an empty tab for every world ever created, so
-- the owner turns it on in world settings and viewers only see the tab once
-- the canvas actually has something on it.
ALTER TABLE `worlds` ADD COLUMN `overlook_enabled` integer NOT NULL DEFAULT 0;
