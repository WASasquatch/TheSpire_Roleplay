-- Targeted fixes to four borders after the 0156 compact pass:
--
--   Quantum drift, the orbit math in 0156 was wrong. Dots were
--     positioned at `left: -1px` / `right: -1px` / `top: -1px` and
--     then orbited via `rotate(R) translateX(42) rotate(-R)`. That
--     transform rotates around the dot's OWN center, so the orbit
--     was centered on the dot's starting position (offset from
--     .av center) instead of the avatar's center, dots reached
--     ~42px past the .av edge in the rotation direction opposite
--     to their starting side. Refactored to position dots AT the
--     .av center via `top:50% left:50% margin:-1.5px`, then orbit
--     at a controlled radius. All three dots now share one orbit,
--     spaced via `animation-delay` so they sit at different angles.
--
--   Hologram, the original used two animations on `.pic`
--     (hoCounter + hoShift) that BOTH set `transform`, which made
--     the second one always clobber the first, the avatar
--     ended up spinning with the parent instead of staying still,
--     and the scanline overlay sat BEHIND the avatar (pseudo-
--     elements default below the .pic z-index: 10) so there were
--     no visible scanlines on the portrait. Rewritten as a proper
--     hologram: stable (no spin) frame, scanlines overlaid on the
--     avatar via z-index 11 + screen blend, chromatic glitch via
--     filter on .pic.
--
--   Phoenix plumage, feathers translated -44px from .av center
--     left the feather tips ~8px past the frame edge at native
--     (≈13px at xl). Pulled to -34px so the crown sits at or
--     just past the frame edge.
--
--   Seraph, rays' transform-origin was 48px below the ray top,
--     pivoting at avatar center, but the ray top at `-7px` meant
--     the outer tip orbited at radius 48 from center (7px past
--     the .av edge). Pulled top to -3px and origin to 44px so the
--     outer tip orbits just past the frame.

