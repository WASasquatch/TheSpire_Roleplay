-- Per-edit timestamp for the welcome message. The visibility rule is now
-- "only show to users who registered AFTER this welcome was last saved",
-- so we need to know when the welcome's text was last set independently
-- of the broader site_settings.updated_at (which moves on every admin save
-- of any setting).
--
-- Null = welcome has never been set (or was just cleared). In either case
-- the modal is suppressed: there's nothing to show, OR there's no
-- reference point for "registered after".

ALTER TABLE `site_settings`
  ADD COLUMN `new_user_welcome_updated_at` integer;
