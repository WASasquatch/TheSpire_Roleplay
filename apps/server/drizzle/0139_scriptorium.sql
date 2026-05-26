-- 0139_scriptorium.sql
--
-- The Scriptorium feature: long-form fiction authored by identities
-- (master accounts OR characters), readable from the splash page and
-- in-app. Mirrors the privacy posture of worlds — visibility tiers
-- gate who sees a story, and the rating tier gates whether anonymous
-- splash viewers see it at all (R / NC-17 are excluded from the
-- splash + sitemap regardless of visibility).
--
-- This migration uses `CREATE TABLE IF NOT EXISTS` so it's safe to
-- re-apply on a database where these tables already exist from a
-- previous run that wasn't fully cleaned up before reset. New
-- installs get a fresh create; existing installs get a no-op.

CREATE TABLE IF NOT EXISTS `stories` (
  `id`                  TEXT NOT NULL PRIMARY KEY,
  `author_user_id`      TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `author_character_id` TEXT REFERENCES `characters`(`id`) ON DELETE SET NULL,
  `slug`                TEXT NOT NULL,
  `title`               TEXT NOT NULL,
  `summary`             TEXT NOT NULL DEFAULT '',
  `synopsis_html`       TEXT NOT NULL DEFAULT '',
  `cover_image_url`     TEXT,
  `theme_json`          TEXT,
  `genre`               TEXT NOT NULL DEFAULT 'other',
  `rating`              TEXT NOT NULL DEFAULT 'PG',
  `status`              TEXT NOT NULL DEFAULT 'draft',
  `visibility`          TEXT NOT NULL DEFAULT 'private',
  `tags`                TEXT NOT NULL DEFAULT '',
  `content_warnings`    TEXT NOT NULL DEFAULT '',
  `linked_world_id`     TEXT REFERENCES `worlds`(`id`) ON DELETE SET NULL,
  `allow_reviews`       INTEGER NOT NULL DEFAULT 0,
  `allow_applause`      INTEGER NOT NULL DEFAULT 1,
  `total_words`         INTEGER NOT NULL DEFAULT 0,
  `total_chapters`      INTEGER NOT NULL DEFAULT 0,
  `reader_count`        INTEGER NOT NULL DEFAULT 0,
  `applause_count`      INTEGER NOT NULL DEFAULT 0,
  `review_count`        INTEGER NOT NULL DEFAULT 0,
  `avg_rating_x100`     INTEGER,
  `published_at`        INTEGER,
  `created_at`          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at`          INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `stories_author_slug_uq`
  ON `stories` (`author_user_id`, lower(`slug`));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `stories_catalog_idx`
  ON `stories` (`visibility`, `rating`, `status`, `updated_at`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `stories_linked_world_idx`
  ON `stories` (`linked_world_id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `stories_author_idx`
  ON `stories` (`author_user_id`, `updated_at`);
--> statement-breakpoint


CREATE TABLE IF NOT EXISTS `story_chapters` (
  `id`                  TEXT NOT NULL PRIMARY KEY,
  `story_id`            TEXT NOT NULL REFERENCES `stories`(`id`) ON DELETE CASCADE,
  `sort_order`          INTEGER NOT NULL DEFAULT 0,
  `title`               TEXT NOT NULL DEFAULT '',
  `body_html`           TEXT NOT NULL DEFAULT '',
  `author_notes_html`   TEXT NOT NULL DEFAULT '',
  `content_warnings`    TEXT NOT NULL DEFAULT '',
  `word_count`          INTEGER NOT NULL DEFAULT 0,
  `status`              TEXT NOT NULL DEFAULT 'draft',
  `published_at`        INTEGER,
  `created_at`          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at`          INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `story_chapters_order_idx`
  ON `story_chapters` (`story_id`, `sort_order`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `story_chapters_published_idx`
  ON `story_chapters` (`story_id`, `status`, `published_at`);
--> statement-breakpoint


CREATE TABLE IF NOT EXISTS `story_chapter_versions` (
  `id`                  TEXT NOT NULL PRIMARY KEY,
  `chapter_id`          TEXT NOT NULL REFERENCES `story_chapters`(`id`) ON DELETE CASCADE,
  `version`             INTEGER NOT NULL,
  `body_html`           TEXT NOT NULL DEFAULT '',
  `author_notes_html`   TEXT NOT NULL DEFAULT '',
  `reason`              TEXT NOT NULL DEFAULT 'autosave',
  `saved_by_user_id`    TEXT REFERENCES `users`(`id`) ON DELETE SET NULL,
  `saved_at`            INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `story_chapter_versions_chapter_version_uq`
  ON `story_chapter_versions` (`chapter_id`, `version`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `story_chapter_versions_chapter_idx`
  ON `story_chapter_versions` (`chapter_id`, `saved_at`);
--> statement-breakpoint


CREATE TABLE IF NOT EXISTS `story_reading_positions` (
  `story_id`            TEXT NOT NULL REFERENCES `stories`(`id`) ON DELETE CASCADE,
  `user_id`             TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `last_chapter_id`     TEXT REFERENCES `story_chapters`(`id`) ON DELETE SET NULL,
  `last_anchor_id`      TEXT,
  `percent_through`     INTEGER NOT NULL DEFAULT 0,
  `updated_at`          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`story_id`, `user_id`)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `story_reading_positions_user_idx`
  ON `story_reading_positions` (`user_id`, `updated_at`);
