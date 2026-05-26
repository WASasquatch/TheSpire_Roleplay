-- 0142_scriptorium_privacy_reports.sql
--
-- Phase 9: per-user catalog preferences for the Scriptorium.
--   * story_show_nsfw      — opt-in for R / NC-17 cards in the catalog.
--                            Anonymous viewers already never see these
--                            server-side; this gates them for signed-in
--                            viewers too. Default OFF — readers opt in.
--   * story_cw_blocklist   — comma-separated content warnings that hide
--                            cards entirely. Reader-personalised filter
--                            that the catalog ANDs into every query.
--
-- Phase 10: story / chapter / review reports for moderation. Mirrors
-- the existing `reports` table for room messages + DMs but carries a
-- structured target tuple (kind + id) so one table covers all three
-- Scriptorium surfaces. Snapshot JSON captures title/body/etc. at
-- report time so an author who later deletes the content can't hide
-- the evidence from moderation review.

ALTER TABLE `users` ADD COLUMN `story_show_nsfw` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE `users` ADD COLUMN `story_cw_blocklist` TEXT NOT NULL DEFAULT '';
--> statement-breakpoint


CREATE TABLE IF NOT EXISTS `story_reports` (
  `id`                  TEXT NOT NULL PRIMARY KEY,
  `target_kind`         TEXT NOT NULL,                                 -- story | chapter | review | review_reply
  `target_id`           TEXT NOT NULL,
  `story_id`            TEXT NOT NULL REFERENCES `stories`(`id`) ON DELETE CASCADE,
  `reporter_user_id`    TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `reason`              TEXT,
  -- JSON snapshot: { title, body, author, rating, ... } captured at
  -- report time. Lets the queue render the report even if the author
  -- has since deleted the content.
  `snapshot_json`       TEXT NOT NULL DEFAULT '{}',
  `status`              TEXT NOT NULL DEFAULT 'open',                  -- open | reviewed | dismissed
  `resolved_by_id`      TEXT REFERENCES `users`(`id`) ON DELETE SET NULL,
  `resolved_at`         INTEGER,
  `resolution_note`     TEXT,
  `created_at`          INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

-- One report per (reporter, target) — second-tap is silently a no-op,
-- not a duplicate. Same posture as room-message reports.
CREATE UNIQUE INDEX IF NOT EXISTS `story_reports_reporter_target_uq`
  ON `story_reports` (`reporter_user_id`, `target_kind`, `target_id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `story_reports_status_idx`
  ON `story_reports` (`status`, `created_at`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `story_reports_story_idx`
  ON `story_reports` (`story_id`);
