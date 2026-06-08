-- Event-time IP capture. `sessions.ip` is frozen at login; a session can live
-- for weeks (TTL defaults to 30 days), so the login address goes stale as a
-- user roams networks. This table is upserted on real activity (socket
-- connect, room switch, chat send, authenticated HTTP posts), keyed
-- (user_id, ip) so each distinct address gets one row whose last_seen_at
-- tracks the user's latest activity from it. Feeds /admin/users alt-detection
-- alongside `sessions`. Writes are throttled in-process (auth/ipLog.ts).
CREATE TABLE IF NOT EXISTS user_ip_log (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  hit_count INTEGER NOT NULL DEFAULT 1,
  last_user_agent TEXT,
  last_event TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS user_ip_log_user_ip_idx ON user_ip_log (user_id, ip);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_ip_log_ip_idx ON user_ip_log (ip);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_ip_log_user_seen_idx ON user_ip_log (user_id, last_seen_at);
