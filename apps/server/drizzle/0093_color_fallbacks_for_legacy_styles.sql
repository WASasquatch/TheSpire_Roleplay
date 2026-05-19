-- Give the original 6 name styles real color literal fallbacks
-- inside their var(--user-color-*, …) expressions, instead of
-- `currentColor`.
--
-- The 0072 migration shipped these styles with `currentColor` as
-- the fallback for every gradient stop. That worked fine for users
-- who'd purchased + configured the style (their --user-color-*
-- vars override the fallbacks) but made the admin Live Preview
-- and the Earning store's Available cards render monochrome — all
-- gradient stops collapsed to whatever the surrounding text color
-- happened to be, so Aurora Pan looked like a faint outlined word
-- instead of a tropical sliding gradient. Owned previews looked
-- right by coincidence: the config from the user's per-style picks
-- supplied the real colors.
--
-- Updating the fallbacks to warm-orange / fire-amber literals
-- (matching the original AvailableStyleCard preview palette) lets
-- the no-config preview pane render each style in its intended
-- look. Users who customize via the dashboard still override the
-- fallbacks with their own picks, so this only affects the
-- preview-without-config case.

UPDATE `name_styles`
   SET `style_css` = '.ns-gradient { background: linear-gradient(90deg, var(--user-color-1, #ff7a45), var(--user-color-2, #ffb47a)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.9)); }'
 WHERE `key` = 'gradient';
--> statement-breakpoint

UPDATE `name_styles`
   SET `style_css` = '.ns-gradient-shadow { background: linear-gradient(90deg, var(--user-color-1, #ff7a45), var(--user-color-2, #ffb47a)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.95)); filter: drop-shadow(2px 3px 2px rgba(0,0,0,0.6)); }'
 WHERE `key` = 'gradient_shadow';
--> statement-breakpoint

UPDATE `name_styles`
   SET `style_css` = '.ns-gradient-glow { background: linear-gradient(90deg, var(--user-color-1, #ff7a45), var(--user-color-2, #ffb47a)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.9)); filter: drop-shadow(0 0 2px var(--user-glow, rgba(255,170,80,0.9))) drop-shadow(0 0 5px var(--user-glow, rgba(255,170,80,0.7))); }'
 WHERE `key` = 'gradient_glow';
--> statement-breakpoint

UPDATE `name_styles`
   SET `style_css` = '.ns-gradient-sg { background: linear-gradient(90deg, var(--user-color-1, #ff7a45), var(--user-color-2, #ffb47a)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 2px var(--user-outline, rgba(0,0,0,0.95)); filter: drop-shadow(2px 3px 2px rgba(0,0,0,0.7)) drop-shadow(0 0 4px var(--user-glow, rgba(255,170,80,0.8))); }'
 WHERE `key` = 'gradient_shadow_glow';
--> statement-breakpoint

UPDATE `name_styles`
   SET `style_css` = '.ns-pulse { color: var(--user-color-1, #ff9966); -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.85)); animation: ns-pulse 1.8s ease-in-out infinite; } @keyframes ns-pulse { 0%, 100% { filter: drop-shadow(0 0 1px var(--user-glow, rgba(255,170,80,0.7))); } 50% { filter: drop-shadow(0 0 4px var(--user-glow, rgba(255,170,80,1))) drop-shadow(0 0 8px var(--user-glow, rgba(255,170,80,0.85))) drop-shadow(0 0 12px var(--user-glow, rgba(255,170,80,0.6))); } }'
 WHERE `key` = 'pulsing';
--> statement-breakpoint

UPDATE `name_styles`
   SET `style_css` = '.ns-pan { background: linear-gradient(90deg, var(--user-color-1, #ff7a45) 0%, var(--user-color-2, #ffb47a) 25%, var(--user-glow, #ffd28c) 50%, var(--user-color-2, #ffb47a) 75%, var(--user-color-1, #ff7a45) 100%); background-size: 400% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.9)); animation: ns-pan 5s linear infinite; filter: drop-shadow(0 0 2px var(--user-glow, rgba(255,170,80,0.5))); } @keyframes ns-pan { from { background-position: 0% 50%; } to { background-position: 400% 50%; } }'
 WHERE `key` = 'panning_gradient';
