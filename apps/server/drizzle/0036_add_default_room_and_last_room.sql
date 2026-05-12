-- Admin-flagged default landing room (replaces the hard-coded "The_Spire"
-- name lookup as the source of truth). Exactly one room is expected to
-- carry is_default=1; the partial unique index below enforces it. Cold-
-- connect / kick / ban / admin-room-delete all resolve the landing via
-- this flag now, with the legacy "The_Spire" name still serving as a
-- fallback so installs that haven't yet flipped the flag keep working.
ALTER TABLE `rooms`
  ADD COLUMN `is_default` integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS `rooms_is_default_uq`
  ON `rooms` (`is_default`)
  WHERE `is_default` = 1;

-- Remember the last room a user was in when they disconnect or idle out.
-- On reconnect we try to drop them back into it (subject to bans /
-- visibility / existence). Null means "never been in a room" (fresh
-- registrant) or "we explicitly cleared it" — in either case the
-- canonical landing wins.
ALTER TABLE `users`
  ADD COLUMN `last_room_id` text REFERENCES `rooms`(`id`) ON DELETE SET NULL;
