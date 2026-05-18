-- Soften the existing glow widths and add a "Billboard" name style.
--
-- 1. Halve every drop-shadow blur radius on the glow-bearing styles.
--    The original 8px / 10px / 16px / 24px stack reads as a fuzzy halo
--    that overwhelms the glyph it's supposed to highlight, especially
--    on dark themes where the bloom blends into the bg. 4px / 5px /
--    8px / 12px keeps the breathing motion on pulse and the bloom on
--    the gradient family without smothering the letters.
--
-- 2. Add `billboard` — solid-color fill with a WHITE outline and a
--    drop-shadow stack underneath. Pairs the marquee/jersey-numeral
--    feel with the existing dark-outline family so users have an
--    actual visual contrast option, not just six variants of the same
--    aesthetic. Uses `paint-order: stroke fill` so the outline sits
--    behind the fill instead of bleeding over the glyph edges — safe
--    here because this style does NOT use background-clip text (which
--    is what made paint-order break in 0072).

UPDATE `name_styles`
   SET `style_css` = '.ns-gradient-glow { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.9)); filter: drop-shadow(0 0 2px var(--user-glow, rgba(255,170,80,0.9))) drop-shadow(0 0 5px var(--user-glow, rgba(255,170,80,0.7))); }'
 WHERE `key` = 'gradient_glow';
--> statement-breakpoint

UPDATE `name_styles`
   SET `style_css` = '.ns-gradient-sg { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 2px var(--user-outline, rgba(0,0,0,0.95)); filter: drop-shadow(2px 3px 2px rgba(0,0,0,0.7)) drop-shadow(0 0 4px var(--user-glow, rgba(255,170,80,0.8))); }'
 WHERE `key` = 'gradient_shadow_glow';
--> statement-breakpoint

UPDATE `name_styles`
   SET `style_css` = '.ns-pulse { color: var(--user-color-1, currentColor); -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.85)); animation: ns-pulse 1.8s ease-in-out infinite; } @keyframes ns-pulse { 0%, 100% { filter: drop-shadow(0 0 1px var(--user-glow, rgba(255,170,80,0.7))); } 50% { filter: drop-shadow(0 0 4px var(--user-glow, rgba(255,170,80,1))) drop-shadow(0 0 8px var(--user-glow, rgba(255,170,80,0.85))) drop-shadow(0 0 12px var(--user-glow, rgba(255,170,80,0.6))); } }'
 WHERE `key` = 'pulsing';
--> statement-breakpoint

UPDATE `name_styles`
   SET `style_css` = '.ns-pan { background: linear-gradient(90deg, var(--user-color-1, currentColor) 0%, var(--user-color-2, currentColor) 25%, var(--user-glow, currentColor) 50%, var(--user-color-2, currentColor) 75%, var(--user-color-1, currentColor) 100%); background-size: 400% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.9)); animation: ns-pan 5s linear infinite; filter: drop-shadow(0 0 2px var(--user-glow, rgba(255,170,80,0.5))); } @keyframes ns-pan { from { background-position: 0% 50%; } to { background-position: 400% 50%; } }'
 WHERE `key` = 'panning_gradient';
--> statement-breakpoint

INSERT OR IGNORE INTO `name_styles`
  (`key`, `name`, `description`, `template`, `style_css`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('billboard',
   'Billboard',
   'Solid color with a bright outline and a soft drop shadow. Reads like a stage marquee or jersey number.',
   '<span class="ns-billboard">{username}</span>',
   '.ns-billboard { color: var(--user-color-1, currentColor); -webkit-text-stroke: 2px var(--user-outline, rgba(255,255,255,0.95)); paint-order: stroke fill; filter: drop-shadow(2px 3px 3px rgba(0,0,0,0.85)) drop-shadow(0 0 6px rgba(0,0,0,0.5)); }',
   4500, 1, 1, 7);
