-- Emoticon system, sticker-sheet based reactions for chat, DMs, and
-- (future) forum posts.
--
-- Sheets are 4×4 grids (16 cells); each cell carries a label. Cells
-- with an "empty" / blank label are hidden from the picker but still
-- exist in the grid so admins can fill them in later without
-- renumbering existing reactions.
--
-- Reactions are POLYMORPHIC: `target_kind` selects which entity the
-- reaction is attached to ('chat_message' for messages.id, 'dm' for
-- direct_messages.id, 'forum_post' reserved for when the forum
-- lands). DB-level FKs would have to fan out across three tables;
-- instead we rely on the app to validate `target_id` against the
-- right table on insert, and on a target-side cascade trigger (or
-- best-effort cleanup on delete) to remove orphan reactions.
--
-- Uniqueness: (target_kind, target_id, user_id, sheet_id, cell_index)
-- is the Discord rule, one user, one emoticon, one message. The
-- same user reacting with a DIFFERENT emoticon on the same message
-- inserts a separate row.

CREATE TABLE IF NOT EXISTS `emoticon_sheets` (
  `id`                TEXT NOT NULL PRIMARY KEY,
  -- Stable client-facing identifier. Picker chips use it; URL-safe so
  -- the picker can deep-link a specific sheet without leaking the
  -- opaque id. Unique across sheets.
  `slug`              TEXT NOT NULL UNIQUE,
  `name`              TEXT NOT NULL,
  -- Relative URL (e.g. /uploads/emoticons/<id>.png). Frontend
  -- compose the sprite's background-image from this. Seeded sheets
  -- point at /assets/emoticons/<file>.png (bundled in apps/web/public).
  `image_url`         TEXT NOT NULL,
  -- JSON array of EXACTLY 16 strings (4×4 grid, row-major). Empty
  -- string or the literal "empty" means "hide from picker." Stored
  -- as TEXT (json) instead of a separate cell table so the whole
  -- sheet round-trips in one query and the picker doesn't need a
  -- per-sheet join.
  `cells`             TEXT NOT NULL DEFAULT '["","","","","","","","","","","","","","","",""]',
  -- Display order in the picker. Lower = earlier. Defaults to a
  -- timestamp-flavored value so new uploads sort to the end.
  `sort_order`        INTEGER NOT NULL DEFAULT 0,
  `created_by_user_id` TEXT REFERENCES `users`(`id`) ON DELETE SET NULL,
  `created_at`        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at`        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `message_reactions` (
  `id`                TEXT NOT NULL PRIMARY KEY,
  -- 'chat_message' → messages.id ; 'dm' → direct_messages.id ;
  -- 'forum_post' reserved. App enforces the FK semantics; no DB
  -- constraint since SQLite can't conditional-FK on a discriminator.
  `target_kind`       TEXT NOT NULL,
  `target_id`         TEXT NOT NULL,
  `user_id`           TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  -- Identity snapshot at reaction time. Null = reacted as master
  -- handle. Set-null on character delete so the row survives a
  -- character cleanup the same way messages do.
  `character_id`      TEXT REFERENCES `characters`(`id`) ON DELETE SET NULL,
  -- Snapshotted display name at reaction time so a later rename
  -- doesn't rewrite who's listed in the tooltip.
  `display_name`      TEXT NOT NULL,
  `sheet_id`          TEXT NOT NULL REFERENCES `emoticon_sheets`(`id`) ON DELETE CASCADE,
  -- 0..15 row-major. App validates the cell isn't "empty" before
  -- accepting the insert.
  `cell_index`        INTEGER NOT NULL,
  `created_at`        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  -- Discord-style uniqueness: one user can register a given
  -- (sheet, cell) at most once per target. Re-reacting toggles off
  -- (DELETE) rather than INSERT-then-error.
  UNIQUE (`target_kind`, `target_id`, `user_id`, `sheet_id`, `cell_index`)
);
--> statement-breakpoint

-- Hot read path: "give me every reaction for this message", used
-- to render the ReactionBar under every visible chat / DM row.
CREATE INDEX IF NOT EXISTS `message_reactions_target_idx`
  ON `message_reactions` (`target_kind`, `target_id`);
--> statement-breakpoint

-- Defense-in-depth lookup: "what's this user's reaction history."
-- Rare but cheap to maintain.
CREATE INDEX IF NOT EXISTS `message_reactions_user_idx`
  ON `message_reactions` (`user_id`);
--> statement-breakpoint

-- Orphan-cleanup trigger when a chat message is deleted. SQLite
-- can't enforce a discriminated FK at the column level, so a
-- per-target trigger plays the cascade role. Mirror triggers below
-- for direct_messages.
CREATE TRIGGER IF NOT EXISTS `cascade_reactions_on_message_delete`
AFTER DELETE ON `messages`
FOR EACH ROW
BEGIN
  DELETE FROM `message_reactions`
   WHERE `target_kind` = 'chat_message'
     AND `target_id` = OLD.`id`;
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `cascade_reactions_on_dm_delete`
AFTER DELETE ON `direct_messages`
FOR EACH ROW
BEGIN
  DELETE FROM `message_reactions`
   WHERE `target_kind` = 'dm'
     AND `target_id` = OLD.`id`;
END;
