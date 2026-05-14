-- Per-identity partitioning for friends and direct messages.
--
-- Before: friends and DMs were keyed on (userId, userId). Any character
-- the user was playing shared a single friends list and DM inbox, and
-- the recipient could see the master OOC handle through DM metadata.
--
-- After: each row records BOTH sides' (userId, characterId) tuples.
-- characterId NULL means "this side is the master OOC handle." Two
-- characters of the same player can now keep entirely separate social
-- graphs and inboxes, and the recipient never sees a master handle for
-- an interaction that happened in-character.
--
-- Migration policy (per user direction): existing rows stay as-is,
-- attributing both sides to the master OOC handle (characterId NULL on
-- both sides). New rows tag the active character at the time of
-- friending / messaging.
--
-- SQLite can't ALTER PRIMARY KEY or add unique-index constraints that
-- include new columns in place, so the friends + direct_conversations
-- tables get the rename-and-recreate dance. direct_messages just gets
-- a new nullable column, and direct_conversation_reads is unchanged
-- (per-conversation read markers stay keyed on conversation+user; the
-- conversation row itself encodes which identity each side is).

PRAGMA foreign_keys=OFF;

----------------------------------------------------------------------
-- friends
----------------------------------------------------------------------
CREATE TABLE friends_new (
  friender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friended_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friender_character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  friended_character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO friends_new (
  friender_user_id, friended_user_id,
  friender_character_id, friended_character_id,
  status, created_at
)
SELECT
  friender_user_id, friended_user_id,
  NULL, NULL,
  status, created_at
FROM friends;

DROP TABLE friends;
ALTER TABLE friends_new RENAME TO friends;

-- SQLite treats NULL as distinct in unique indexes, which would let
-- two rows for the same master pair coexist. COALESCE to empty string
-- collapses NULL → '' so the uniqueness check works for master rows.
CREATE UNIQUE INDEX friends_pair_uq ON friends (
  friender_user_id,
  COALESCE(friender_character_id, ''),
  friended_user_id,
  COALESCE(friended_character_id, '')
);
CREATE INDEX friends_friended_idx ON friends (friended_user_id);
CREATE INDEX friends_status_idx ON friends (friended_user_id, status);

----------------------------------------------------------------------
-- direct_conversations
----------------------------------------------------------------------
CREATE TABLE direct_conversations_new (
  id TEXT PRIMARY KEY NOT NULL,
  user_a_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_a_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  user_b_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_message_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO direct_conversations_new (
  id,
  user_a_id, user_b_id,
  user_a_character_id, user_b_character_id,
  created_at, last_message_at
)
SELECT
  id,
  user_a_id, user_b_id,
  NULL, NULL,
  created_at, last_message_at
FROM direct_conversations;

DROP TABLE direct_conversations;
ALTER TABLE direct_conversations_new RENAME TO direct_conversations;

CREATE UNIQUE INDEX direct_conversations_pair_uq ON direct_conversations (
  user_a_id, COALESCE(user_a_character_id, ''),
  user_b_id, COALESCE(user_b_character_id, '')
);
CREATE INDEX direct_conversations_a_idx ON direct_conversations (user_a_id, last_message_at);
CREATE INDEX direct_conversations_b_idx ON direct_conversations (user_b_id, last_message_at);

----------------------------------------------------------------------
-- direct_messages
----------------------------------------------------------------------
-- sender_character_id is a send-time snapshot of which character the
-- sender was voicing. Pairs with the existing display_name / avatar_url
-- snapshot columns so a later /char clear or character delete doesn't
-- rewrite past lines.
ALTER TABLE direct_messages
  ADD COLUMN sender_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL;

PRAGMA foreign_keys=ON;
