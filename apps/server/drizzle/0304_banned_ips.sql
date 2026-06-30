-- 0304: IP-level block list for global bans.
--
-- When a global admin bans a user, their recent public IPs are mirrored here so
-- the same person can't immediately register burner accounts to keep harassing
-- users and admins. Checked at registration + login; one row per address.
-- banned_until null = permanent (a timed account ban makes a timed IP block).
-- Cleared on unban via target_user_id. Private/loopback IPs are never inserted
-- (filtered in auth/ipBan.ts) so dev + NAT hops don't self-block.

CREATE TABLE IF NOT EXISTS banned_ips (
  id TEXT PRIMARY KEY NOT NULL,
  ip TEXT NOT NULL,
  banned_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  banned_until INTEGER,
  reason TEXT,
  banned_by_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS banned_ips_ip_idx ON banned_ips (ip);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS banned_ips_target_idx ON banned_ips (target_user_id);
