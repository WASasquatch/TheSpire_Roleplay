-- Master toggle for surfacing live community activity. When OFF (default
-- during cold-start), the splash hides the user/room counters and any
-- future activity rails so an empty community doesn't telegraph "this
-- place is dead" to first-time visitors. Admin flips it on once there's
-- a real pulse worth surfacing.
ALTER TABLE `site_settings` ADD `activity_feeds_enabled` integer NOT NULL DEFAULT 0;
