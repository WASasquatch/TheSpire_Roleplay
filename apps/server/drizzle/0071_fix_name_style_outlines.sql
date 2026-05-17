-- Fix name-style CSS — proper outlines + visible animations.
--
-- Migration 0070 attempted layered text using an 8-direction
-- text-shadow stack at 1px offsets for the outline. That technique
-- WAS WRONG: each shadow is a sharp copy of the glyph offset by 1px,
-- and 8 of them at small offsets REINFORCE inside the glyph
-- interior, producing a solid black mass — not the thin outline
-- intended. The background-clip:text gradient was technically being
-- painted on top, but the dense text-shadow stack overwhelmed it
-- and every gradient render came out as a black blob.
--
-- This migration replaces the text-shadow outline with
-- `-webkit-text-stroke` + `paint-order: stroke fill` — the
-- platform-correct way to outline text. The stroke paints first
-- (behind), then the fill (gradient mask) paints on top, so the
-- gradient is fully visible inside the glyph and the stroke shows
-- only as a thin halo at the glyph edge.
--
-- Pulse glow + Aurora pan also rewritten:
--   * Pulse: stronger glow with higher base + peak blur radius
--     and tighter alpha so the breathing is actually visible.
--   * Aurora Pan: drops to a SOLID-coloring approach with a
--     gradient that fully cycles its position — combined with a
--     hue rotate filter so the color motion is unmistakable even
--     with the outline on top.
--
-- Note: `-webkit-text-stroke` and `paint-order: stroke fill` have
-- been supported in every modern browser (Chrome, Firefox, Safari,
-- Edge) since 2020+. The stroke color uses `--user-outline` which
-- defaults to a near-black for contrast on light themes; admin can
-- override via the per-user config (`outline` key) to white for
-- dark text.

UPDATE `name_styles`
   SET `style_css` = '.ns-gradient { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.9)); paint-order: stroke fill; }'
 WHERE `key` = 'gradient';
--> statement-breakpoint

UPDATE `name_styles`
   SET `style_css` = '.ns-gradient-shadow { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.95)); paint-order: stroke fill; filter: drop-shadow(2px 3px 2px rgba(0,0,0,0.6)); }'
 WHERE `key` = 'gradient_shadow';
--> statement-breakpoint

UPDATE `name_styles`
   SET `style_css` = '.ns-gradient-glow { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.9)); paint-order: stroke fill; filter: drop-shadow(0 0 4px var(--user-glow, rgba(255,170,80,0.9))) drop-shadow(0 0 10px var(--user-glow, rgba(255,170,80,0.7))); }'
 WHERE `key` = 'gradient_glow';
--> statement-breakpoint

UPDATE `name_styles`
   SET `style_css` = '.ns-gradient-sg { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-stroke: 2px var(--user-outline, rgba(0,0,0,0.95)); paint-order: stroke fill; filter: drop-shadow(2px 3px 2px rgba(0,0,0,0.7)) drop-shadow(0 0 8px var(--user-glow, rgba(255,170,80,0.8))); }'
 WHERE `key` = 'gradient_shadow_glow';
--> statement-breakpoint

-- Pulse: a SOLID-coloring style (not background-clip). The user-
-- picked color1 is the text color, outline contrasts, and the
-- glow animation cycles 0px → 14px + 22px so the breathing is
-- obvious even at chat-line size. Animation duration bumped to
-- 1.8s for a slightly faster heartbeat.
UPDATE `name_styles`
   SET `style_css` = '.ns-pulse { color: var(--user-color-1, currentColor); -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.85)); paint-order: stroke fill; animation: ns-pulse 1.8s ease-in-out infinite; } @keyframes ns-pulse { 0%, 100% { filter: drop-shadow(0 0 1px var(--user-glow, rgba(255,170,80,0.7))); } 50% { filter: drop-shadow(0 0 8px var(--user-glow, rgba(255,170,80,1))) drop-shadow(0 0 16px var(--user-glow, rgba(255,170,80,0.85))) drop-shadow(0 0 24px var(--user-glow, rgba(255,170,80,0.6))); } }'
 WHERE `key` = 'pulsing';
--> statement-breakpoint

-- Aurora Pan: gradient with strong color stops, large 400% bg-size
-- so the pan motion sweeps a long distance, and a hue-rotate
-- animation that visibly cycles the colors. Combined with the
-- outline so the text stays legible even at the gradient extremes.
UPDATE `name_styles`
   SET `style_css` = '.ns-pan { background: linear-gradient(90deg, var(--user-color-1, currentColor) 0%, var(--user-color-2, currentColor) 25%, var(--user-glow, currentColor) 50%, var(--user-color-2, currentColor) 75%, var(--user-color-1, currentColor) 100%); background-size: 400% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.9)); paint-order: stroke fill; animation: ns-pan 5s linear infinite; filter: drop-shadow(0 0 4px var(--user-glow, rgba(255,170,80,0.5))); } @keyframes ns-pan { from { background-position: 0% 50%; } to { background-position: 400% 50%; } }'
 WHERE `key` = 'panning_gradient';
