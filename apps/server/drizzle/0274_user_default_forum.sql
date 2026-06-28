-- Default forum (migration 0274).
--
-- The forum the catalog lands on when opened without an explicit deep-link.
-- Account-wide and synced across devices (set from the Forums toolbar star).
-- NULL = no preference (falls back to the system forum). A stale id (forum
-- deleted) is harmless — the client ignores ids not in the viewer's list.
ALTER TABLE `users` ADD COLUMN `default_forum_id` TEXT;
