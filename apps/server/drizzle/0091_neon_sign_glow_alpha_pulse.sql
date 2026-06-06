-- Neon Sign, switch the glow pulse from radius modulation to
-- ALPHA modulation, so "dim" actually reads as dim.
--
-- The 0089/0090 approach scaled the drop-shadow blur radius via a
-- multiplier. That was the wrong tool: shrinking the blur radius
-- makes the SAME color concentrate into a smaller area, which the
-- eye reads as MORE intense, not less. So the previous keyframes
-- were inverted in perception, the "dip" moments were brief bright
-- spikes, the "full" moments were the more diffuse softer glow.
--
-- Now: the radius stays static at 2px and 5px. Alpha modulates via
-- `color-mix(in srgb, <glow>, transparent X%)`. Most of the cycle
-- holds at 0% transparency added (full alpha). Two brief easings
-- to 12% / 15%, a 0.12 / 0.15 dip in alpha, barely visible. That
-- matches "a hair dimmer" while the bulb still reads as on.
--
-- `--ns-glow-fade` is registered as a <percentage> so browsers
-- interpolate it smoothly between keyframes. Chrome 111+, FF 113+,
-- Safari 16.2+ for color-mix; @property is broader. On older
-- browsers the color-mix falls back to no-fade behavior, leaving
-- a static bright glow, acceptable degradation.

UPDATE `name_styles`
   SET `style_css` = '@property --ns-glow-fade { syntax: "<percentage>"; initial-value: 0%; inherits: false; } .ns-neon-sign { --ns-glow-fade: 0%; color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 2px color-mix(in srgb, var(--user-glow, rgba(255,20,147,0.9)), transparent var(--ns-glow-fade, 0%))) drop-shadow(0 0 5px color-mix(in srgb, var(--user-glow, rgba(255,20,147,0.55)), transparent var(--ns-glow-fade, 0%))); animation: ns-neon-sign 7s step-end infinite, ns-neon-glow 2.4s ease-in-out infinite; } @keyframes ns-neon-sign { 0%, 6.9% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); } 7%, 7.25% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 7.3%, 23.4% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); } 23.5%, 23.6% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 23.7%, 23.8% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); } 23.9%, 24% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 24.1%, 57.9% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); } 58%, 58.4% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 58.5%, 100% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); } } @keyframes ns-neon-glow { 0%, 38% { --ns-glow-fade: 0%; } 42% { --ns-glow-fade: 15%; } 46%, 78% { --ns-glow-fade: 0%; } 82% { --ns-glow-fade: 12%; } 86%, 100% { --ns-glow-fade: 0%; } }'
 WHERE `key` = 'neon_sign';
