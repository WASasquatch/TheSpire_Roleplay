-- Theme style axis. Orthogonal to the existing palette (`themeJson`):
-- where palette controls WHICH colors the UI uses, style controls what
-- visual treatment those colors get applied through (medieval frame,
-- modern soft gradient, scifi neon glass, etc.).
--
-- Two new fields:
--   * `site_settings.default_style_key`, the styleKey new users / users
--     who haven't picked an override inherit. Defaults to 'medieval'
--     which is the flagship style.
--   * `users.style_key`, per-user override. Null means "follow the
--     site default". The client resolves user > site > hard-coded
--     fallback in that order.
ALTER TABLE `site_settings` ADD COLUMN `default_style_key` text NOT NULL DEFAULT 'medieval';
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `style_key` text;
