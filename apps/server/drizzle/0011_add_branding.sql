ALTER TABLE `site_settings` ADD `site_name` text DEFAULT 'The Spire' NOT NULL;
--> statement-breakpoint
ALTER TABLE `site_settings` ADD `banner_cover_css` text;
--> statement-breakpoint
ALTER TABLE `site_settings` ADD `logo_color` text;
--> statement-breakpoint
ALTER TABLE `site_settings` ADD `logo_font` text;
