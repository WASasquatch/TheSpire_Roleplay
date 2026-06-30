-- 0303: Notification Center — the unified inbox.
--
-- Generalizes the forum notification engine into one table that surfaces server
-- approvals, @mentions (chat + forum), DMs, friend requests, earning
-- milestones, announcements, and report outcomes. Display fields are snapshots
-- so rows survive renames; actor/character/server FKs SET NULL so a deleted
-- actor/server leaves the historical row readable. Additive — no backfill (the
-- existing forum_notifications inbox keeps working; its count folds into the
-- bell client-side).

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  kind TEXT NOT NULL,
  server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT,
  title TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  target_kind TEXT NOT NULL DEFAULT 'none',
  target_id TEXT,
  url TEXT,
  metadata_json TEXT,
  dedupe_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  seen_at INTEGER,
  read_at INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id, read_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notifications_server_unread_idx ON notifications (user_id, server_id, read_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notifications_dedupe_idx ON notifications (user_id, dedupe_key);
