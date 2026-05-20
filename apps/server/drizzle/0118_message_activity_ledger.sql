-- Append-only ledger for user-authored message creation events.
-- Decoupled from the `messages` table so the "messages in the last
-- 24h" splash stat reflects actual posting activity, not just the
-- messages that have survived the global retention sweep
-- (`messageRetentionMs`) and per-room expiry sweeps
-- (`rooms.messageExpiryMinutes`). Without this ledger, the stat
-- counts down as old messages get deleted — backwards from what
-- "activity in the last 24h" should mean for visitors deciding
-- whether the site is alive.
--
-- We DON'T log server-authored system messages here (room
-- descriptions, "X has connected" / "X has disconnected"). Those
-- are noise on an activity beacon, and including them would let a
-- single reconnect-storm inflate the splash number. Whispers and
-- /npc and /me actions and forum posts all DO log — anything a
-- user typed counts as activity.
--
-- Bounded by the hourly janitor sweep below: rows older than 26h
-- are deleted on every pass, so the table holds at most ~26h of
-- entries. The 2h buffer past the 24h query window guarantees the
-- splash stat never misses a row that's still in scope.

CREATE TABLE `message_activity` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `created_at` INTEGER NOT NULL
);
--> statement-breakpoint

CREATE INDEX `message_activity_created_at_idx`
  ON `message_activity` (`created_at`);
