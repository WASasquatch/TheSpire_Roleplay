-- Global, MUTUAL block list. Stronger than `ignores` (which is one-way and
-- message-only): once a row exists between two accounts in EITHER direction,
-- the two users and all their characters are invisible to each other across
-- the whole app. One directed row per initiation; reads consult both
-- directions. Keyed on the master userId, so it spans every character on both
-- sides. Only the blocker can remove their own row.
CREATE TABLE IF NOT EXISTS blocks (
  blocker_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);
--> statement-breakpoint
-- Reverse-direction lookups (who has blocked me) can't use the PK's leading
-- column, so index blocked_user_id explicitly.
CREATE INDEX IF NOT EXISTS blocks_blocked_idx ON blocks (blocked_user_id);
