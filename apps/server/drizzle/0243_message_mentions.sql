-- Resolved @mention snapshot per chat/forum message. When the composer inserts
-- an identity token (@id:<userId> / @cid:<characterId>), the server resolves it
-- to the exact identity, rewrites the body to plain @<displayName>, and stores
-- the resolved ids here as a JSON array of { name, userId, characterId }. Lets
-- the renderer open the right profile on click and highlight self-mentions by
-- id instead of by a name two identities might share. Null on messages with no
-- token mentions (plain typed @name still resolves by name as before).
ALTER TABLE `messages` ADD COLUMN `mentions_json` TEXT;
