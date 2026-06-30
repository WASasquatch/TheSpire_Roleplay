-- Servers Lift: owner-set top-bar banner height (px). Some banners read better
-- taller/shorter than the default, so let owners tune the height of the banner
-- band in the top bar. NULL = the default responsive height. Additive/nullable
-- — flag-off and existing servers are unaffected.
ALTER TABLE `servers` ADD COLUMN `banner_height` integer;
