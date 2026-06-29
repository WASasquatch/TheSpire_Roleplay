-- Servers Lift, Phase 1 (additive): the partition seam. Canonical DDL: plan.md
-- §5.3. `rooms.server_id` mirrors `rooms.forum_id` (0223) — EVERY chat room
-- belongs to exactly one server; the rail filters by server_id (only the
-- selected server's rooms show), and join/presence consult serverAuthority
-- (membership/ban) BEFORE the room-level checks.
--
-- CASCADE CHOICE — this differs deliberately from a hard CASCADE:
--   A hard CASCADE would silently destroy every room (and its messages, via the
--   messages FK) when a server is deleted — too destructive, and there is no
--   tested server-deletion path yet (forums only archive). So we use SET NULL
--   and define "orphaned" rooms (server_id IS NULL) as ADOPTED BY THE DEFAULT
--   server at the application layer (serverAuthority treats NULL -> the
--   is_system server). This guarantees a room is never presence-homeless even
--   mid-deletion. The Phase-2 backfill makes NULL impossible for existing data.
ALTER TABLE `rooms` ADD COLUMN `server_id` text REFERENCES `servers`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `rooms_server_idx` ON `rooms` (`server_id`);
--> statement-breakpoint

-- §9.1 BLOCKER FIX: re-scope the single-default invariant from install-global
-- to per-server, IN THIS SAME FILE/TRANSACTION. Migration 0036 created an
-- install-global `UNIQUE(is_default) WHERE is_default=1` (rooms_is_default_uq).
-- Without dropping it, creating ANY second server's is_default=1 starter room
-- fails with `UNIQUE constraint failed: rooms.is_default`, breaking the headline
-- feature on the first attempt. Dropping it is safe: every existing room is
-- still server_id-NULL here, so the new partial predicate matches nothing yet,
-- and the one existing default row is preserved.
DROP INDEX IF EXISTS `rooms_is_default_uq`;
--> statement-breakpoint
-- The new invariant: at most one is_default room PER server (server_id-NULL
-- rooms are excluded so the legacy global default doesn't collide pre-backfill).
CREATE UNIQUE INDEX `rooms_one_default_per_server`
  ON `rooms` (`server_id`)
  WHERE `is_default` = 1 AND `server_id` IS NOT NULL;
--> statement-breakpoint

-- Per-(user, server) last room (mirror users.last_room_id but server-scoped).
-- users.last_room_id is a SINGLE account-global slot — a multi-server user needs
-- to return to the right room in EACH server on reconnect / server switch. The
-- connect-time placement tier 3 reads this when a server is selected; the
-- per-tab tabRoomId cache still wins above it.
CREATE TABLE `user_server_last_room` (
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `server_id` text NOT NULL REFERENCES `servers`(`id`) ON DELETE CASCADE,
  `room_id` text REFERENCES `rooms`(`id`) ON DELETE SET NULL,
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`user_id`, `server_id`)
);
--> statement-breakpoint

-- Per-account "home server" the rail opens on (mirror users.default_forum_id,
-- 0274). NULL = no preference (falls back to the default/system server). A stale
-- id (server deleted) is harmless — the client ignores ids not in the viewer's
-- list. Also the home-server anchor for off-room earning credits (Phase 5b).
ALTER TABLE `users` ADD COLUMN `default_server_id` text;
--> statement-breakpoint

-- A forum belongs to a server (server is the OUTER container, forum is an INNER
-- sub-container, room is the leaf). SET NULL so deleting a server un-homes its
-- forums rather than destroying them; the app treats NULL as the default server.
ALTER TABLE `forums` ADD COLUMN `server_id` text REFERENCES `servers`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `forums_server_idx` ON `forums` (`server_id`);
