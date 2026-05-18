-- Neon Sign — collapse the two-animation composition into ONE
-- animation that explicitly sets `filter` on every keyframe.
--
-- Why the previous attempts kept reading inverted: when a property
-- is specified in SOME keyframes but omitted in others, browsers
-- interpolate between the keyframes that DO specify it. My "lit"
-- keyframes omitted `filter`, and the only specifying keyframes
-- set `filter: none` (dead blips). So during the supposedly-lit
-- segments, the browser was holding `filter: none` between adjacent
-- dead specifying keyframes — which is exactly what the user
-- reported (no halo most of the time, brief flashes of halo).
--
-- The fix is unambiguous: every keyframe specifies filter. Lit
-- keyframes set the full drop-shadow stack; dead keyframes set
-- `filter: none`; dim-breath keyframes use `color-mix` to fade the
-- glow alpha by a hair.
--
-- Per-keyframe `animation-timing-function` mixes the transitions:
--   ease-in-out  — lit ↔ dim-breath (smooth pulse)
--   step-end     — lit ↔ dead (sharp neon bulb pop)
--
-- Timeline (7s cycle):
--   0%–35%   slow breath: lit-full → hair-dim at 18% → lit-full
--   40.5%–40.8% brief dead blip
--   41%–75%  second breath: lit-full → hair-dim at 58% → lit-full
--   82.3%–82.9% double-blink dead/lit/dead/lit/dead
--   83%–100% lit-full hold

UPDATE `name_styles`
   SET `style_css` = '.ns-neon-sign { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 2px var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 5px var(--user-glow, rgba(255,20,147,0.55))); animation: ns-neon-sign 7s linear infinite; } @keyframes ns-neon-sign { 0% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 2px var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 5px var(--user-glow, rgba(255,20,147,0.55))); animation-timing-function: ease-in-out; } 18% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 2px color-mix(in srgb, var(--user-glow, rgba(255,20,147,0.9)), transparent 8%)) drop-shadow(0 0 5px color-mix(in srgb, var(--user-glow, rgba(255,20,147,0.55)), transparent 8%)); animation-timing-function: ease-in-out; } 35% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 2px var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 5px var(--user-glow, rgba(255,20,147,0.55))); animation-timing-function: step-end; } 40.5% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; animation-timing-function: step-end; } 40.8% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; animation-timing-function: step-end; } 41% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 2px var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 5px var(--user-glow, rgba(255,20,147,0.55))); animation-timing-function: ease-in-out; } 58% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 2px color-mix(in srgb, var(--user-glow, rgba(255,20,147,0.9)), transparent 8%)) drop-shadow(0 0 5px color-mix(in srgb, var(--user-glow, rgba(255,20,147,0.55)), transparent 8%)); animation-timing-function: ease-in-out; } 75% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 2px var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 5px var(--user-glow, rgba(255,20,147,0.55))); animation-timing-function: step-end; } 82.3% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; animation-timing-function: step-end; } 82.5% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 2px var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 5px var(--user-glow, rgba(255,20,147,0.55))); animation-timing-function: step-end; } 82.7% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; animation-timing-function: step-end; } 82.9% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 2px var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 5px var(--user-glow, rgba(255,20,147,0.55))); animation-timing-function: step-end; } 100% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 2px var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 5px var(--user-glow, rgba(255,20,147,0.55))); } }'
 WHERE `key` = 'neon_sign';
