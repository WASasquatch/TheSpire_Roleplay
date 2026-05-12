-- Consolidate the theme-style catalog from 9 sub-styles down to 3 family
-- roots: 'medieval', 'modern', 'scifi'. The sub-variants (parchment,
-- sandstone, wood, flat, glass, paper, cyberpunk, geiger, space-junk) were
-- distinguished by tiled textures, and once textures were removed they all
-- collapsed to the same border treatment. The 3 remaining keys are full
-- design languages (panels, buttons, headers, lists, etc.) rather than
-- texture flavors.
--
-- Per the consolidation plan, existing user picks are reset to NULL so
-- everyone falls back to the site default. The site default itself is
-- coerced to one of the three known roots — anything else maps to
-- 'medieval'.
UPDATE `users` SET `style_key` = NULL;
--> statement-breakpoint
UPDATE `site_settings` SET `default_style_key` = CASE
  WHEN `default_style_key` LIKE 'medieval%' THEN 'medieval'
  WHEN `default_style_key` LIKE 'modern%'   THEN 'modern'
  WHEN `default_style_key` LIKE 'scifi%'    THEN 'scifi'
  ELSE 'medieval'
END;
