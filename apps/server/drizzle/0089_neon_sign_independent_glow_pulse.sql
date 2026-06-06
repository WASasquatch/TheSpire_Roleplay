-- Neon Sign, give the outer glow its own subtle pulse, independent
-- of the main on/off flicker.
--
-- Two animations run side-by-side on the same element:
--
--   ns-neon-sign  (7s, step-end)
--     Controls color + text-shadow. Sharp on/off transitions.
--     ALSO sets `filter: none` during the dead-tube blips so the
--     outer glow vanishes when the bulb pops. Does NOT specify
--     `filter` during the lit keyframes, the underlying base
--     filter rule applies there.
--
--   ns-neon-glow  (1.7s, ease-in-out)
--     Controls the registered custom property `--ns-glow-scale`,
--     which the base `filter:` rule multiplies into the
--     drop-shadow radii via calc(). Smoothly walks 0.85 → 1.0 so
--     the outer halo breathes in and out like an actual energized
--     gas tube. Doesn't touch `filter` itself, so the main
--     animation's `filter: none` during dead blips still wins.
--
-- `@property --ns-glow-scale` registers the var as a typed number
-- so browsers can interpolate it smoothly (Chrome 85+, Firefox
-- 128+, Safari 16.4+). Without @property the var stays a string;
-- the pulse stepwise-snaps instead of breathing, which is a
-- reasonable fallback on older browsers.

UPDATE `name_styles`
   SET `style_css` = '@property --ns-glow-scale { syntax: "<number>"; initial-value: 1; inherits: false; } .ns-neon-sign { --ns-glow-scale: 1; color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 calc(2px * var(--ns-glow-scale, 1)) var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 calc(5px * var(--ns-glow-scale, 1)) var(--user-glow, rgba(255,20,147,0.55))); animation: ns-neon-sign 7s step-end infinite, ns-neon-glow 1.7s ease-in-out infinite; } @keyframes ns-neon-sign { 0%, 6.9% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); } 7%, 7.25% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 7.3%, 23.4% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); } 23.5%, 23.6% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 23.7%, 23.8% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); } 23.9%, 24% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 24.1%, 57.9% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); } 58%, 58.4% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 58.5%, 100% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); } } @keyframes ns-neon-glow { 0%, 100% { --ns-glow-scale: 1; } 30% { --ns-glow-scale: 0.85; } 55% { --ns-glow-scale: 0.95; } 80% { --ns-glow-scale: 0.88; } }'
 WHERE `key` = 'neon_sign';
