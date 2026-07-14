-- World map uploads switch. When ON, the world-map create/edit routes accept
-- a base64 image data URL (PNG/JPG/WEBP/GIF only, 6MB cap, per-world quota)
-- and store the file under /uploads/worldmaps/<worldId>/. Default OFF: the
-- hosting volume is small and shared with the database, so storing member
-- images on it is an explicit admin opt-in; external https links stay the
-- default path either way.
ALTER TABLE `site_settings` ADD COLUMN `world_map_uploads_enabled` integer NOT NULL DEFAULT 0;
