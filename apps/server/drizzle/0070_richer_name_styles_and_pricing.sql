-- Layered name-style CSS + exponential pricing tune-up.
--
-- The original six seeded name styles (migration 0065) used a single
-- background-clip-text gradient with optional drop-shadow. Visually
-- mediocre and hard to read on a busy chat line, the user feedback
-- was that the styles weren't worth buying at any price. This
-- migration replaces the CSS for each style with a richer treatment
-- that combines gradient masks with text-shadow outline stacks and
-- multiple stacked drop-shadow filters for layered glow effects.
-- Templates stay single-element (the StyledName fast-path parser
-- only handles `<tag class="...">{username}</tag>`); all the new
-- visual richness rides through CSS on the same shape.
--
-- Pricing also rebalanced exponentially. With message earns at 3
-- currency / chat line and presence at 1 / 5-min block, an active
-- user was earning ~250 currency/day and could buy every style
-- inside a week. The new prices stretch the top end out so the
-- ladder rewards months of engagement, not days. Border prices
-- get the same treatment on the tier-IV rank_tiers rows.
--
-- Existing owned rows are untouched, users who already purchased
-- a style at the old price keep ownership.

-- name_styles: richer CSS + new prices (keys + templates unchanged
-- so owned rows continue to resolve to a real catalog entry).
UPDATE `name_styles`
   SET `description` = 'Two-color gradient with a thin contrast outline for legibility.',
       `style_css` = '.ns-gradient { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: 1px 0 0 rgba(0,0,0,0.85), -1px 0 0 rgba(0,0,0,0.85), 0 1px 0 rgba(0,0,0,0.85), 0 -1px 0 rgba(0,0,0,0.85), 1px 1px 0 rgba(0,0,0,0.85), -1px -1px 0 rgba(0,0,0,0.85), 1px -1px 0 rgba(0,0,0,0.85), -1px 1px 0 rgba(0,0,0,0.85); paint-order: stroke fill; }',
       `cost` = 1500
 WHERE `key` = 'gradient';
--> statement-breakpoint

UPDATE `name_styles`
   SET `name` = 'Outlined Drop-shadow',
       `description` = 'Bold outline plus a soft drop shadow underneath. Reads cleanly on any background.',
       `style_css` = '.ns-gradient-shadow { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: 1px 0 0 rgba(0,0,0,0.9), -1px 0 0 rgba(0,0,0,0.9), 0 1px 0 rgba(0,0,0,0.9), 0 -1px 0 rgba(0,0,0,0.9), 1px 1px 0 rgba(0,0,0,0.9), -1px -1px 0 rgba(0,0,0,0.9), 1px -1px 0 rgba(0,0,0,0.9), -1px 1px 0 rgba(0,0,0,0.9); filter: drop-shadow(2px 2px 2px rgba(0,0,0,0.55)); paint-order: stroke fill; }',
       `cost` = 3500
 WHERE `key` = 'gradient_shadow';
--> statement-breakpoint

UPDATE `name_styles`
   SET `name` = 'Outlined Glow',
       `description` = 'Two-color gradient with a colored glow halo and a thin dark outline.',
       `style_css` = '.ns-gradient-glow { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: 1px 0 0 rgba(0,0,0,0.85), -1px 0 0 rgba(0,0,0,0.85), 0 1px 0 rgba(0,0,0,0.85), 0 -1px 0 rgba(0,0,0,0.85); filter: drop-shadow(0 0 4px var(--user-glow, rgba(255,170,80,0.7))) drop-shadow(0 0 8px var(--user-glow, rgba(255,170,80,0.5))); paint-order: stroke fill; }',
       `cost` = 7000
 WHERE `key` = 'gradient_glow';
--> statement-breakpoint

