-- Free a deleted character's name for reuse (migration 0262).
--
-- Character deletion is a SOFT delete (sets deleted_at; history rows still
-- resolve the snapshotted name). But `characters_user_name_uq` was a plain
-- unique index on (user_id, lower(name)) that included soft-deleted rows, so
-- recreating a character with a just-deleted name collided at the DB level
-- and surfaced as a 500 "internal error" (the app-level dup check correctly
-- ignores soft-deleted rows, so it passed, then the INSERT threw).
--
-- Rebuild the index as PARTIAL (WHERE deleted_at IS NULL) so only LIVE
-- characters reserve a name. A deleted name is immediately available again,
-- while two live characters with the same name per account stay blocked.
DROP INDEX IF EXISTS `characters_user_name_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `characters_user_name_uq`
  ON `characters` (`user_id`, lower("name"))
  WHERE `deleted_at` IS NULL;
