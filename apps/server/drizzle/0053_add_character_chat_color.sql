-- Per-character chat color. Null means "fall back to the master account's
-- chat_color." When the user is in-character, /color writes here so the
-- color picker on Character A stays distinct from Character B even when
-- both belong to the same master account.
ALTER TABLE characters ADD COLUMN chat_color TEXT;
