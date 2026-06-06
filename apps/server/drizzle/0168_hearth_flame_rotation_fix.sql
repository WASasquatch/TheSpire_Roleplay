-- Fix hearth-flame: the per-flame static `transform: rotate(Ndeg)...`
-- was being clobbered by the `hfFlicker` keyframes' transform, which
-- referenced an undefined `--rot` CSS variable and resolved to 0deg
--, collapsing all 8 flame tongues onto the top of the avatar.
--
-- Pass the rotation through `--rot` per-element so both the initial
-- transform AND the animated transform agree on which slot of the
-- ring the flame occupies.

UPDATE `freeform_borders`
SET `style_css` = '.b-hearth-flame { padding: 2px; background: conic-gradient(from 0deg, var(--c-ring-main, #b71c1c), var(--c-ring-soft, #ff6f00), var(--c-ring-accent, #ffc107), var(--c-ring-soft, #ff8f00), var(--c-ring-main, #d84315), var(--c-ring-soft, #ff6f00), var(--c-ring-main, #b71c1c)); animation: hfBreathe 4.4s ease-in-out infinite; box-shadow: 0 0 0 1px rgba(255,87,34,.5), 0 0 14px color-mix(in srgb, var(--c-glow, #ff8f00) 80%, transparent), inset 0 0 8px rgba(255,213,79,.4); }
.b-hearth-flame .flame-ring { position: absolute; inset: -3px; border-radius: 50%; pointer-events: none; z-index: 20; }
.b-hearth-flame .flame {
  position: absolute;
  width: 7px; height: 12px;
  background: linear-gradient(to top, var(--fc-base, #b71c1c) 0%, var(--fc-mid, #ff6f00) 35%, var(--fc-top, #ffc107) 75%, transparent 100%);
  border-radius: 50% 50% 50% 50% / 70% 70% 30% 30%;
  transform-origin: 50% 90%;
  filter: drop-shadow(0 0 4px var(--fc-mid, #ff6f00)) drop-shadow(0 0 8px var(--fc-base, #d84315));
  opacity: .85;
  top: 50%; left: 50%;
  margin: -6px 0 0 -3.5px;
  animation: hfFlicker 1.2s ease-in-out infinite;
}
.b-hearth-flame .fl1 { --rot:   0deg; --delay: -.00s; --fc-base: #b71c1c; --fc-mid: #ff6f00; --fc-top: #ffeb3b; transform: rotate(  0deg) translate(0, -46px); animation-delay: -.00s; animation-duration: 1.10s; }
.b-hearth-flame .fl2 { --rot:  45deg; --delay: -.18s; --fc-base: #bf360c; --fc-mid: #ff8f00; --fc-top: #ffc107; transform: rotate( 45deg) translate(0, -46px); animation-delay: -.18s; animation-duration: 1.30s; }
.b-hearth-flame .fl3 { --rot:  90deg; --delay: -.35s; --fc-base: #b71c1c; --fc-mid: #ff5722; --fc-top: #ffb300; transform: rotate( 90deg) translate(0, -46px); animation-delay: -.35s; animation-duration: 1.00s; }
.b-hearth-flame .fl4 { --rot: 135deg; --delay: -.52s; --fc-base: #6d1b1b; --fc-mid: #ff6f00; --fc-top: #ffd54f; transform: rotate(135deg) translate(0, -46px); animation-delay: -.52s; animation-duration: 1.40s; }
.b-hearth-flame .fl5 { --rot: 180deg; --delay: -.70s; --fc-base: #b71c1c; --fc-mid: #ff8f00; --fc-top: #ffeb3b; transform: rotate(180deg) translate(0, -46px); animation-delay: -.70s; animation-duration: 1.20s; }
.b-hearth-flame .fl6 { --rot: 225deg; --delay: -.87s; --fc-base: #bf360c; --fc-mid: #ff5722; --fc-top: #ffc107; transform: rotate(225deg) translate(0, -46px); animation-delay: -.87s; animation-duration: 1.05s; }
.b-hearth-flame .fl7 { --rot: 270deg; --delay: -1.05s; --fc-base: #b71c1c; --fc-mid: #ff6f00; --fc-top: #ffb300; transform: rotate(270deg) translate(0, -46px); animation-delay: -1.05s; animation-duration: 1.35s; }
.b-hearth-flame .fl8 { --rot: 315deg; --delay: -1.22s; --fc-base: #6d1b1b; --fc-mid: #ff8f00; --fc-top: #ffd54f; transform: rotate(315deg) translate(0, -46px); animation-delay: -1.22s; animation-duration: 1.15s; }
.b-hearth-flame .hearth-log {
  position: absolute;
  left: 18%; right: 18%; bottom: -2px;
  height: 5px;
  border-radius: 999em;
  background:
    radial-gradient(ellipse at center, rgba(255,193,7,.7) 0, rgba(255,111,0,.45) 40%, transparent 75%),
    linear-gradient(90deg, rgba(78,52,46,.7) 0%, rgba(141,110,99,.8) 50%, rgba(78,52,46,.7) 100%);
  filter: blur(.6px);
  z-index: 21;
  animation: hfLog 3.2s ease-in-out infinite;
}
.b-hearth-flame .pic { box-shadow: 0 0 10px rgba(255,138,80,.45), inset 0 0 12px rgba(0,0,0,.22); }
@keyframes hfBreathe {
  0%, 100% { box-shadow: 0 0 0 1px rgba(255,87,34,.5), 0 0 14px color-mix(in srgb, var(--c-glow, #ff8f00) 80%, transparent), inset 0 0 8px rgba(255,213,79,.4); }
  50%      { box-shadow: 0 0 0 1px rgba(255,193,7,.85), 0 0 22px color-mix(in srgb, var(--c-glow, #ffc107) 100%, transparent), inset 0 0 12px rgba(255,235,59,.6); }
}
@keyframes hfFlicker {
  0%   { transform: rotate(var(--rot, 0deg)) translate(0, -46px) scaleY(1) scaleX(1); opacity: .85; }
  25%  { transform: rotate(var(--rot, 0deg)) translate(-1px, -47px) scaleY(1.18) scaleX(.85); opacity: 1; }
  50%  { transform: rotate(var(--rot, 0deg)) translate(1px, -45px) scaleY(.92) scaleX(1.08); opacity: .75; }
  75%  { transform: rotate(var(--rot, 0deg)) translate(-.5px, -47.5px) scaleY(1.12) scaleX(.9); opacity: .95; }
  100% { transform: rotate(var(--rot, 0deg)) translate(0, -46px) scaleY(1) scaleX(1); opacity: .85; }
}
@keyframes hfLog {
  0%, 100% { opacity: .55; filter: blur(.6px) brightness(1); }
  50%      { opacity: .9;  filter: blur(.4px) brightness(1.25); }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'hearth-flame' AND `is_builtin` = 1;
