-- DM reports. Extends the existing reports table with an optional
-- pointer to a `direct_messages` row, plus a snapshot of the DM body
-- so the admin queue can show the reported content without ever
-- querying `direct_messages` from an /admin/* route — same posture
-- the whisper-report flow already uses.
--
-- The original `reports.message_id` column was `NOT NULL` (every
-- report referenced a room message). DM reports invert that: they
-- reference a `direct_message_id` instead, and `message_id` is
-- nullable. SQLite doesn't support `ALTER COLUMN ... DROP NOT NULL`,
-- so this migration uses the canonical table-rebuild idiom: copy
-- into a new table with the relaxed schema, swap, recreate indexes.
--
-- Exactly one of (`message_id`, `direct_message_id`) must be set
-- on a given row. Enforced at the route layer.

PRAGMA foreign_keys=OFF;

CREATE TABLE reports_new (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Now nullable so DM reports can omit it.
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  -- Room id stays for room-message reports (helps the admin queue
  -- jump-to-context). Nullable too, since DM reports have no room.
  room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at INTEGER,
  resolution_note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  -- New DM fields.
  direct_message_id TEXT REFERENCES direct_messages(id) ON DELETE SET NULL,
  body_snapshot TEXT,
  sender_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO reports_new (
  id, reporter_user_id, message_id, room_id, reason, status,
  resolved_by_id, resolved_at, resolution_note, created_at
)
SELECT
  id, reporter_user_id, message_id, room_id, reason, status,
  resolved_by_id, resolved_at, resolution_note, created_at
FROM reports;

DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;

-- Recreate the existing index on (status, created_at).
CREATE INDEX reports_status_idx ON reports (status, created_at);
-- New index for DM-only lookups.
CREATE INDEX reports_direct_message_idx ON reports (direct_message_id);

PRAGMA foreign_keys=ON;
