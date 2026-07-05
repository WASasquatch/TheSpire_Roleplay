-- 0325: Account-level mutes — server-wide / site-wide timed silence whose REACH
-- follows the ISSUER's authority. Site staff (global mod/admin) mute site-wide;
-- server staff (server owner/admin/mod with `mute_member`) mute their whole
-- server. A room owner/mod's /mute stays in the per-room `mutes` table. Every
-- mute is account-level (silences all of the target's tabs/identities) and is
-- enforced in dispatch.ts alongside the room mute, cleared by /unmute or expiry.
--
-- Additive; nothing reads this until the wider-mute paths ship. `server_id` is
-- set for scope='server' and NULL for scope='site'. The two partial UNIQUE
-- indexes keep at most one site mute per user and one server mute per
-- (user, server); the plain user index drives the per-message enforcement
-- lookup.

CREATE TABLE IF NOT EXISTS account_mutes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
  until INTEGER NOT NULL,
  reason TEXT,
  issued_by_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS account_mutes_user_idx ON account_mutes (user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS account_mutes_site_uq ON account_mutes (user_id) WHERE scope = 'site';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS account_mutes_server_uq ON account_mutes (user_id, server_id) WHERE scope = 'server';
