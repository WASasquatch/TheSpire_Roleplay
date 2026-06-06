-- 0145_scriptorium_chapter_locks.sql
--
-- Phase 5 (soft-lock conflict policy): per-chapter editing lock so a
-- second collaborator opening the same chapter sees "Alice is editing
--, open read-only?" rather than silently overwriting Alice's draft.
--
-- The lock is advisory:
--   * Acquired when an author/collaborator opens the chapter editor.
--   * Refreshed by client heartbeat (every ~2 minutes; lease is 5
--     minutes since `last_refresh_at`).
--   * Released on editor close (DELETE) or expires lazily, server
--     treats `last_refresh_at + 5min < now()` as available.
--   * "Force edit" simply bypasses the lock; saves still go through.
--     The version table already captures every save, so divergence
--     surfaces as separate rows in chapter history.
--
-- One lock per chapter (`chapter_id` PK). A user editing multiple
-- chapters holds multiple locks, one per chapter.

CREATE TABLE IF NOT EXISTS `story_chapter_locks` (
  `chapter_id`        TEXT NOT NULL PRIMARY KEY REFERENCES `story_chapters`(`id`) ON DELETE CASCADE,
  `user_id`           TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `acquired_at`       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `last_refresh_at`   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

-- Caller's "what am I locking" lookup. Cheap to maintain at lock-
-- table scale (only as many rows as chapters being actively edited).
CREATE INDEX IF NOT EXISTS `story_chapter_locks_user_idx`
  ON `story_chapter_locks` (`user_id`);
