-- Forums: per-forum DESIGN STYLE (ornaments/chrome — medieval, glass, …),
-- the second theming axis next to the palette in theme_json. Mirrors
-- users.style_key / characters.style_key: the forum's pages render with
-- the keeper's chosen design for every visitor, scoped to the modal via
-- buildOrnamentStyle (never touching the viewer's site-wide design).
ALTER TABLE `forums` ADD COLUMN `theme_style_key` TEXT;
