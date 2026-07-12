-- Server <-> world link. `servers.world_id` points a community at the lore
-- world it brands itself with:
--   - server payloads (catalog / detail / public landing) surface it as a
--     `world` ref, resolved per viewer through the world's own visibility
--     gates, so a private/unlisted world never leaks its name;
--   - rooms with NO explicit room_world_links row inherit it for the chat
--     world banner (an explicit room link always wins).
-- NULL = no community world (behavior identical to before this column).
-- ON DELETE SET NULL so deleting the world simply unlinks it.
ALTER TABLE `servers` ADD COLUMN `world_id` text REFERENCES worlds(id) ON DELETE SET NULL;
