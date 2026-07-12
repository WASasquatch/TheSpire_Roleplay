-- Usergroup badges: per-group opt-in to render the group as a badge chip in
-- the server userlist (group name tinted with the group color, next to the
-- staff chip). Default OFF so untouched servers keep byte-identical userlist
-- payloads; owners flip it per group in the console's group editor. The badge
-- is a chip only — name styling stays a purchasable cosmetic.
ALTER TABLE `server_usergroups` ADD COLUMN `show_badge` integer NOT NULL DEFAULT 0;
