-- Direct messages: persistent two-party conversations distinct from
-- whispers. See plan.md Phase 3 for the rationale (different
-- semantics, different privacy enforcement scope, easier to keep
-- admin-blind at the table level than alongside `messages` /
-- `rooms`).
--
-- Canonical-pair invariant: every conversation row stores the
-- lexicographically smaller user id in `user_a_id`. The unique
-- index then guarantees one conversation per pair regardless of
-- who started it. The route layer enforces the ordering on insert.

CREATE TABLE direct_conversations (
  id TEXT PRIMARY KEY,
  user_a_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_message_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE UNIQUE INDEX direct_conversations_pair_uq
  ON direct_conversations (user_a_id, user_b_id);
CREATE INDEX direct_conversations_a_idx
  ON direct_conversations (user_a_id, last_message_at);
CREATE INDEX direct_conversations_b_idx
  ON direct_conversations (user_b_id, last_message_at);

CREATE TABLE direct_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Snapshot at send time so renames / character switches don't
  -- rewrite history. Same shape as messages.display_name.
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  body TEXT NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX direct_messages_conv_time_idx
  ON direct_messages (conversation_id, created_at);

-- Per-user read tracking. Lets the rail / conversation list show
-- unread counts without scanning every message every render.
CREATE TABLE direct_conversation_reads (
  conversation_id TEXT NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

-- Per-user opt-out. Defaults to "on" so existing users get DMs
-- without re-opting in; users can flip it via the profile editor.
ALTER TABLE users ADD COLUMN dms_enabled INTEGER NOT NULL DEFAULT 1;
