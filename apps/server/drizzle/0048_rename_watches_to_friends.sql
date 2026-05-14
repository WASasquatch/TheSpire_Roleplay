-- Friends rename. The previous `watches` table held an asymmetric
-- "presence I care about" relationship — the rename is presentational
-- (semantics are unchanged, still asymmetric, still composite PK) so
-- the existing rows port over without any data transformation. Slash
-- commands /watch + /unwatch + /watching stay around as aliases for
-- the new /friend family so muscle memory and existing tutorials
-- don't break.
ALTER TABLE watches RENAME TO friends;
ALTER TABLE friends RENAME COLUMN watcher_user_id TO friender_user_id;
ALTER TABLE friends RENAME COLUMN watched_user_id TO friended_user_id;
DROP INDEX IF EXISTS watches_watched_idx;
CREATE INDEX friends_friended_idx ON friends (friended_user_id);
