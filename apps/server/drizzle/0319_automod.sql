-- 0319: Auto-moderation rules — keyword/regex/link/invite/mention filters.
--
-- A configurable rule set the chat + forum pipelines consult before a message
-- lands. Each rule matches on a `kind` (keyword / regex / link / invite /
-- mention_cap) and applies an `action` (warn / delete / mute). Rules are
-- SITE-WIDE when `server_id` is null, or scoped to one community server; the
-- (server_id, enabled) index drives the per-scope active-rule read. `scope`
-- picks which surfaces a rule polices (chat / forum / both).
--
-- Three moving parts, mirroring the 0313 anti-spam shape:
--   1) `automod_rules` table (below).
--   2) Admin master switch `automod_enabled` on site_settings, OFF by default
--      so admins opt in from the console.
--   3) Seed the `bypass_automod` permission for trusted users, mods, and
--      admins so the filters only ever police ordinary accounts (masteradmin
--      bypasses every permission in code, so it needs no row).
--
-- Additive; the filters stay dormant until `automod_enabled` flips on and at
-- least one rule exists.

CREATE TABLE IF NOT EXISTS automod_rules (
  id TEXT PRIMARY KEY NOT NULL,
  -- null = site-wide; set = scoped to this community server (cascade delete).
  server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- keyword | regex | link | invite | mention_cap
  kind TEXT NOT NULL,
  -- the matcher input: word/phrase, regex source, or the numeric cap for mention_cap.
  pattern TEXT NOT NULL DEFAULT '',
  -- warn | delete | mute
  action TEXT NOT NULL DEFAULT 'warn',
  -- mute duration in ms when action = 'mute'; null = a default the engine picks.
  mute_ms INTEGER,
  -- chat | forum | both
  scope TEXT NOT NULL DEFAULT 'both',
  case_insensitive INTEGER NOT NULL DEFAULT 1,
  whole_word INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS automod_rules_scope_idx ON automod_rules (server_id, enabled);
--> statement-breakpoint
-- Admin master switch: when on, the chat + forum pipelines run enabled rules.
-- OFF by default so enabling it is a deliberate console action.
ALTER TABLE site_settings ADD COLUMN automod_enabled INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
INSERT OR IGNORE INTO role_permission_grants (role, permission_key) VALUES
  ('trusted', 'bypass_automod'),
  ('mod', 'bypass_automod'),
  ('admin', 'bypass_automod');
