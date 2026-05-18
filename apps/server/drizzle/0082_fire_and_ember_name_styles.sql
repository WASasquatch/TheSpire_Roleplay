-- Two new animated name styles in the fire family.
--
--   hearth_fire — vertical fire-palette gradient that pans up and
--                 down through the glyphs (the flame "rises" through
--                 the letters). Single-element style; no pseudo
--                 trickery. Cheaper to render and a solid baseline.
--
--   embers      — same fire gradient pan + two pseudo-element layers
--                 emitting "particles" via stacked radial-gradients
--                 that translate upward and fade. Three particles
--                 per pseudo, two pseudos with offset durations and
--                 a negative animation-delay so the six total dots
--                 phase against each other and read as a random
--                 sputter rather than a synchronized march.
--
-- The embers style needs `position: relative` on the wrapper span so
-- the `::before` / `::after` pseudos can absolutely position above
-- the text. `display: inline-block` makes `position: relative` behave
-- consistently for inline content (without it some renderers don't
-- give an inline element a positioning context for its pseudos).
-- This does NOT break chat-line flow: the inline-block participates
-- in line layout normally; the pseudos are absolutely positioned so
-- they don't contribute to the box height.
--
-- All user CSS vars (--user-color-1, --user-color-2, --user-glow,
-- --user-outline) are honored where they apply. Defaults paint as
-- classic fire (deep red base → orange middle → gold tip + warm halo)
-- so a fresh purchase looks right without users having to configure
-- the palette.

INSERT OR IGNORE INTO `name_styles`
  (`key`, `name`, `description`, `template`, `style_css`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('hearth_fire',
   'Hearth Fire',
   'Vertical fire gradient that pans up and down through the glyphs. The flame rises through the name.',
   '<span class="ns-hearth-fire">{username}</span>',
   '.ns-hearth-fire { background: linear-gradient(0deg, var(--user-color-2, #cc1a00) 0%, var(--user-color-1, #ff7700) 50%, var(--user-glow, #ffd244) 100%); background-size: 100% 250%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 0.5px var(--user-outline, rgba(40,0,0,0.55)); animation: ns-hearth-fire 2.4s ease-in-out infinite; filter: drop-shadow(0 -2px 4px var(--user-glow, rgba(255,140,50,0.65))); } @keyframes ns-hearth-fire { 0%, 100% { background-position: 0% 100%; } 50% { background-position: 0% 30%; } }',
   15000, 1, 1, 16),

  ('embers',
   'Embers',
   'Fire gradient with glowing embers that flicker off and rise above the name. The fanciest of the animated styles.',
   '<span class="ns-embers">{username}</span>',
   '.ns-embers { position: relative; display: inline-block; background: linear-gradient(0deg, var(--user-color-2, #aa1500) 0%, var(--user-color-1, #ff6600) 45%, var(--user-glow, #ffcc44) 100%); background-size: 100% 220%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 0.5px var(--user-outline, rgba(40,0,0,0.55)); animation: ns-embers-flame 2.8s ease-in-out infinite; filter: drop-shadow(0 -2px 5px var(--user-glow, rgba(255,140,50,0.7))); } @keyframes ns-embers-flame { 0%, 100% { background-position: 0% 100%; } 50% { background-position: 0% 30%; } } .ns-embers::before, .ns-embers::after { content: ""; position: absolute; inset: -14px -2px 0 -2px; pointer-events: none; background-repeat: no-repeat; } .ns-embers::before { background-image: radial-gradient(circle 1.2px at 18% 80%, var(--user-glow, rgba(255,200,100,1)), transparent 70%), radial-gradient(circle 0.8px at 52% 75%, var(--user-glow, rgba(255,170,80,0.95)), transparent 70%), radial-gradient(circle 1.4px at 81% 70%, var(--user-glow, rgba(255,220,130,0.95)), transparent 70%); animation: ns-embers-rise 2.4s linear infinite; } .ns-embers::after { background-image: radial-gradient(circle 1px at 33% 90%, var(--user-glow, rgba(255,180,90,0.9)), transparent 70%), radial-gradient(circle 1.2px at 67% 85%, var(--user-glow, rgba(255,210,110,0.9)), transparent 70%), radial-gradient(circle 0.9px at 92% 78%, var(--user-glow, rgba(255,160,60,0.95)), transparent 70%); animation: ns-embers-rise 3.6s linear infinite -1.2s; } @keyframes ns-embers-rise { 0% { transform: translateY(4px); opacity: 0; } 20% { opacity: 1; } 100% { transform: translateY(-14px); opacity: 0; } }',
   30000, 1, 1, 17);