UPDATE `name_styles`
   SET `name` = 'Royal Embossed',
       `description` = 'Gradient with a deep drop shadow, colored glow halo, and a 2px contrast outline. Heaviest of the gradient family.',
       `style_css` = '.ns-gradient-sg { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: 1px 1px 0 rgba(0,0,0,0.95), -1px -1px 0 rgba(0,0,0,0.95), 1px -1px 0 rgba(0,0,0,0.95), -1px 1px 0 rgba(0,0,0,0.95), 2px 0 0 rgba(0,0,0,0.95), -2px 0 0 rgba(0,0,0,0.95), 0 2px 0 rgba(0,0,0,0.95), 0 -2px 0 rgba(0,0,0,0.95); filter: drop-shadow(2px 3px 2px rgba(0,0,0,0.6)) drop-shadow(0 0 6px var(--user-glow, rgba(255,170,80,0.6))); paint-order: stroke fill; }',
       `cost` = 18000
 WHERE `key` = 'gradient_shadow_glow';
--> statement-breakpoint

UPDATE `name_styles`
   SET `name` = 'Pulsing Glow',
       `description` = 'Solid color with an animated colored glow that breathes in and out.',
       `style_css` = '.ns-pulse { color: var(--user-color-1, currentColor); text-shadow: 1px 0 0 rgba(0,0,0,0.75), -1px 0 0 rgba(0,0,0,0.75), 0 1px 0 rgba(0,0,0,0.75), 0 -1px 0 rgba(0,0,0,0.75); animation: ns-pulse 2.6s ease-in-out infinite; paint-order: stroke fill; } @keyframes ns-pulse { 0%, 100% { filter: drop-shadow(0 0 2px var(--user-glow, rgba(255,170,80,0.6))); } 50% { filter: drop-shadow(0 0 9px var(--user-glow, rgba(255,170,80,0.95))) drop-shadow(0 0 14px var(--user-glow, rgba(255,170,80,0.6))); } }',
       `cost` = 5000
 WHERE `key` = 'pulsing';
--> statement-breakpoint

UPDATE `name_styles`
   SET `name` = 'Aurora Pan',
       `description` = 'Three-stop gradient that slowly slides across the name with a contrast outline and ambient glow.',
       `style_css` = '.ns-pan { background: linear-gradient(90deg, var(--user-color-1, currentColor) 0%, var(--user-color-2, currentColor) 50%, var(--user-color-1, currentColor) 100%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: 1px 0 0 rgba(0,0,0,0.85), -1px 0 0 rgba(0,0,0,0.85), 0 1px 0 rgba(0,0,0,0.85), 0 -1px 0 rgba(0,0,0,0.85); filter: drop-shadow(0 0 5px var(--user-glow, rgba(255,170,80,0.5))); animation: ns-pan 7s linear infinite; paint-order: stroke fill; } @keyframes ns-pan { from { background-position: 0% 50%; } to { background-position: 200% 50%; } }',
       `cost` = 25000
 WHERE `key` = 'panning_gradient';
--> statement-breakpoint

-- rank_tiers: tier-IV border costs rebalanced exponentially. The
-- prior 100 / 250 / 500 / 1000 / 2000 / 5000 progression let an
-- active user buy a few borders in a week. The new curve makes the
-- top borders aspirational, months of engagement rather than days.
UPDATE `rank_tiers` SET `border_cost` = 5000   WHERE `id` = 'rt_new_arrival_4';
--> statement-breakpoint
UPDATE `rank_tiers` SET `border_cost` = 15000  WHERE `id` = 'rt_active_4';
--> statement-breakpoint
UPDATE `rank_tiers` SET `border_cost` = 40000  WHERE `id` = 'rt_recognized_4';
--> statement-breakpoint
UPDATE `rank_tiers` SET `border_cost` = 100000 WHERE `id` = 'rt_established_4';
--> statement-breakpoint
UPDATE `rank_tiers` SET `border_cost` = 250000 WHERE `id` = 'rt_distinguished_4';
--> statement-breakpoint
UPDATE `rank_tiers` SET `border_cost` = 600000 WHERE `id` = 'rt_legacy_member_4';
