-- Theater mode (synchronized watch-party) per-room CONFIG.
--
-- A room with theater_mode = 1 renders a video panel above the chat.
-- Owners/mods drive shared playback (play/pause/seek/advance) and every
-- other occupant follows in lockstep. This stores only the persistent
-- configuration; the LIVE playback position (current index, isPlaying,
-- seconds) lives in server memory and rides the `theater:sync` socket
-- event - it is deliberately never written here, per-tick position must
-- not touch SQLite.
--
--   theater_mode      , on/off toggle (orthogonal to public/private, so a
--                       theater can be either an open or password room).
--   theater_loop      , continuous-playback behavior at end-of-source:
--                       'off' stop | 'one' repeat current | 'all' advance
--                       the playlist and loop back (default).
--   theater_playlist  , JSON array of { id, url, kind, title? } sources in
--                       play order. '[]' = no media set yet.
--
-- Defaults keep every existing room behaving exactly as before (mode off,
-- empty playlist); the columns are inert until an owner runs `/theater on`.

ALTER TABLE `rooms` ADD COLUMN `theater_mode` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `rooms` ADD COLUMN `theater_loop` TEXT NOT NULL DEFAULT 'all';
--> statement-breakpoint
ALTER TABLE `rooms` ADD COLUMN `theater_playlist` TEXT NOT NULL DEFAULT '[]';
