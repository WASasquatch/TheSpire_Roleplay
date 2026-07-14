-- Splash "Beta" badge toggle.
--
-- site_settings.beta_badge_enabled: when on, the anonymous splash hero wears
-- a small "Beta" chip plus a one-line "young and growing" note. The /site
-- payload ANDs this with a version gate (app version < 1.0.0, SemVer order),
-- so the badge retires itself the moment a 1.0.0 build ships regardless of
-- the toggle. Default ON: the version gate is the real off-switch, and a
-- pre-1.0 install should read as beta out of the box.
ALTER TABLE `site_settings` ADD COLUMN `beta_badge_enabled` INTEGER NOT NULL DEFAULT 1;
