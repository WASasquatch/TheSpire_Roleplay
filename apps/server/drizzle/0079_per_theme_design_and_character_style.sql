-- Per-character design override + per-theme design map.
--
-- 1. `characters.style_key` — same shape as `users.style_key`.
--    Lets a character carry its own design override (medieval / modern /
--    scifi). Null = inherit from the user/master (or the theme-pinned
--    design, or the site default). Mirrors how `characters.theme_json`
--    already overrides the palette per character.
--
-- 2. `site_settings.theme_design_map` — JSON object keyed by THEME PRESET
--    NAME (e.g. {"Parchment":"medieval","Twilight":"scifi"}). When a
--    user's active palette matches a preset, the renderer picks up that
--    preset's pinned design unless the user has explicitly overridden.
--    Resolution priority (highest wins):
--       character.style_key
--       user.style_key
--       theme_design_map[<active preset name>]
--       site_settings.default_style_key
--       "medieval" (hardcoded fallback)
--    Null on the column = empty map (fall through to default_style_key).
--
-- The seed map below mirrors the THEME_PRESETS in
-- packages/shared/src/theme.ts. Admins can edit the map via /admin
-- without redeploying.

ALTER TABLE `characters` ADD COLUMN `style_key` TEXT;
--> statement-breakpoint

ALTER TABLE `site_settings` ADD COLUMN `theme_design_map` TEXT;
--> statement-breakpoint

UPDATE `site_settings`
   SET `theme_design_map` = '{"Parchment":"medieval","Twilight":"scifi","Forest":"medieval","Ember":"medieval","Ocean":"scifi","Slate":"modern"}'
 WHERE `id` = 'singleton'
   AND `theme_design_map` IS NULL;
