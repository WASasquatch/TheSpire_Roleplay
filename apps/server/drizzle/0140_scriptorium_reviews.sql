-- 0140_scriptorium_reviews.sql
--
-- Phase 6: reviews + replies + applause for stories.
--
-- Reviews:    one per (reviewer identity, story). Stars 1..5 + optional
--             prose body (sanitized HTML). 60-second edit grace mirrors
--             chat / DM grace. Author can pin one + hide individual
--             reviews (per-story moderation; the reviewer still sees it
--             on their end, same shape as `/ignore`).
--
-- Replies:    threaded one level under each review (the canonical
--             "review → reply → author-reply" chain). Plain HTML.
--
-- Applause:   one tap per (reader, story[, chapter]). Idempotent toggle:
--             second tap removes the row. Author cannot see WHO
--             applauded, the stories.applause_count rollup is the only
--             surface. Cap rendering reads from the counter.
--
-- All bodies pass through the same `sanitizeBio` filter the rest of the
-- HTML surfaces use. Cascade deletes propagate from `stories`.

CREATE TABLE IF NOT EXISTS `story_reviews` (
  `id`                       TEXT NOT NULL PRIMARY KEY,
  `story_id`                 TEXT NOT NULL REFERENCES `stories`(`id`) ON DELETE CASCADE,
  `reviewer_user_id`         TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `reviewer_character_id`    TEXT REFERENCES `characters`(`id`) ON DELETE SET NULL,
  `rating`                   INTEGER NOT NULL,            -- 1..5
  `body_html`                TEXT NOT NULL DEFAULT '',
  `pinned_by_author`         INTEGER NOT NULL DEFAULT 0,
  `hidden_by_author`         INTEGER NOT NULL DEFAULT 0,
  `edit_grace_expires_at`    INTEGER,                     -- ms-since-epoch; null = grace passed
  `created_at`               INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at`               INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

-- One review per (story, reviewer identity). The character_id is part of
-- the tuple so a master account + one of their characters can each
-- leave their own review (the bond/title system uses the same identity
-- partitioning).
CREATE UNIQUE INDEX IF NOT EXISTS `story_reviews_identity_uq`
  ON `story_reviews` (`story_id`, `reviewer_user_id`, coalesce(`reviewer_character_id`, ''));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `story_reviews_story_idx`
  ON `story_reviews` (`story_id`, `created_at`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `story_reviews_reviewer_idx`
  ON `story_reviews` (`reviewer_user_id`, `created_at`);
--> statement-breakpoint


CREATE TABLE IF NOT EXISTS `story_review_replies` (
  `id`                       TEXT NOT NULL PRIMARY KEY,
  `review_id`                TEXT NOT NULL REFERENCES `story_reviews`(`id`) ON DELETE CASCADE,
  `replyer_user_id`          TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `replyer_character_id`     TEXT REFERENCES `characters`(`id`) ON DELETE SET NULL,
  `body_html`                TEXT NOT NULL DEFAULT '',
  `created_at`               INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at`               INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `story_review_replies_review_idx`
  ON `story_review_replies` (`review_id`, `created_at`);
--> statement-breakpoint


-- Applause is a simple per-(reader, target) idempotent boolean. The
-- target is either the whole story (chapter_id NULL) OR a specific
-- chapter (chapter_id set). Uniqueness uses COALESCE so the
-- chapter-null case has a deterministic key, SQLite forbids
-- expressions inside PK/UNIQUE table constraints, so we lift it into
-- a separate UNIQUE INDEX (expressions in indexes are allowed).
CREATE TABLE IF NOT EXISTS `story_applause` (
  `story_id`         TEXT NOT NULL REFERENCES `stories`(`id`) ON DELETE CASCADE,
  -- NULL = applauded the whole story; non-NULL = a specific chapter.
  `chapter_id`       TEXT REFERENCES `story_chapters`(`id`) ON DELETE CASCADE,
  `user_id`          TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `applauded_at`     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `story_applause_uq`
  ON `story_applause` (`story_id`, coalesce(`chapter_id`, ''), `user_id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `story_applause_story_idx`
  ON `story_applause` (`story_id`);
