-- Hearth Flame redo to match the Hearth Fire name style's vocabulary.
--
-- The name style is a clean vertical flame gradient (red → orange →
-- gold) that pans up and down with a faint upward drop-shadow — no
-- particles, no 360° decoration. The previous border had 8 flame
-- tongues distributed evenly around the rim, which broke physics
-- (flames shouldn't lick sideways or downward) and stopped reading
-- as "hearth fire" — it looked like a flaming Catherine wheel.
--
-- New design (companion to ns-hearth-fire):
--   • Outer ring uses the same color stack (b71c1c → ff7700 → ffd244)
--     with a vertical gradient that pans up + back, matching the
--     name style's ns-hearth-fire keyframes timing.
--   • A glowing log/coal bed sits at the bottom of the avatar (just
--     outside the .av rim, like the embers field). Pulses warmly.
--   • Three flame tongues rise from the log bed, all pointing UP and
--     swaying with their own offsets. Bottom-anchored so the base
--     stays planted on the log while the tip dances.
--   • An ascending heat haze fades from the log toward the top of
--     the avatar — the warmth around the figure rather than around it.

UPDATE `freeform_borders`
SET `style_css` = '.b-hearth-flame { padding: 2px; background: linear-gradient(to top, var(--c-ring-base, #b71c1c) 0%, var(--c-ring-mid, #ff7700) 50%, var(--c-ring-top, #ffd244) 100%); background-size: 100% 250%; animation: hfPan 2.4s ease-in-out infinite; box-shadow: 0 -4px 14px color-mix(in srgb, var(--c-glow, #ff8f00) 70%, transparent), 0 0 0 1px rgba(255,87,34,.45), inset 0 -6px 10px rgba(255,213,79,.35), inset 0 4px 6px rgba(0,0,0,.15); }
.b-hearth-flame .pic { box-shadow: 0 -2px 8px rgba(255,138,80,.5), inset 0 -6px 14px rgba(0,0,0,.18); }
.b-hearth-flame .haze {
  position: absolute;
  inset: -2px -2px 50% -2px;
  border-radius: 50%;
  pointer-events: none;
  background: radial-gradient(ellipse at 50% 100%, rgba(255,180,80,.32) 0%, rgba(255,140,60,.18) 35%, transparent 65%);
  filter: blur(2px);
  animation: hfHaze 3.2s ease-in-out infinite;
  z-index: 18;
}
.b-hearth-flame .flame-stack {
  position: absolute;
  left: 0; right: 0; bottom: -10px;
  height: 28px;
  pointer-events: none;
  z-index: 22;
}
.b-hearth-flame .flame {
  position: absolute;
  bottom: 6px;
  width: 8px;
  height: 18px;
  background: linear-gradient(to top, var(--fc-base, #b71c1c) 0%, var(--fc-mid, #ff6f00) 45%, var(--fc-top, #ffd54f) 80%, transparent 100%);
  border-radius: 50% 50% 50% 50% / 75% 75% 30% 30%;
  transform-origin: 50% 100%;
  filter: drop-shadow(0 0 4px var(--fc-mid, #ff6f00)) drop-shadow(0 0 8px var(--fc-base, #d84315));
  opacity: .92;
}
.b-hearth-flame .fl1 { left: 28%; --fc-base: #b71c1c; --fc-mid: #ff6f00; --fc-top: #ffd244; animation: hfFlicker 1.1s ease-in-out -.0s infinite; }
.b-hearth-flame .fl2 { left: 46%; --fc-base: #6d1b1b; --fc-mid: #ff8f00; --fc-top: #ffeb3b; width: 10px; height: 22px; animation: hfFlicker 1.35s ease-in-out -.32s infinite; }
.b-hearth-flame .fl3 { left: 62%; --fc-base: #b71c1c; --fc-mid: #ff7700; --fc-top: #ffd54f; animation: hfFlicker 1.2s ease-in-out -.18s infinite; }
.b-hearth-flame .hearth-log {
  position: absolute;
  left: 14%; right: 14%; bottom: -4px;
  height: 7px;
  border-radius: 999em;
  background:
    radial-gradient(ellipse at center, var(--c-coal-glow, rgba(255,213,79,.85)) 0%, rgba(255,111,0,.55) 35%, transparent 70%),
    linear-gradient(90deg, rgba(62,39,35,.85) 0%, rgba(109,76,65,.9) 50%, rgba(62,39,35,.85) 100%);
  box-shadow: 0 -1px 4px rgba(255,143,0,.55);
  filter: blur(.5px);
  z-index: 21;
  animation: hfLog 2.4s ease-in-out infinite;
}
@keyframes hfPan {
  0%, 100% { background-position: 0% 100%; }
  50%      { background-position: 0% 30%; }
}
@keyframes hfFlicker {
  0%   { transform: translateX(0) scaleY(1)    scaleX(1);    opacity: .85; }
  25%  { transform: translateX(-1px) scaleY(1.15) scaleX(.85); opacity: 1; }
  50%  { transform: translateX(1px)  scaleY(.92) scaleX(1.08); opacity: .8; }
  75%  { transform: translateX(-.5px) scaleY(1.1) scaleX(.92); opacity: .95; }
  100% { transform: translateX(0) scaleY(1)    scaleX(1);    opacity: .85; }
}
@keyframes hfLog {
  0%, 100% { opacity: .65; filter: blur(.5px) brightness(1); }
  50%      { opacity: 1;   filter: blur(.3px) brightness(1.35); }
}
@keyframes hfHaze {
  0%, 100% { opacity: .4; transform: translateY(0) scale(1); }
  50%      { opacity: .7; transform: translateY(-2px) scale(1.04); }
}',
  `template` = '<div class="av b-hearth-flame"><div class="pic">{avatar}</div><div class="haze"></div><div class="flame-stack"><div class="flame fl1"></div><div class="flame fl2"></div><div class="flame fl3"></div></div><div class="hearth-log"></div></div>',
  `description` = 'Hearth-fire flames rise from a glowing log bed below the avatar.',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'hearth-flame' AND `is_builtin` = 1;
