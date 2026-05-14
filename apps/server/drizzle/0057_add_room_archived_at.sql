-- Archive (soft-delete) flag for user-created rooms.
--
-- Behavior change: when the last live socket leaves a user-created
-- room, the room used to be hard-deleted (DELETE FROM rooms, cascade
-- onto messages / members / bans / invites). That worked but lost the
-- configuration: someone resurrecting a room with the same name had
-- to redo topic / description / replyMode / messageExpiryMinutes /
-- theme overrides from scratch.
--
-- Now: the same trigger sets `archived_at` instead of dropping the
-- row. Archived rooms are excluded from the rooms tree, search, and
-- the join path (so the name appears available). When ANY user
-- creates a room with that lowercased name, the route detects the
-- archived row, reactivates it by clearing `archived_at`, transfers
-- ownership to the new creator, and resets the per-room membership +
-- ban tables to a fresh slate. All other settings (topic, theme,
-- replyMode, expiry, npcDisabled, password hash) carry over so the
-- new owner inherits the prior incarnation's polish.
--
-- The unique-name index still applies to archived rows, which is
-- what lets the "create with same name → resurrect existing row"
-- path stay consistent.
ALTER TABLE rooms
  ADD COLUMN archived_at INTEGER;
CREATE INDEX rooms_archived_at_idx ON rooms (archived_at);
