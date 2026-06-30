-- Per-server EARNING SUBSYSTEM toggles. NULL = inherit the platform default
-- (= enabled). A server owner can disable a whole earning subsystem for their
-- server; its catalog section hides and purchases reject. Part of the
-- "nothing stays global — everything per-server" earning build.
ALTER TABLE server_settings ADD COLUMN shop_enabled INTEGER;
ALTER TABLE server_settings ADD COLUMN ranks_enabled INTEGER;
ALTER TABLE server_settings ADD COLUMN name_styles_enabled INTEGER;
ALTER TABLE server_settings ADD COLUMN borders_enabled INTEGER;
ALTER TABLE server_settings ADD COLUMN room_transitions_enabled INTEGER;
ALTER TABLE server_settings ADD COLUMN cosmetics_enabled INTEGER;
