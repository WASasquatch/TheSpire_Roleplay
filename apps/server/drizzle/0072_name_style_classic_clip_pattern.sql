-- Switch name-style CSS to the classic background-clip-text pattern.
--
-- 0071 used `color: transparent` + `paint-order: stroke fill`. Combo
-- didn't composite correctly in every browser, `paint-order`
-- interaction with `background-clip: text` made the fill (gradient)
-- get skipped, leaving the text rendering as a solid dark mass
-- instead of as a gradient mask.
--
-- This migration switches to the well-documented pattern:
--
--   background: linear-gradient(...);
--   -webkit-background-clip: text;
--   background-clip: text;
--   -webkit-text-fill-color: transparent;     <-- makes glyph fill transparent
--   -webkit-text-stroke: 1px <outline-color>; <-- thin outline
--
-- No `color: transparent` and no `paint-order`. The fill color
-- declaration controls glyph rendering directly; without
-- `paint-order` the stroke + fill composite in the default order
-- (fill first, then stroke), which means the gradient shows
-- through and the outline overlays the gradient edge.
--
-- Also: trust the user's literal colors (StyledName no longer
-- applies the legibleAgainstBg contrast walk). For the dashboard
-- preview's hardcoded `#ff7a45` / `#ffb47a`, this means the
-- gradient renders as ACTUAL bright orange instead of the muted
-- dark variants the contrast walk was producing.

UPDATE `name_styles`
   SET `style_css` = '.ns-gradient { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.9)); }'
 WHERE `key` = 'gradient';
--> statement-breakpoint

UPDATE `name_styles`
   SET `style_css` = '.ns-gradient-shadow { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.95)); filter: drop-shadow(2px 3px 2px rgba(0,0,0,0.6)); }'
 WHERE `key` = 'gradient_shadow';
--> statement-breakpoint

UPDATE `name_styles`
   SET `style_css` = '.ns-gradient-glow { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.9)); filter: drop-shadow(0 0 4px var(--user-glow, rgba(255,170,80,0.9))) drop-shadow(0 0 10px var(--user-glow, rgba(255,170,80,0.7))); }'
 WHERE `key` = 'gradient_glow';
--> statement-breakpoint

UPDATE `name_styles`
   SET `style_css` = '.ns-gradient-sg { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 2px var(--user-outline, rgba(0,0,0,0.95)); filter: drop-shadow(2px 3px 2px rgba(0,0,0,0.7)) drop-shadow(0 0 8px var(--user-glow, rgba(255,170,80,0.8))); }'
 WHERE `key` = 'gradient_shadow_glow';
--> statement-breakpoint

-- Pulse stays as SOLID color (no clip-text needed). Outline +
-- breathing glow remain.
UPDATE `name_styles`
   SET `style_css` = '.ns-pulse { color: var(--user-color-1, currentColor); -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.85)); animation: ns-pulse 1.8s ease-in-out infinite; } @keyframes ns-pulse { 0%, 100% { filter: drop-shadow(0 0 1px var(--user-glow, rgba(255,170,80,0.7))); } 50% { filter: drop-shadow(0 0 8px var(--user-glow, rgba(255,170,80,1))) drop-shadow(0 0 16px var(--user-glow, rgba(255,170,80,0.85))) drop-shadow(0 0 24px var(--user-glow, rgba(255,170,80,0.6))); } }'
 WHERE `key` = 'pulsing';
--> statement-breakpoint

UPDATE `name_styles`
   SET `style_css` = '.ns-pan { background: linear-gradient(90deg, var(--user-color-1, currentColor) 0%, var(--user-color-2, currentColor) 25%, var(--user-glow, currentColor) 50%, var(--user-color-2, currentColor) 75%, var(--user-color-1, currentColor) 100%); background-size: 400% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.9)); animation: ns-pan 5s linear infinite; filter: drop-shadow(0 0 4px var(--user-glow, rgba(255,170,80,0.5))); } @keyframes ns-pan { from { background-position: 0% 50%; } to { background-position: 400% 50%; } }'
 WHERE `key` = 'panning_gradient';
