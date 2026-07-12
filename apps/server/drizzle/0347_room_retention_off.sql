-- Message lifetime "never expire". `rooms.retention_exempt` opts a room out
-- of BOTH janitor passes (the server retention window AND the per-room
-- `message_expiry_minutes` sweep), so info/lore rooms keep their history
-- forever. A separate boolean rather than a `0` sentinel on
-- `message_expiry_minutes`: several sites truthy-check that column
-- (`> 0` in RoomInfoBar / the chat header strip / the janitor), so a
-- sentinel would silently read as "inherit the server retention window".
ALTER TABLE `rooms` ADD COLUMN `retention_exempt` integer NOT NULL DEFAULT 0;
