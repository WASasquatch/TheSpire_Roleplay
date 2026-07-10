-- Linked SFW/18+ room pairs: an 18+ "annex" room points at its SFW base
-- room. Linked annexes are hidden from the room rail and reached through a
-- SFW/18+ toggle on the base room's row, so an 18+ variant of a room no
-- longer doubles the room list. The pointer lives only on the annex side;
-- the base's reverse pointer is computed at read time. ON DELETE SET NULL:
-- deleting the base dissolves the pair.
ALTER TABLE `rooms` ADD COLUMN `linked_room_id` text REFERENCES rooms(id) ON DELETE SET NULL;
