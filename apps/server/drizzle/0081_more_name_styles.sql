-- Eight new name styles broadening the visual range beyond the
-- gradient-clip family. Six static + two animated. All seven of the
-- pre-existing styles use the same "linear horizontal gradient masked
-- through clip-text + dark stroke" recipe, that's a narrow vocabulary
-- once a user owns three of them, so this migration deliberately picks
-- treatments that look NOTHING like each other:
--
--   chrome   , vertical metallic gradient, mid-toned shoulders
--   neon_tube, bright fill + same-color halo, no dark outline
--   comic_pop, solid + thick white outline + offset hard shadow
--   stencil  , outlined-only (transparent fill), faint ambient
--   synthwave, vertical pink-to-purple + cyan underglow drop
--   glassy   , semi-translucent fill + thin white outline + soft glow
--   marquee  , animated blinking opacity (lit-bulb marquee feel)
--   aurora_b , animated hue-rotation across a 3-stop tropical palette
--
-- All accept the standard user CSS vars (--user-color-1, --user-color-2,
-- --user-glow, --user-outline) where they apply, so users can re-tint
-- the same style without admins shipping new variants. Cost ladder
-- spans 2500-22000 to slot between existing tiers; the admin Earning
-- panel can re-price any of these without a migration.

INSERT OR IGNORE INTO `name_styles`
  (`key`, `name`, `description`, `template`, `style_css`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('stencil',
   'Stencil',
   'Outlined letters with a transparent center. Reads like spray-paint stencilwork on a brick wall.',
   '<span class="ns-stencil">{username}</span>',
   '.ns-stencil { color: transparent; -webkit-text-stroke: 2px var(--user-outline, rgba(255,255,255,0.95)); filter: drop-shadow(0 0 1px rgba(0,0,0,0.4)); }',
   2500, 1, 1, 8),

  ('chrome',
   'Chrome',
   'Vertical silver-to-shadow gradient with a thin contrast outline. Heavy-metal lettering.',
   '<span class="ns-chrome">{username}</span>',
   '.ns-chrome { background: linear-gradient(180deg, var(--user-color-1, #f0f0f0) 0%, var(--user-color-2, #6b6b6b) 45%, var(--user-color-2, #6b6b6b) 55%, var(--user-color-1, #f0f0f0) 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.5)); }',
   4000, 1, 1, 9),

  ('glassy',
   'Glassy',
   'Semi-translucent fill with a thin white outline and soft inner highlight. Frosted glass look.',
   '<span class="ns-glassy">{username}</span>',
   '.ns-glassy { color: var(--user-color-1, rgba(255,255,255,0.6)); -webkit-text-stroke: 1px var(--user-outline, rgba(255,255,255,0.85)); filter: drop-shadow(0 0 3px rgba(255,255,255,0.5)) drop-shadow(0 1px 2px rgba(0,0,0,0.35)); }',
   5500, 1, 1, 10),

  ('comic_pop',
   'Comic Pop',
   'Solid color with a thick white outline and a hard black drop shadow. Comic book speech-bubble lettering.',
   '<span class="ns-comic-pop">{username}</span>',
   '.ns-comic-pop { color: var(--user-color-1, currentColor); -webkit-text-stroke: 2px var(--user-outline, rgba(255,255,255,0.95)); paint-order: stroke fill; filter: drop-shadow(3px 3px 0 rgba(0,0,0,0.85)); }',
   6000, 1, 1, 11),

  ('neon_tube',
   'Neon Tube',
   'Bright solid fill with a tight matching halo. Looks like a lit gas-tube sign.',
   '<span class="ns-neon-tube">{username}</span>',
   '.ns-neon-tube { color: var(--user-color-1, #ff66cc); text-shadow: 0 0 3px var(--user-color-1, #ff66cc), 0 0 7px var(--user-color-1, rgba(255,102,204,0.85)); -webkit-text-stroke: 0.5px var(--user-outline, rgba(0,0,0,0.4)); }',
   8000, 1, 1, 12),

  ('marquee',
   'Marquee',
   'Solid color with a soft halo that blinks like a row of marquee bulbs.',
   '<span class="ns-marquee">{username}</span>',
   '.ns-marquee { color: var(--user-color-1, currentColor); -webkit-text-stroke: 1px var(--user-outline, rgba(255,255,255,0.9)); filter: drop-shadow(0 0 3px var(--user-glow, rgba(255,200,80,0.9))); animation: ns-marquee 1.6s ease-in-out infinite; } @keyframes ns-marquee { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }',
   9000, 1, 1, 13),

  ('synthwave',
   'Synthwave',
   'Vertical magenta-to-purple gradient with a cyan glow dropping beneath. 80s sunset typography.',
   '<span class="ns-synthwave">{username}</span>',
   '.ns-synthwave { background: linear-gradient(180deg, var(--user-color-1, #c060ff) 0%, var(--user-color-2, #ff6090) 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(255,255,255,0.5)); filter: drop-shadow(0 2px 3px var(--user-glow, rgba(80,220,255,0.8))); }',
   12000, 1, 1, 14),

  ('aurora_borealis',
   'Aurora Borealis',
   'Three-stop tropical gradient that slowly rotates its hue. The name shifts color over time.',
   '<span class="ns-aurora-borealis">{username}</span>',
   '.ns-aurora-borealis { background: linear-gradient(90deg, var(--user-color-1, #80ff80) 0%, var(--user-glow, #80c0ff) 50%, var(--user-color-2, #c080ff) 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 1px var(--user-outline, rgba(0,0,0,0.5)); animation: ns-aurora-borealis 8s ease-in-out infinite; } @keyframes ns-aurora-borealis { 0%, 100% { filter: hue-rotate(0deg); } 50% { filter: hue-rotate(60deg); } }',
   22000, 1, 1, 15);
