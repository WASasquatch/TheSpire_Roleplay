-- 0144_scriptorium_collaborators.sql
--
-- Phase 5: per-story collaborators with role-based permissions. The
-- story's owner (stories.author_user_id) is implicit; this table holds
-- the added roles only.
--
-- Roles (closed enum at the Zod layer):
--   reader   , read drafts only. Useful for beta readers.
--   editor   , edit existing chapters + manage codex; cannot add new
--               chapters or publish.
--   co_author, edit + add chapters, manage codex, publish. Cannot
--               manage collaborators or delete the story (owner only).
--
-- accepted_at NULL = pending invitation. Set = active collaborator.
-- The recipient sees pending invites in their My Stories tab and can
-- accept or decline; declining deletes the row.

CREATE TABLE IF NOT EXISTS `story_collaborators` (
  `story_id`            TEXT NOT NULL REFERENCES `stories`(`id`) ON DELETE CASCADE,
  `user_id`             TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `role`                TEXT NOT NULL,                       -- reader | editor | co_author
  `invited_by_user_id`  TEXT REFERENCES `users`(`id`) ON DELETE SET NULL,
  `invited_at`          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  -- NULL = pending. Server populates on accept; declining deletes the row.
  `accepted_at`         INTEGER,
  PRIMARY KEY (`story_id`, `user_id`)
);
--> statement-breakpoint

-- Per-user lookup powers the "Stories I collaborate on" surface plus
-- the pending-invite indicator.
CREATE INDEX IF NOT EXISTS `story_collaborators_user_idx`
  ON `story_collaborators` (`user_id`, `invited_at`);
--> statement-breakpoint

-- Per-story lookup is the owner's "manage collaborators" surface.
CREATE INDEX IF NOT EXISTS `story_collaborators_story_idx`
  ON `story_collaborators` (`story_id`, `accepted_at`);
