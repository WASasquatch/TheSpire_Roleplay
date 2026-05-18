-- "Neon Sign" name style.
--
-- ON state: warm white-pink face (`--user-color-1`), a tight inner
-- halo and wider outer halo both in neon pink (`--user-glow`). Inner
-- halo is text-shadow (hugs the glyph edge); outer halo is filter
-- drop-shadow (radiates past the layout box for the lit-tube look).
--
-- OFF state: face dims to a mid-gray (`--user-color-2`) with a thin
-- darker inner stroke (`--user-outline`) — the dead-tube look. No
-- outer halo.
--
-- The flicker is random-looking via irregular `step-end` keyframes:
-- the tube is lit ~95% of the cycle, with a few brief blackouts and
-- one double-blink. `step-end` makes each transition instant
-- (proper neon-bulb pop, not a fade).
--
-- Vars:
--   --user-color-1 (default "#ffe0e8") face when ON
--   --user-color-2 (default "#8a8a8a") face when OFF
--   --user-glow    (default "#ff1493") neon-pink halo color
--   --user-outline (default "#555555") inner stroke when OFF

INSERT OR IGNORE INTO `name_styles`
  (`key`, `name`, `description`, `template`, `style_css`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('neon_sign',
   'Neon Sign',
   'Glowing pink tube name that flickers randomly off, like a tired bar sign.',
   '<span class="ns-neon-sign">{username}</span>',
   '.ns-neon-sign { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 4px var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 10px var(--user-glow, rgba(255,20,147,0.6))); animation: ns-neon-sign 7s step-end infinite; } @keyframes ns-neon-sign { 0%, 6.9% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 4px var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 10px var(--user-glow, rgba(255,20,147,0.6))); } 7%, 7.25% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 7.3%, 23.4% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 4px var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 10px var(--user-glow, rgba(255,20,147,0.6))); } 23.5%, 23.6% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 23.7%, 23.8% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 4px var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 10px var(--user-glow, rgba(255,20,147,0.6))); } 23.9%, 24% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 24.1%, 57.9% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 4px var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 10px var(--user-glow, rgba(255,20,147,0.6))); } 58%, 58.4% { color: var(--user-color-2, #8a8a8a); text-shadow: 0 0 1px var(--user-outline, #555); filter: none; } 58.5%, 100% { color: var(--user-color-1, #ffe0e8); text-shadow: 0 0 2px var(--user-glow, #ff1493), 0 0 6px var(--user-glow, #ff1493), 0 0 12px var(--user-glow, rgba(255,20,147,0.85)); filter: drop-shadow(0 0 4px var(--user-glow, rgba(255,20,147,0.9))) drop-shadow(0 0 10px var(--user-glow, rgba(255,20,147,0.6))); } }',
   14000, 1, 1, 18);
