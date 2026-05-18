-- Neon Sign — flip the glow-pulse so the tube SITS at full brightness
-- and only dips by a hair at two brief moments per cycle.
--
-- The previous keyframes (0089) walked 1.0 → 0.85 → 0.95 → 0.88 → 1.0,
-- which with ease-in-out interpolation meant the glow was below 1.0
-- for the majority of the 1.7s cycle — the visual average sat
-- around 0.91, so the bulb LOOKED mostly dim with occasional
-- bright moments. Wrong polarity for an energized tube.
--
-- Now: hold `--ns-glow-scale` at 1.0 across long stretches, with
-- two short ease-in/out dips to 0.96 and 0.97 (vs the old 0.85 /
-- 0.88). Each dip is a hair — barely a 3–4% reduction in halo
-- radius — and the time spent at-full is the dominant state.
-- Cycle stretched to 2.4s so the two dips feel like irregular
-- breaths rather than a metronome.

UPDATE `name_styles`
   SET `style_css` = '@property --ns-glow-scale { syntax: "<number>"; initial-value: 1; inherits: false; } .ns-neon-sign { --ns-glow-scale: 1; color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 calc(2px * var(--ns-glow-scale, 1)) var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 calc(5px * var(--ns-glow-scale, 1)) var(--user-glow, rgba(255,20,147,0.55))); animation: ns-neon-sign 7s step-end infinite, ns-neon-glow 2.4s ease-in-out infinite; } @keyframes ns-neon-sign { 0%, 6.9% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); } 7%, 7.25% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 7.3%, 23.4% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); } 23.5%, 23.6% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 23.7%, 23.8% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); } 23.9%, 24% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 24.1%, 57.9% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); } 58%, 58.4% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 58.5%, 100% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); } } @keyframes ns-neon-glow { 0%, 38% { --ns-glow-scale: 1; } 42% { --ns-glow-scale: 0.96; } 46%, 78% { --ns-glow-scale: 1; } 82% { --ns-glow-scale: 0.97; } 86%, 100% { --ns-glow-scale: 1; } }'
 WHERE `key` = 'neon_sign';