UPDATE `freeform_borders`
SET `style_css` = '.b-quantum { padding: 2px; background: conic-gradient(from 0deg, #00bcd4, #00897b, #00bcd4); box-shadow: 0 0 10px rgba(0,188,212,.5); }
.b-quantum::before { content: ""; position: absolute; inset: -1px; border-radius: 50%; border: 1px solid #ff4081; mix-blend-mode: screen; animation: qPhaseA 1.4s ease-in-out infinite; }
.b-quantum::after { content: ""; position: absolute; inset: -1px; border-radius: 50%; border: 1px solid #00e5ff; mix-blend-mode: screen; animation: qPhaseB 1.4s ease-in-out infinite; }
.b-quantum .qdot {
  position: absolute;
  top: 50%; left: 50%;
  width: 3px; height: 3px;
  margin: -1.5px 0 0 -1.5px;
  border-radius: 50%;
  z-index: 11;
}
.b-quantum .qd1 { background: #ff4081; box-shadow: 0 0 4px #ff4081; animation: qOrbit 2s linear infinite; }
.b-quantum .qd2 { background: #00e5ff; box-shadow: 0 0 4px #00e5ff; animation: qOrbit 2s linear infinite -1s; }
.b-quantum .qd3 { background: #ffeb3b; box-shadow: 0 0 4px #ffeb3b; animation: qOrbit 2.6s linear infinite -1.3s; }
@keyframes qPhaseA {
  0%, 100% { transform: translate(0,0); opacity: .9; }
  50% { transform: translate(-1px, 1px); opacity: .4; }
}
@keyframes qPhaseB {
  0%, 100% { transform: translate(0,0); opacity: .9; }
  50% { transform: translate(1px, -1px); opacity: .4; }
}
@keyframes qOrbit {
  from { transform: rotate(0deg) translateX(42px) rotate(0deg); }
  to { transform: rotate(360deg) translateX(42px) rotate(-360deg); }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'quantum' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-holo {
  padding: 2px;
  background: conic-gradient(from 0deg, #00bcd4, #e040fb, #00e5ff, #ff4081, #00bcd4);
  box-shadow: 0 0 10px rgba(0,229,255,.5);
}
/* Scanlines OVER the avatar, z-index 11 puts this above .pic
   (z=10 from the preamble); screen blend keeps the portrait
   visible underneath. */
.b-holo::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: repeating-linear-gradient(
    0deg,
    transparent 0px,
    transparent 2px,
    rgba(170, 240, 255, .28) 2px,
    rgba(170, 240, 255, .28) 3px
  );
  animation: hoScan 2s linear infinite;
  z-index: 11;
  pointer-events: none;
  mix-blend-mode: screen;
}
/* Outer chromatic glitch ring, sits on top of everything. */
.b-holo::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid rgba(224, 64, 251, .7);
  animation: hoGlitch 3s steps(1) infinite;
  z-index: 12;
  pointer-events: none;
}
/* Avatar stays stable, only a periodic chromatic-aberration
   flicker via filter (no transform, so it doesnt fight with the
   preamble or rotate weirdly). */
.b-holo .pic {
  animation: hoShift 4s steps(1) infinite;
}
@keyframes hoScan {
  from { background-position: 0 0; }
  to { background-position: 0 14px; }
}
@keyframes hoGlitch {
  0%, 92%, 100% { transform: translate(0, 0); border-color: rgba(224, 64, 251, .7); }
  93% { transform: translate(1px, -1px); border-color: #ff4081; }
  95% { transform: translate(-1px, 1px); border-color: #00e5ff; }
  97% { transform: translate(1px, 0); border-color: rgba(224, 64, 251, .7); }
}
@keyframes hoShift {
  0%, 95%, 100% { filter: none; }
  96% { filter: drop-shadow(1px 0 0 rgba(255, 64, 129, .55)) drop-shadow(-1px 0 0 rgba(0, 229, 255, .55)) hue-rotate(15deg); }
  98% { filter: drop-shadow(-1px 0 0 rgba(255, 64, 129, .55)) drop-shadow(1px 0 0 rgba(0, 229, 255, .55)) hue-rotate(-15deg); }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'holo' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-phoenix-v4 { padding: 2px; background: conic-gradient(from 90deg, #ff1744, #ff6f00, #ffab00, #ff3d00, #ff1744); animation: phx4Spin 6s linear infinite; box-shadow: 0 0 10px rgba(255,87,34,.55), inset 0 0 6px rgba(255,193,7,.35); }
.b-phoenix-v4::before { content: ""; position: absolute; inset: -2px; border-radius: 50%; background: radial-gradient(circle, rgba(255,109,0,.35), transparent 65%); animation: phx4Aura 2.2s ease-in-out infinite; pointer-events: none; }
.b-phoenix-v4 .pic { animation: phx4Counter 6s linear infinite; }
.b-phoenix-v4 .feather-ring { position: absolute; inset: 0; pointer-events: none; }
.b-phoenix-v4 .feather {
  position: absolute;
  top: 50%; left: 50%;
  width: 4px; height: 8px;
  margin: -4px 0 0 -2px;
  background:
    linear-gradient(180deg, rgba(255,255,255,.65) 0%, transparent 18%),
    linear-gradient(to top, #b71c1c 0%, #ff3d00 35%, #ff9100 65%, #ffeb3b 95%, transparent 100%);
  border-radius: 50% 50% 50% 50% / 70% 70% 30% 30%;
  transform-origin: 50% 50%;
  filter: drop-shadow(0 0 2px rgba(255,87,34,.7));
  animation: phx4Feather 1.4s ease-in-out infinite;
}
.b-phoenix-v4 .ft1  { transform: rotate(0deg)   translate(0,-34px); animation-delay: 0s; }
.b-phoenix-v4 .ft2  { transform: rotate(30deg)  translate(0,-34px); animation-delay: .11s; }
.b-phoenix-v4 .ft3  { transform: rotate(60deg)  translate(0,-34px); animation-delay: .22s; }
.b-phoenix-v4 .ft4  { transform: rotate(90deg)  translate(0,-34px); animation-delay: .33s; }
.b-phoenix-v4 .ft5  { transform: rotate(120deg) translate(0,-34px); animation-delay: .44s; }
.b-phoenix-v4 .ft6  { transform: rotate(150deg) translate(0,-34px); animation-delay: .55s; }
.b-phoenix-v4 .ft7  { transform: rotate(180deg) translate(0,-34px); animation-delay: .66s; }
.b-phoenix-v4 .ft8  { transform: rotate(210deg) translate(0,-34px); animation-delay: .77s; }
.b-phoenix-v4 .ft9  { transform: rotate(240deg) translate(0,-34px); animation-delay: .88s; }
.b-phoenix-v4 .ft10 { transform: rotate(270deg) translate(0,-34px); animation-delay: .99s; }
.b-phoenix-v4 .ft11 { transform: rotate(300deg) translate(0,-34px); animation-delay: 1.1s; }
.b-phoenix-v4 .ft12 { transform: rotate(330deg) translate(0,-34px); animation-delay: 1.21s; }
@keyframes phx4Spin { to { transform: rotate(360deg); } }
@keyframes phx4Counter { to { transform: rotate(-360deg); } }
@keyframes phx4Aura {
  0%, 100% { opacity: .55; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.06); }
}
@keyframes phx4Feather {
  0%, 100% { filter: drop-shadow(0 0 2px rgba(255,87,34,.7)) brightness(1); }
  50% { filter: drop-shadow(0 0 4px rgba(255,193,7,1)) brightness(1.3); }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'phoenix-v4' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-celestial-v2 { padding: 2px; background: radial-gradient(circle, #fffde7 0%, #fff59d 40%, #ffd54f 70%, #ffa726); box-shadow: 0 0 14px rgba(255,213,79,.8), inset 0 0 6px rgba(255,255,255,.6); }
.b-celestial-v2::before { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: conic-gradient(from 0deg, transparent, rgba(255,235,59,.7), transparent, rgba(255,193,7,.5), transparent, rgba(255,235,59,.7), transparent); animation: cl2Rotate 5s linear infinite; }
.b-celestial-v2::after { content: ""; position: absolute; inset: -1px; border-radius: 50%; border: 1px solid #fff; box-shadow: 0 0 0 1px #ffd54f, 0 0 8px rgba(255,255,255,.9); animation: cl2Pulse 2s ease-in-out infinite; }
.b-celestial-v2 .ray { position: absolute; width: 2px; background: linear-gradient(to top, rgba(255,213,79,1), transparent); top: -3px; left: 50%; margin-left: -1px; height: 7px; transform-origin: 50% 44px; border-radius: 2px; }
.b-celestial-v2 .ry1 { animation: cl2Ray 4s linear infinite; }
.b-celestial-v2 .ry2 { animation: cl2Ray 4s linear infinite -.66s; }
.b-celestial-v2 .ry3 { animation: cl2Ray 4s linear infinite -1.33s; }
.b-celestial-v2 .ry4 { animation: cl2Ray 4s linear infinite -2s; }
.b-celestial-v2 .ry5 { animation: cl2Ray 4s linear infinite -2.66s; }
.b-celestial-v2 .ry6 { animation: cl2Ray 4s linear infinite -3.33s; }
.b-celestial-v2 .wing { position: absolute; width: 10px; height: 16px; background: radial-gradient(ellipse, rgba(255,255,255,.9), rgba(255,235,59,.4) 70%, transparent); border-radius: 50% 10% 50% 50%; filter: blur(.5px); }
.b-celestial-v2 .wL { left: -4px; top: 34%; transform: rotate(-30deg) scaleX(-1); animation: cl2Wing 2s ease-in-out infinite; }
.b-celestial-v2 .wR { right: -4px; top: 34%; transform: rotate(30deg); animation: cl2Wing 2s ease-in-out infinite; }
@keyframes cl2Rotate { to { transform: rotate(360deg); } }
@keyframes cl2Pulse {
  0%, 100% { box-shadow: 0 0 0 1px #ffd54f, 0 0 8px rgba(255,255,255,.9); }
  50% { box-shadow: 0 0 0 1px #fff8e1, 0 0 14px rgba(255,255,255,1), 0 0 20px rgba(255,213,79,.8); }
}
@keyframes cl2Ray {
  0% { transform: rotate(0deg); opacity: .9; }
  50% { opacity: 1; }
  100% { transform: rotate(360deg); opacity: .9; }
}
@keyframes cl2Wing {
  0%, 100% { transform: rotate(-30deg) scaleX(-1) scaleY(1); opacity: .7; }
  50% { transform: rotate(-25deg) scaleX(-1) scaleY(1.15); opacity: 1; }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'celestial-v2' AND `is_builtin` = 1;
