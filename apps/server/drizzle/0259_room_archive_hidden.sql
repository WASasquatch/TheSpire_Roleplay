-- "Hide from my list" for archived rooms (migration 0259).
--
-- Lets a room's owner dismiss one of their ARCHIVED rooms from the "My Rooms"
-- list / `/myrooms` command (e.g. a typo room they never meant to create)
-- WITHOUT destroying it. The archived row stays put; this only excludes it
-- from listArchivedOwnedRooms. Cleared when the room is resurrected via
-- `/go <name>`, so a recreated room reappears in the list if it re-archives.
ALTER TABLE rooms ADD COLUMN archive_hidden_at INTEGER;
