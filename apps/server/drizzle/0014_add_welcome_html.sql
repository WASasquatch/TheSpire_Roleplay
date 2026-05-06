-- Admin-configurable welcome message rendered above the login/register form
-- on the splash screen. Sanitized HTML — same allow-list as profile bios.
ALTER TABLE `site_settings` ADD `welcome_html` text NOT NULL DEFAULT '';
