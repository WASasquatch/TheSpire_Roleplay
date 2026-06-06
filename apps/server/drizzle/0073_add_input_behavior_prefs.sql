-- Per-user input-behavior toggles. Both default off (= feature stays on)
-- so existing users keep the same experience until they opt out.
--
--   disable_input_history, kills the ArrowUp/ArrowDown command-history
--                           recall in the chat composer. Some users keep
--                           hitting ArrowUp by accident while moving the
--                           cursor and want the feature gone entirely.
--   disable_thesaurus    , kills the synonym popup that opens when a
--                           word is highlighted. Surprising to users who
--                           highlight text just to copy it.
ALTER TABLE users ADD COLUMN disable_input_history INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN disable_thesaurus INTEGER NOT NULL DEFAULT 0;
