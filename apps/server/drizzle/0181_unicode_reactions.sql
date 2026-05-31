-- Unicode-emoji reactions.
--
-- Until now `message_reactions` stored a strict (sheet_id, cell_index)
-- pair for every reaction — sheet-only. This migration widens the
-- table so a reaction can EITHER reference a sheet cell (the legacy
-- shape, untouched) OR carry a raw Unicode codepoint string (the new
-- shape, used when a user picks an emoji from the Unicode tab in the
-- picker).
--
-- Design:
--   * `sheet_id` + `cell_index` become NULLABLE so Unicode-only rows
--     can leave them unset.
--   * `unicode_char` is a new nullable TEXT column. We cap to 16
--     characters because some emoji are compound codepoints (skin-tone
--     + ZWJ + base + variant selector) and 16 chars covers every
--     entry in the Unicode 15 RGI sequence catalog with headroom.
--   * Exactly ONE of `sheet_id` / `unicode_char` should be set per
--     row. SQLite doesn't enforce a "one or the other" constraint
--     cleanly without trigger noise, so we rely on the app layer to
--     police it and on the new unique index below to dedupe.
--
-- Index strategy:
--   The legacy unique index keyed on (target_kind, target_id, user_id,
--   sheet_id, cell_index) to enforce "one user, one (sheet, cell), one
--   target." Now we need the same dedupe but across either ref kind.
--   The cleanest way: drop the old index, create a new one keyed on a
--   normalized "ref key" expression: COALESCE the unicode_char into a
--   string column the index can compute. SQLite supports expression
--   indexes, so the unique key becomes
--     (target_kind, target_id, user_id, COALESCE(sheet_id || ':' || cell_index, unicode_char))
--
-- Forward-compat: every existing row stays valid — they keep their
-- sheet_id / cell_index, their unicode_char is NULL, the new index
-- normalizes them to "sheet_id:cell_index" which is the same shape
-- the old index was keyed on (just collapsed into one column).

-- Drop the orphan-cleanup triggers from migration 0146 before we
-- start the table rebuild. Both triggers reference
-- `message_reactions` in their DELETE bodies; SQLite validates
-- trigger bodies on table-drop and fails the whole migration if the
-- referenced table briefly vanishes. We recreate both at the end so
-- the cascade behavior is preserved across the rebuild.
DROP TRIGGER IF EXISTS `cascade_reactions_on_message_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cascade_reactions_on_dm_delete`;
--> statement-breakpoint

-- SQLite doesn't support ALTER COLUMN to drop NOT NULL directly. We
-- rebuild the table via the standard "create new, copy, swap, drop"
-- dance.
CREATE TABLE `message_reactions_new` (
  `id` TEXT PRIMARY KEY,
  `target_kind` TEXT NOT NULL,
  `target_id` TEXT NOT NULL,
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `character_id` TEXT REFERENCES `characters`(`id`) ON DELETE SET NULL,
  `display_name` TEXT NOT NULL,
  -- The legacy sheet ref. Now nullable; the app sets these when the
  -- reaction comes from a sheet pick.
  `sheet_id` TEXT REFERENCES `emoticon_sheets`(`id`) ON DELETE CASCADE,
  `cell_index` INTEGER,
  -- The new Unicode ref. Set when the reaction comes from the
  -- Unicode-emoji tab in the picker. Capped at 16 chars so a hostile
  -- client can't dump arbitrary JSON-as-emoji.
  `unicode_char` TEXT,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

INSERT INTO `message_reactions_new` (
  `id`, `target_kind`, `target_id`, `user_id`, `character_id`,
  `display_name`, `sheet_id`, `cell_index`, `unicode_char`, `created_at`
)
SELECT
  `id`, `target_kind`, `target_id`, `user_id`, `character_id`,
  `display_name`, `sheet_id`, `cell_index`, NULL, `created_at`
FROM `message_reactions`;
--> statement-breakpoint

DROP TABLE `message_reactions`;
--> statement-breakpoint

ALTER TABLE `message_reactions_new` RENAME TO `message_reactions`;
--> statement-breakpoint

-- Recreate the support indexes. The unique one uses an expression
-- that normalizes the two ref shapes into one comparable string,
-- which is what gives us the "one user, one emoji, one target"
-- semantics across both legacy + Unicode entries.
CREATE UNIQUE INDEX `message_reactions_uniq` ON `message_reactions` (
  `target_kind`,
  `target_id`,
  `user_id`,
  COALESCE(`sheet_id` || ':' || `cell_index`, `unicode_char`)
);
--> statement-breakpoint
CREATE INDEX `message_reactions_target_idx` ON `message_reactions` (`target_kind`, `target_id`);
--> statement-breakpoint
CREATE INDEX `message_reactions_user_idx` ON `message_reactions` (`user_id`);
--> statement-breakpoint

-- Recreate the orphan-cleanup triggers from migration 0146. Verbatim
-- copy of the original bodies — the rebuild didn't change the
-- semantics, only the column shape, and `target_kind` + `target_id`
-- are still the columns the cascade keys on.
CREATE TRIGGER `cascade_reactions_on_message_delete`
AFTER DELETE ON `messages`
FOR EACH ROW
BEGIN
  DELETE FROM `message_reactions`
   WHERE `target_kind` = 'chat_message'
     AND `target_id` = OLD.`id`;
END;
--> statement-breakpoint

CREATE TRIGGER `cascade_reactions_on_dm_delete`
AFTER DELETE ON `direct_messages`
FOR EACH ROW
BEGIN
  DELETE FROM `message_reactions`
   WHERE `target_kind` = 'dm'
     AND `target_id` = OLD.`id`;
END;
