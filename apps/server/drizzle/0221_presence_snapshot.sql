-- Presence snapshot, a single row holding the in-memory away / mood / idle-
-- ghost state serialized as JSON, written on graceful shutdown and restored on
-- boot so a deploy (remote-deploy.sh) doesn't reset everyone's idle/away
-- status. One-shot: the row is deleted on restore. See
-- apps/server/src/realtime/presenceSnapshot.ts.
CREATE TABLE IF NOT EXISTS presence_snapshots (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  saved_at INTEGER NOT NULL
);
