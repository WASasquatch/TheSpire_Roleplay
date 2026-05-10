-- Splash-page featured-worlds carousel toggle.
--
-- When enabled, the splash page renders a small carousel of up to 10
-- randomly-chosen open worlds, drawn from anyone's open worlds (including
-- the system-seeded defaults). Off by default to avoid surfacing a
-- thin/empty catalog on a brand-new install - same posture as
-- activity_feeds_enabled.

ALTER TABLE `site_settings`
  ADD COLUMN `featured_worlds_enabled` integer NOT NULL DEFAULT 0;
