-- Tracks which iteration of the DEFAULT_WORLDS seed has been applied to the
-- system-owned worlds. The seed loop compares this value against the
-- SEED_VERSION constant in seed_worlds.ts; when the constant is higher, the
-- loop overwrites all system worlds (name, description, pages) and bumps the
-- stored version. Lets us ship content updates to the default worlds
-- without forcing admins to do anything manual on the next deploy.
--
-- 0 means "never seeded with versioning" — first-version content is treated
-- as v1 implicitly, so existing installs jump straight to whatever the
-- current code-side SEED_VERSION says.
ALTER TABLE `site_settings`
  ADD COLUMN `worlds_seed_version` integer NOT NULL DEFAULT 0;
