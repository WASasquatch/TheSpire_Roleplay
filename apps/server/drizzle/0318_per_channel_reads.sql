-- 0318: Per-channel read tracking + per-room notification prefs.
--
-- Today "unread" is a single account-wide notion; a user who reads one room
-- can't tell which OTHER rooms have new activity, and there's no per-room
-- mute. Two composite-PK tables, mirroring the shape of `mutes` /
-- `room_members` (same (user, room) grain, cascade FKs so a deleted user or
-- room takes its rows with it):
--
-- `room_reads`            one row per (user, room) high-water mark. `lastReadAt`
--                         (ms) is the timestamp the user has read up to;
--                         `lastReadMessageId` snapshots the exact row so a
--                         retention sweep that moves the timeline doesn't lose
--                         the anchor. Absent row = never read (all visible
--                         history counts as unread).
-- `per_room_notify_prefs` one row per (user, room) mute preference. `muted`
--                         suppresses the unread badge + any per-room ping;
--                         `mutedUntil` (ms, nullable) is a timed mute that
--                         lazily expires (null = indefinite while `muted`).
--
-- Additive; nothing reads these until the per-channel unread feature ships.
-- The `room:unread` socket event carries the live delta so badges update
-- without a refetch.

CREATE TABLE IF NOT EXISTS room_reads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  last_read_at INTEGER NOT NULL DEFAULT 0,
  last_read_message_id TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (user_id, room_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS room_reads_room_idx ON room_reads (room_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS per_room_notify_prefs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  muted INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER,
  PRIMARY KEY (user_id, room_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS per_room_notify_prefs_room_idx ON per_room_notify_prefs (room_id);
