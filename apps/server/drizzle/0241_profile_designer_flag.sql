-- Site toggle for the visual bio "Designer" (GrapesJS). Off by default; an
-- admin enables it once they've confirmed it behaves on their deploy. When
-- off, the bio editor stays the raw-HTML source textarea only.
ALTER TABLE `site_settings` ADD COLUMN `profile_designer_enabled` INTEGER NOT NULL DEFAULT 0;
