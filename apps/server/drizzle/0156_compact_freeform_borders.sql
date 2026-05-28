-- Compact redesign of all 18 seeded free-form borders.
--
-- The borders inherited from complete_avatar_borders.html were sized
-- for a showcase grid with generous padding around each tile. In the
-- userlist + chat-line slots they bled into neighbors regardless of
-- masks / clip-paths / variable scaling — the only correct fix is to
-- rewrite the CSS at the source so the effects are intrinsically
-- compact.
--
-- Design rules for this pass:
--   - .av frame size = 82px (preamble), .pic = 76px → 3px ring native
--     → ~5px at xl scale, ~1-2px at inline tiers.
--   - Pseudo-element rings (`::before`, `::after`) keep `inset` to
--     0 or -2px max — no more -14px halos.
--   - Decorative children (.leaf, .feather, .gem, .ember, .bolt,
--     .petal, .glyph, .wing, .ray, .qdot, .ref) live ON the frame
--     edge or inside, not far outside.
--   - Falling / orbital animations travel ≤25px native (≈40px at
--     xl) so a Sakura petal or Sylvan leaf doesn't reach a row
--     below in any tier.
--   - Outer box-shadow glows max 12px native (≈20px at xl) — keeps
--     the bloom present without painting two rows over.
--   - No more `var(--b-spread)` references — every value is a real
--     intrinsic size; the renderer no longer needs to scale bleed
--     per tier.
--
-- `is_builtin = 1` guard restricts these UPDATEs to the seeded rows;
-- admin custom edits to a seed are not preserved across this
-- migration.

-- =========================================================
-- RARE
-- =========================================================

UPDATE `freeform_borders`
SET `style_css` = '.b-aurora-v2 { padding: 2px; background: conic-gradient(from 0deg, #00e5ff, #4dd0e1, #80deea, #b39ddb, #4dd0e1, #00bcd4, #00e5ff); animation: aV2Spin 5s linear infinite; box-shadow: 0 0 8px rgba(0,229,255,.5); }
.b-aurora-v2::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from 180deg, transparent, rgba(255,255,255,.6), transparent, transparent); animation: aV2Wash 3s linear infinite; mix-blend-mode: overlay; }
.b-aurora-v2 .pic { animation: aV2Counter 5s linear infinite; }
@keyframes aV2Spin { to { transform: rotate(360deg); } }
@keyframes aV2Counter { to { transform: rotate(-360deg); } }
@keyframes aV2Wash { to { transform: rotate(-360deg); } }',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'aurora-v2' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-tide { padding: 2px; background: conic-gradient(from 90deg, #006064, #00838f, #0097a7, #4dd0e1, #006064); animation: tideRotate 8s linear infinite; box-shadow: 0 0 6px rgba(0,151,167,.5), inset 0 0 4px rgba(255,255,255,.2); }
.b-tide::before { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 1px solid rgba(178,235,242,.7); animation: tideRipple 2.5s ease-out infinite; }
.b-tide::after { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 1px solid rgba(178,235,242,.7); animation: tideRipple 2.5s ease-out infinite 1.25s; }
.b-tide .pic { animation: tideRotate 8s linear infinite reverse; }
@keyframes tideRotate { to { transform: rotate(360deg); } }
@keyframes tideRipple {
  0% { transform: scale(.96); opacity: 1; }
  100% { transform: scale(1.12); opacity: 0; }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'tide' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-forest { padding: 2px; background: conic-gradient(from 45deg, #2e7d32, #66bb6a, #aed581, #66bb6a, #1b5e20); animation: forestSway 6s ease-in-out infinite; box-shadow: 0 0 8px rgba(102,187,106,.4); }
.b-forest .leaf { position: absolute; width: 5px; height: 8px; background: #66bb6a; border-radius: 0 100% 0 100%; box-shadow: inset 0 0 0 1px #2e7d32; }
.b-forest .lf1 { top: -3px; left: 32%; animation: leafFall 4s ease-in infinite; }
.b-forest .lf2 { top: -3px; left: 60%; animation: leafFall 4s ease-in infinite 1.3s; }
.b-forest .lf3 { top: -3px; left: 46%; animation: leafFall 4s ease-in infinite 2.6s; }
.b-forest .pic { animation: forestSway 6s ease-in-out infinite reverse; }
@keyframes forestSway {
  0%, 100% { transform: rotate(-3deg); }
  50% { transform: rotate(3deg); }
}
@keyframes leafFall {
  0% { transform: translateY(0) rotate(0deg); opacity: 0; }
  20% { opacity: 1; }
  100% { transform: translateY(22px) rotate(540deg) translateX(4px); opacity: 0; }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'forest' AND `is_builtin` = 1;
--> statement-breakpoint

-- =========================================================
-- EPIC
-- =========================================================

UPDATE `freeform_borders`
SET `style_css` = '.b-phoenix-v4 { padding: 2px; background: conic-gradient(from 90deg, #ff1744, #ff6f00, #ffab00, #ff3d00, #ff1744); animation: phx4Spin 6s linear infinite; box-shadow: 0 0 10px rgba(255,87,34,.55), inset 0 0 6px rgba(255,193,7,.35); }
.b-phoenix-v4::before { content: ""; position: absolute; inset: -2px; border-radius: 50%; background: radial-gradient(circle, rgba(255,109,0,.35), transparent 65%); animation: phx4Aura 2.2s ease-in-out infinite; pointer-events: none; }
.b-phoenix-v4 .pic { animation: phx4Counter 6s linear infinite; }
.b-phoenix-v4 .feather-ring { position: absolute; inset: 0; pointer-events: none; }
.b-phoenix-v4 .feather {
  position: absolute;
  top: 50%; left: 50%;
  width: 5px; height: 10px;
  margin: -5px 0 0 -2.5px;
  background:
    linear-gradient(180deg, rgba(255,255,255,.65) 0%, transparent 18%),
    linear-gradient(to top, #b71c1c 0%, #ff3d00 35%, #ff9100 65%, #ffeb3b 95%, transparent 100%);
  border-radius: 50% 50% 50% 50% / 70% 70% 30% 30%;
  transform-origin: 50% 50%;
  filter: drop-shadow(0 0 2px rgba(255,87,34,.7));
  animation: phx4Feather 1.4s ease-in-out infinite;
}
.b-phoenix-v4 .ft1  { transform: rotate(0deg)   translate(0,-44px); animation-delay: 0s; }
.b-phoenix-v4 .ft2  { transform: rotate(30deg)  translate(0,-44px); animation-delay: .11s; }
.b-phoenix-v4 .ft3  { transform: rotate(60deg)  translate(0,-44px); animation-delay: .22s; }
.b-phoenix-v4 .ft4  { transform: rotate(90deg)  translate(0,-44px); animation-delay: .33s; }
.b-phoenix-v4 .ft5  { transform: rotate(120deg) translate(0,-44px); animation-delay: .44s; }
.b-phoenix-v4 .ft6  { transform: rotate(150deg) translate(0,-44px); animation-delay: .55s; }
.b-phoenix-v4 .ft7  { transform: rotate(180deg) translate(0,-44px); animation-delay: .66s; }
.b-phoenix-v4 .ft8  { transform: rotate(210deg) translate(0,-44px); animation-delay: .77s; }
.b-phoenix-v4 .ft9  { transform: rotate(240deg) translate(0,-44px); animation-delay: .88s; }
.b-phoenix-v4 .ft10 { transform: rotate(270deg) translate(0,-44px); animation-delay: .99s; }
.b-phoenix-v4 .ft11 { transform: rotate(300deg) translate(0,-44px); animation-delay: 1.1s; }
.b-phoenix-v4 .ft12 { transform: rotate(330deg) translate(0,-44px); animation-delay: 1.21s; }
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
SET `style_css` = '.b-storm { padding: 2px; background: conic-gradient(from 0deg, #263238, #37474f, #455a64, #37474f, #263238); box-shadow: 0 0 10px rgba(255,235,59,.3); }
.b-storm::before { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 2px solid #ffd600; box-shadow: inset 0 0 8px rgba(255,214,0,.4); animation: stormFlash 3s steps(1) infinite; }
.b-storm .bolt { position: absolute; color: #fff59d; font-weight: 800; font-size: 12px; text-shadow: 0 0 6px #ffd600, 0 0 10px #ff6f00; opacity: 0; }
.b-storm .bz1 { top: -4px; left: 26%; animation: stormBolt 3s ease-out infinite; }
.b-storm .bz2 { bottom: -2px; right: 22%; animation: stormBolt 3s ease-out infinite 1.5s; }
.b-storm .arc { position: absolute; inset: -1px; border-radius: 50%; border: 1px dashed #ffeb3b; opacity: 0; animation: stormArc 3s linear infinite; }
@keyframes stormFlash {
  0%, 28%, 33%, 48%, 53%, 100% { border-color: #ffd600; box-shadow: inset 0 0 8px rgba(255,214,0,.4); }
  30%, 50% { border-color: #fff; box-shadow: inset 0 0 16px rgba(255,255,255,.9), 0 0 18px rgba(255,235,59,1); }
}
@keyframes stormBolt {
  0%, 25%, 100% { opacity: 0; transform: scale(.4); }
  28%, 32% { opacity: 1; transform: scale(1.1); }
  40% { opacity: 0; transform: scale(1.3); }
}
@keyframes stormArc {
  0%, 25%, 100% { opacity: 0; transform: rotate(0deg); }
  30% { opacity: .9; transform: rotate(180deg); }
  50% { opacity: 0; transform: rotate(360deg); }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'storm' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-magma { padding: 2px; background: conic-gradient(from 0deg, #3e2723, #bf360c, #ff6f00, #d84315, #3e2723); animation: magmaCrust 4s ease-in-out infinite; box-shadow: 0 0 10px rgba(216,67,21,.6); }
.b-magma::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from 0deg, transparent 0deg, rgba(255,193,7,.7) 20deg, transparent 60deg, transparent 180deg, rgba(255,87,34,.7) 220deg, transparent 280deg); animation: magmaCrack 3s linear infinite; mix-blend-mode: screen; }
.b-magma .drip { position: absolute; width: 3px; height: 5px; background: linear-gradient(to bottom, #ff6f00, #bf360c); border-radius: 50% 50% 60% 60%; box-shadow: 0 0 4px #ff3d00; }
.b-magma .d1 { bottom: -1px; left: 28%; animation: magmaDrip 2.4s ease-in infinite; }
.b-magma .d2 { bottom: -1px; right: 28%; animation: magmaDrip 2.4s ease-in infinite 1.2s; }
@keyframes magmaCrust {
  0%, 100% { box-shadow: 0 0 10px rgba(216,67,21,.6); }
  50% { box-shadow: 0 0 16px rgba(255,111,0,.9), inset 0 0 6px rgba(255,193,7,.3); }
}
@keyframes magmaCrack { to { transform: rotate(360deg); } }
@keyframes magmaDrip {
  0% { transform: translateY(0) scaleY(1); opacity: 1; }
  100% { transform: translateY(10px) scaleY(1.4); opacity: 0; }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'magma' AND `is_builtin` = 1;
--> statement-breakpoint

-- =========================================================
-- LEGENDARY
-- =========================================================

UPDATE `freeform_borders`
SET `style_css` = '.b-galaxy-v3 { padding: 2px; background: conic-gradient(from 0deg, #0d0033, #4a148c, #1a237e, #6a1b9a, #283593, #c2185b, #4a148c, #0d0033); animation: gx3Spin 7s linear infinite; box-shadow: 0 0 12px rgba(106,27,154,.6); }
.b-galaxy-v3::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(ellipse at 70% 30%, rgba(255,255,255,.4), transparent 35%), radial-gradient(ellipse at 30% 70%, rgba(186,104,200,.5), transparent 40%), radial-gradient(circle at 50% 50%, transparent 40%, rgba(13,0,51,.3) 70%); animation: gx3Drift 7s linear infinite reverse; }
.b-galaxy-v3 .star { position: absolute; background: #fff; border-radius: 50%; box-shadow: 0 0 3px #fff; }
.b-galaxy-v3 .s1 { width: 2px; height: 2px; top: 12%; left: 72%; animation: gx3Twinkle 1.6s ease-in-out infinite; }
.b-galaxy-v3 .s2 { width: 2px; height: 2px; top: 68%; left: 18%; animation: gx3Twinkle 1.6s ease-in-out infinite .4s; }
.b-galaxy-v3 .s3 { width: 2px; height: 2px; top: 30%; left: 12%; animation: gx3Twinkle 1.6s ease-in-out infinite .8s; }
.b-galaxy-v3 .s4 { width: 2px; height: 2px; top: 80%; left: 76%; animation: gx3Twinkle 1.6s ease-in-out infinite 1.2s; }
.b-galaxy-v3 .s5 { width: 2px; height: 2px; top: 20%; left: 50%; animation: gx3Twinkle 1.6s ease-in-out infinite .2s; }
.b-galaxy-v3 .s6 { width: 2px; height: 2px; top: 55%; left: 85%; animation: gx3Twinkle 1.6s ease-in-out infinite .6s; }
.b-galaxy-v3 .s7 { width: 2px; height: 2px; top: 40%; left: 32%; animation: gx3Twinkle 1.6s ease-in-out infinite 1s; }
.b-galaxy-v3 .s8 { width: 2px; height: 2px; top: 85%; left: 46%; animation: gx3Twinkle 1.6s ease-in-out infinite 1.5s; }
.b-galaxy-v3 .pic { animation: gx3Counter 7s linear infinite; }
@keyframes gx3Spin { to { transform: rotate(360deg); } }
@keyframes gx3Counter { to { transform: rotate(-360deg); } }
@keyframes gx3Drift { to { transform: rotate(360deg); } }
@keyframes gx3Twinkle {
  0%, 100% { opacity: .3; transform: scale(.5); }
  50% { opacity: 1; transform: scale(1.4); }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'galaxy-v3' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-royal-v2 { padding: 2px; background: conic-gradient(from 45deg, #ffd700, #b8860b, #ffd700, #fff8dc, #daa520, #ffd700, #b8860b); animation: ry2Shimmer 3.5s linear infinite; box-shadow: 0 0 12px rgba(255,215,0,.5), inset 0 0 5px rgba(255,248,220,.4); }
.b-royal-v2::before { content: ""; position: absolute; inset: -2px; border-radius: 50%; background: conic-gradient(from 0deg, transparent, rgba(255,215,0,.4), transparent, transparent, transparent); animation: ry2Glow 2s linear infinite; }
.b-royal-v2 .gem { position: absolute; width: 6px; height: 6px; transform: rotate(45deg); border: 1px solid #ffd700; box-shadow: 0 0 5px currentColor; }
.b-royal-v2 .gm-ruby { background: linear-gradient(135deg, #ff5252, #b71c1c); color: #ff5252; top: -4px; left: 50%; margin-left: -3px; animation: ry2Gem 2.4s ease-in-out infinite; }
.b-royal-v2 .gm-sapph { background: linear-gradient(135deg, #448aff, #0d47a1); color: #448aff; right: -3px; top: 50%; margin-top: -3px; animation: ry2Gem 2.4s ease-in-out infinite .6s; }
.b-royal-v2 .gm-emer { background: linear-gradient(135deg, #00e676, #1b5e20); color: #00e676; bottom: -4px; left: 50%; margin-left: -3px; animation: ry2Gem 2.4s ease-in-out infinite 1.2s; }
.b-royal-v2 .gm-amth { background: linear-gradient(135deg, #b388ff, #4527a0); color: #b388ff; left: -3px; top: 50%; margin-top: -3px; animation: ry2Gem 2.4s ease-in-out infinite 1.8s; }
.b-royal-v2 .sparkle { position: absolute; width: 3px; height: 3px; background: #fff; border-radius: 50%; box-shadow: 0 0 4px #fff8dc; opacity: 0; }
.b-royal-v2 .sp1 { top: 22%; right: 18%; animation: ry2Sparkle 2s ease-in-out infinite; }
.b-royal-v2 .sp2 { bottom: 26%; left: 22%; animation: ry2Sparkle 2s ease-in-out infinite 1s; }
.b-royal-v2 .pic { animation: ry2Counter 3.5s linear infinite; }
@keyframes ry2Shimmer { to { transform: rotate(360deg); } }
@keyframes ry2Counter { to { transform: rotate(-360deg); } }
@keyframes ry2Glow { to { transform: rotate(360deg); } }
@keyframes ry2Gem {
  0%, 100% { transform: rotate(45deg) scale(1); filter: brightness(1); }
  50% { transform: rotate(45deg) scale(1.2); filter: brightness(1.4); }
}
@keyframes ry2Sparkle {
  0%, 100% { opacity: 0; transform: scale(.3); }
  50% { opacity: 1; transform: scale(1.4); }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'royal-v2' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-holo { padding: 2px; background: conic-gradient(from 0deg, #00bcd4, #e040fb, #00e5ff, #ff4081, #00bcd4); animation: hoSpin 3s linear infinite; box-shadow: 0 0 10px rgba(0,229,255,.5); }
.b-holo::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: repeating-linear-gradient(0deg, transparent 0px, transparent 2px, rgba(0,229,255,.15) 2px, rgba(0,229,255,.15) 3px); animation: hoScan 2s linear infinite; }
.b-holo::after { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 1px solid rgba(224,64,251,.6); animation: hoGlitch 3s steps(1) infinite; }
.b-holo .pic { animation: hoCounter 3s linear infinite, hoShift 4s steps(1) infinite; }
@keyframes hoSpin { to { transform: rotate(360deg); } }
@keyframes hoCounter { to { transform: rotate(-360deg); } }
@keyframes hoScan { from { background-position: 0 0; } to { background-position: 0 16px; } }
@keyframes hoGlitch {
  0%, 92%, 100% { transform: translate(0,0); border-color: rgba(224,64,251,.6); }
  93% { transform: translate(2px, -1px); border-color: #ff4081; }
  95% { transform: translate(-2px, 1px); border-color: #00e5ff; }
  97% { transform: translate(1px, 0); border-color: rgba(224,64,251,.6); }
}
@keyframes hoShift {
  0%, 96%, 100% { transform: rotate(0) translate(0); filter: hue-rotate(0deg); }
  97% { transform: rotate(0) translate(1px, 0); filter: hue-rotate(30deg); }
  98% { transform: rotate(0) translate(-1px, 0); filter: hue-rotate(-30deg); }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'holo' AND `is_builtin` = 1;
--> statement-breakpoint

-- =========================================================
-- MYTHIC
-- =========================================================

UPDATE `freeform_borders`
SET `style_css` = '.b-dragon-v2 { padding: 3px; background: conic-gradient(from 0deg, #4a0e0e, #b71c1c, #ff6f00, #ffab00, #ff6f00, #b71c1c, #4a0e0e); animation: dr2Breath 1.8s ease-in-out infinite; box-shadow: 0 0 14px rgba(244,67,54,.6), inset 0 0 8px rgba(255,193,7,.3); }
.b-dragon-v2::before { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: radial-gradient(circle, rgba(255,87,34,.35) 30%, rgba(255,193,7,.2) 50%, transparent 70%); animation: dr2Aura 1.8s ease-in-out infinite; pointer-events: none; }
.b-dragon-v2::after { content: ""; position: absolute; inset: -1px; border-radius: 50%; border: 1px solid rgba(255,193,7,.7); animation: dr2Ring 2.5s ease-out infinite; }
.b-dragon-v2 .ember { position: absolute; width: 3px; height: 3px; background: #ffeb3b; border-radius: 50%; box-shadow: 0 0 4px #ff6f00, 0 0 6px #ff3d00; }
.b-dragon-v2 .em1 { top: 10%; right: 0; animation: dr2Ember 2.2s ease-out infinite; }
.b-dragon-v2 .em2 { top: 35%; right: 0; animation: dr2Ember 2.2s ease-out infinite .55s; }
.b-dragon-v2 .em3 { top: 62%; right: 0; animation: dr2Ember 2.2s ease-out infinite 1.1s; }
.b-dragon-v2 .em4 { top: 25%; left: 0; animation: dr2EmberL 2.2s ease-out infinite .3s; }
.b-dragon-v2 .em5 { top: 70%; left: 0; animation: dr2EmberL 2.2s ease-out infinite 1.5s; }
.b-dragon-v2 .scale { position: absolute; width: 4px; height: 6px; background: linear-gradient(to bottom, #ff6f00, #b71c1c); border-radius: 50% 50% 0 0; opacity: .7; }
.b-dragon-v2 .sc1 { top: -1px; left: 28%; animation: dr2Scale 2s ease-in-out infinite; }
.b-dragon-v2 .sc2 { top: -1px; left: 62%; animation: dr2Scale 2s ease-in-out infinite .5s; }
@keyframes dr2Breath {
  0%, 100% { box-shadow: 0 0 14px rgba(244,67,54,.6), inset 0 0 8px rgba(255,193,7,.3); transform: scale(1); }
  50% { box-shadow: 0 0 20px rgba(255,87,34,1), inset 0 0 14px rgba(255,193,7,.5); transform: scale(1.02); }
}
@keyframes dr2Aura {
  0%, 100% { opacity: .6; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.08); }
}
@keyframes dr2Ring {
  0% { transform: scale(.95); opacity: .8; }
  100% { transform: scale(1.18); opacity: 0; }
}
@keyframes dr2Ember {
  0% { transform: translate(0,0) scale(1); opacity: 1; }
  100% { transform: translate(6px, -10px) scale(.2); opacity: 0; }
}
@keyframes dr2EmberL {
  0% { transform: translate(0,0) scale(1); opacity: 1; }
  100% { transform: translate(-6px, -10px) scale(.2); opacity: 0; }
}
@keyframes dr2Scale {
  0%, 100% { opacity: .5; transform: scaleY(1); }
  50% { opacity: 1; transform: scaleY(1.3); }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'dragon-v2' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-celestial-v2 { padding: 2px; background: radial-gradient(circle, #fffde7 0%, #fff59d 40%, #ffd54f 70%, #ffa726); box-shadow: 0 0 14px rgba(255,213,79,.8), inset 0 0 6px rgba(255,255,255,.6); }
.b-celestial-v2::before { content: ""; position: absolute; inset: -4px; border-radius: 50%; background: conic-gradient(from 0deg, transparent, rgba(255,235,59,.7), transparent, rgba(255,193,7,.5), transparent, rgba(255,235,59,.7), transparent); animation: cl2Rotate 5s linear infinite; }
.b-celestial-v2::after { content: ""; position: absolute; inset: -1px; border-radius: 50%; border: 1px solid #fff; box-shadow: 0 0 0 1px #ffd54f, 0 0 8px rgba(255,255,255,.9); animation: cl2Pulse 2s ease-in-out infinite; }
.b-celestial-v2 .ray { position: absolute; width: 2px; background: linear-gradient(to top, rgba(255,213,79,1), transparent); top: -7px; left: 50%; margin-left: -1px; height: 8px; transform-origin: 50% 48px; border-radius: 2px; }
.b-celestial-v2 .ry1 { animation: cl2Ray 4s linear infinite; }
.b-celestial-v2 .ry2 { animation: cl2Ray 4s linear infinite -.66s; }
.b-celestial-v2 .ry3 { animation: cl2Ray 4s linear infinite -1.33s; }
.b-celestial-v2 .ry4 { animation: cl2Ray 4s linear infinite -2s; }
.b-celestial-v2 .ry5 { animation: cl2Ray 4s linear infinite -2.66s; }
.b-celestial-v2 .ry6 { animation: cl2Ray 4s linear infinite -3.33s; }
.b-celestial-v2 .wing { position: absolute; width: 12px; height: 18px; background: radial-gradient(ellipse, rgba(255,255,255,.9), rgba(255,235,59,.4) 70%, transparent); border-radius: 50% 10% 50% 50%; filter: blur(.5px); }
.b-celestial-v2 .wL { left: -6px; top: 32%; transform: rotate(-30deg) scaleX(-1); animation: cl2Wing 2s ease-in-out infinite; }
.b-celestial-v2 .wR { right: -6px; top: 32%; transform: rotate(30deg); animation: cl2Wing 2s ease-in-out infinite; }
@keyframes cl2Rotate { to { transform: rotate(360deg); } }
@keyframes cl2Pulse {
  0%, 100% { box-shadow: 0 0 0 1px #ffd54f, 0 0 8px rgba(255,255,255,.9); }
  50% { box-shadow: 0 0 0 1px #fff8e1, 0 0 14px rgba(255,255,255,1), 0 0 22px rgba(255,213,79,.8); }
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
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-void-v2 { padding: 2px; background: radial-gradient(circle, #000 25%, #1a0033 50%, #4a148c 75%, #6a1b9a); box-shadow: 0 0 16px rgba(123,31,162,.9), inset 0 0 10px #000; animation: vd2Pulse 3s ease-in-out infinite; }
.b-void-v2::before { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: conic-gradient(from 0deg, transparent, rgba(186,104,200,.8), rgba(225,190,231,.6), transparent, transparent, rgba(186,104,200,.8), transparent); animation: vd2Disk 4s linear infinite; filter: blur(1px); }
.b-void-v2::after { content: ""; position: absolute; inset: -1px; border-radius: 50%; border: 1px solid #ce93d8; box-shadow: 0 0 6px #ba68c8, inset 0 0 6px rgba(186,104,200,.4); animation: vd2Ring 6s linear infinite reverse; }
.b-void-v2 .ring2 { position: absolute; inset: -5px; border-radius: 50%; border: 1px dashed rgba(206,147,216,.5); animation: vd2Ring 9s linear infinite; }
.b-void-v2 .particle { position: absolute; width: 2px; height: 2px; background: #e1bee7; border-radius: 50%; box-shadow: 0 0 3px #ba68c8, 0 0 6px #7b1fa2; }
.b-void-v2 .pt1 { top: 12%; left: 88%; animation: vd2Pull 2.4s ease-in infinite; }
.b-void-v2 .pt2 { top: 78%; left: 12%; animation: vd2Pull 2.4s ease-in infinite .6s; }
.b-void-v2 .pt3 { top: 50%; left: 95%; animation: vd2Pull 2.4s ease-in infinite 1.2s; }
.b-void-v2 .pt4 { top: 8%; left: 42%; animation: vd2Pull 2.4s ease-in infinite 1.8s; }
.b-void-v2 .pt5 { top: 90%; left: 58%; animation: vd2Pull 2.4s ease-in infinite .3s; }
.b-void-v2 .pic { box-shadow: 0 0 0 2px #1a0033, inset 0 0 10px rgba(123,31,162,.4); }
@keyframes vd2Pulse {
  0%, 100% { box-shadow: 0 0 16px rgba(123,31,162,.9), inset 0 0 10px #000; }
  50% { box-shadow: 0 0 24px rgba(186,104,200,1), inset 0 0 14px #2a0050; }
}
@keyframes vd2Disk { to { transform: rotate(360deg); } }
@keyframes vd2Ring { to { transform: rotate(360deg); } }
@keyframes vd2Pull {
  0% { transform: scale(1) translate(0,0); opacity: 1; }
  100% { transform: scale(.1) translate(-14px, -7px) rotate(180deg); opacity: 0; }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'void-v2' AND `is_builtin` = 1;
--> statement-breakpoint

-- =========================================================
-- EXOTIC
-- =========================================================

UPDATE `freeform_borders`
SET `style_css` = '.b-runic { padding: 2px; background: conic-gradient(from 0deg, #1a237e, #0d47a1, #1565c0, #0d47a1, #1a237e); box-shadow: 0 0 12px rgba(13,71,161,.6); }
.b-runic::before { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 1px solid #4fc3f7; box-shadow: inset 0 0 8px rgba(79,195,247,.4); }
.b-runic .glyph-ring { position: absolute; inset: -6px; animation: runeOrbit 12s linear infinite; }
.b-runic .glyph { position: absolute; font-size: 10px; font-weight: 700; color: #4fc3f7; text-shadow: 0 0 4px #29b6f6, 0 0 8px #0288d1; font-family: ''Times New Roman'', serif; }
.b-runic .g1 { top: 0; left: 50%; margin-left: -5px; animation: runeFlicker 1.5s ease-in-out infinite; }
.b-runic .g2 { right: 0; top: 50%; margin-top: -5px; animation: runeFlicker 1.5s ease-in-out infinite .3s; }
.b-runic .g3 { bottom: 0; left: 50%; margin-left: -5px; animation: runeFlicker 1.5s ease-in-out infinite .6s; }
.b-runic .g4 { left: 0; top: 50%; margin-top: -5px; animation: runeFlicker 1.5s ease-in-out infinite .9s; }
.b-runic .g5 { top: 14%; right: 14%; animation: runeFlicker 1.5s ease-in-out infinite 1.2s; }
.b-runic .g6 { bottom: 14%; left: 14%; animation: runeFlicker 1.5s ease-in-out infinite .45s; }
.b-runic::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; border: 1px solid rgba(79,195,247,.4); animation: runeRing 8s linear infinite reverse; }
@keyframes runeOrbit { to { transform: rotate(360deg); } }
@keyframes runeRing { to { transform: rotate(360deg); } }
@keyframes runeFlicker {
  0%, 100% { opacity: .5; }
  50% { opacity: 1; text-shadow: 0 0 6px #29b6f6, 0 0 10px #03a9f4, 0 0 16px #01579b; }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'runic' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-quantum { padding: 2px; background: conic-gradient(from 0deg, #00bcd4, #00897b, #00bcd4); box-shadow: 0 0 10px rgba(0,188,212,.5); }
.b-quantum::before { content: ""; position: absolute; inset: -1px; border-radius: 50%; border: 1px solid #ff4081; mix-blend-mode: screen; animation: qPhaseA 1.4s ease-in-out infinite; }
.b-quantum::after { content: ""; position: absolute; inset: -1px; border-radius: 50%; border: 1px solid #00e5ff; mix-blend-mode: screen; animation: qPhaseB 1.4s ease-in-out infinite; }
.b-quantum .qdot { position: absolute; width: 3px; height: 3px; border-radius: 50%; }
.b-quantum .qd1 { background: #ff4081; box-shadow: 0 0 4px #ff4081; top: 50%; left: -1px; margin-top: -1.5px; animation: qOrbit 2s linear infinite; }
.b-quantum .qd2 { background: #00e5ff; box-shadow: 0 0 4px #00e5ff; top: 50%; right: -1px; margin-top: -1.5px; animation: qOrbit 2s linear infinite reverse; }
.b-quantum .qd3 { background: #ffeb3b; box-shadow: 0 0 4px #ffeb3b; top: -1px; left: 50%; margin-left: -1.5px; animation: qOrbit 2.6s linear infinite; }
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
SET `style_css` = '.b-prism { padding: 2px; background: conic-gradient(from 0deg, #f44336, #ff9800, #ffeb3b, #4caf50, #00bcd4, #3f51b5, #9c27b0, #f44336); animation: prSpin 4s linear infinite; box-shadow: 0 0 12px rgba(156,39,176,.5); }
.b-prism::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from 90deg, transparent, rgba(255,255,255,.7), transparent, transparent); animation: prShine 2s linear infinite; mix-blend-mode: overlay; }
.b-prism::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: conic-gradient(from 0deg, transparent, rgba(255,255,255,.3), transparent); animation: prHalo 3s linear infinite reverse; filter: blur(2px); }
.b-prism .ref { position: absolute; width: 2px; height: 8px; background: linear-gradient(to top, transparent, currentColor, transparent); border-radius: 2px; }
.b-prism .rf1 { color: #f44336; top: -4px; left: 32%; animation: prRefract 2s ease-in-out infinite; }
.b-prism .rf2 { color: #00bcd4; top: -4px; left: 64%; animation: prRefract 2s ease-in-out infinite .4s; }
.b-prism .rf3 { color: #ffeb3b; bottom: -4px; left: 50%; animation: prRefract 2s ease-in-out infinite .8s; }
.b-prism .pic { animation: prCounter 4s linear infinite; }
@keyframes prSpin { to { transform: rotate(360deg); } }
@keyframes prCounter { to { transform: rotate(-360deg); } }
@keyframes prShine { to { transform: rotate(360deg); } }
@keyframes prHalo { to { transform: rotate(360deg); } }
@keyframes prRefract {
  0%, 100% { opacity: .4; transform: scaleY(1); }
  50% { opacity: 1; transform: scaleY(1.3); }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'prism' AND `is_builtin` = 1;
--> statement-breakpoint

-- =========================================================
-- ATMOSPHERIC
-- =========================================================

UPDATE `freeform_borders`
SET `style_css` = '.b-fog-v2 { position: relative; }
.b-fog-v2 .moon-ring {
  position: absolute; inset: 0; border-radius: 50%;
  border: 2px solid rgba(220,230,255,.85);
  box-shadow: 0 0 8px rgba(200,220,255,.7), 0 0 14px rgba(180,200,240,.45), 0 0 22px rgba(150,170,220,.3), inset 0 0 8px rgba(220,230,255,.4);
  animation: fog2MoonGlow 4.5s ease-in-out infinite;
  z-index: 5;
}
.b-fog-v2 .pic { box-shadow: 0 0 0 2px rgba(220,230,255,.4), 0 0 10px rgba(200,215,240,.4), inset 0 -8px 16px rgba(0,0,0,.15); filter: blur(.5px); }
.b-fog-v2 .fog-band {
  position: absolute; left: -4%; right: -4%;
  border-radius: 50%; pointer-events: none; filter: blur(4px); z-index: 15;
}
.b-fog-v2 .fb1 { top: 22%; height: 10px; background: linear-gradient(90deg, transparent 0%, rgba(230,238,252,.85) 25%, rgba(245,248,255,.95) 50%, rgba(230,238,252,.85) 75%, transparent 100%); animation: fog2BandA 11s ease-in-out infinite; }
.b-fog-v2 .fb2 { top: 48%; height: 14px; background: linear-gradient(90deg, transparent 0%, rgba(220,230,250,.7) 20%, rgba(240,245,255,.88) 50%, rgba(220,230,250,.7) 80%, transparent 100%); animation: fog2BandB 14s ease-in-out infinite; filter: blur(5px); }
.b-fog-v2 .fb3 { top: 68%; height: 9px; background: linear-gradient(90deg, transparent 0%, rgba(225,235,252,.75) 30%, rgba(245,250,255,.92) 50%, rgba(225,235,252,.75) 70%, transparent 100%); animation: fog2BandC 9s ease-in-out infinite; filter: blur(3px); }
.b-fog-v2 .fog-halo { position: absolute; inset: -4px; border-radius: 50%; background: radial-gradient(circle, rgba(220,230,255,.35) 30%, rgba(200,215,245,.18) 55%, transparent 75%); filter: blur(6px); z-index: 1; animation: fog2Halo 6s ease-in-out infinite; pointer-events: none; }
@keyframes fog2MoonGlow {
  0%, 100% { box-shadow: 0 0 8px rgba(200,220,255,.7), 0 0 14px rgba(180,200,240,.45), 0 0 22px rgba(150,170,220,.3), inset 0 0 8px rgba(220,230,255,.4); border-color: rgba(220,230,255,.85); }
  50% { box-shadow: 0 0 12px rgba(220,235,255,1), 0 0 20px rgba(200,220,250,.7), 0 0 30px rgba(170,190,230,.5), inset 0 0 12px rgba(230,240,255,.6); border-color: rgba(245,248,255,1); }
}
@keyframes fog2BandA {
  0%, 100% { transform: translateX(-3%) scaleX(1); opacity: .85; }
  50% { transform: translateX(3%) scaleX(1.04); opacity: 1; }
}
@keyframes fog2BandB {
  0%, 100% { transform: translateX(4%) scaleX(1); opacity: .75; }
  50% { transform: translateX(-4%) scaleX(1.06); opacity: .95; }
}
@keyframes fog2BandC {
  0%, 100% { transform: translateX(-2%) scaleX(1.02); opacity: .8; }
  50% { transform: translateX(4%) scaleX(.97); opacity: 1; }
}
@keyframes fog2Halo {
  0%, 100% { opacity: .7; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.03); }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'fog-v2' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-neon-v2 {
  padding: 0;
  border: 2px solid #ff10f0;
  background: transparent;
  box-shadow:
    0 0 4px #ff66ff, 0 0 8px #ff10f0, 0 0 14px rgba(255,16,240,.7),
    inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 5px rgba(255,16,240,.8);
  animation: neon2Flicker 5s steps(1, end) infinite;
}
.b-neon-v2::after {
  content: ""; position: absolute; inset: 1px;
  border-radius: 50%;
  border: 1px solid transparent;
  pointer-events: none; z-index: 7;
  animation: neon2Tube 5s steps(1, end) infinite;
}
.b-neon-v2::before {
  content: ""; position: absolute; inset: -3px; border-radius: 50%;
  border: 1px solid rgba(255,16,240,.25);
  box-shadow: 0 0 14px rgba(255,16,240,.45);
  animation: neon2Halo 5s steps(1, end) infinite; pointer-events: none;
}
.b-neon-v2 .neon-dim {
  position: absolute; inset: 0; border-radius: 50%;
  background: radial-gradient(circle, transparent 55%, rgba(0,0,0,.4) 85%);
  animation: neon2Dim 5s steps(1, end) infinite;
  pointer-events: none; z-index: 6;
}
.b-neon-v2 .pic { box-shadow: 0 0 0 2px #1a0014, inset 0 -8px 16px rgba(0,0,0,.15); filter: saturate(.9); }
@keyframes neon2Flicker {
  0%, 100% { border-color: #ff10f0; box-shadow: 0 0 4px #ff66ff, 0 0 8px #ff10f0, 0 0 14px rgba(255,16,240,.7), inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 5px rgba(255,16,240,.8); }
  8% { border-color: #b30087; box-shadow: 0 0 2px #b30087, inset 0 0 0 1px rgba(255,200,255,.4), inset 0 0 2px rgba(179,0,135,.4); }
  9% { border-color: #ff10f0; box-shadow: 0 0 4px #ff66ff, 0 0 8px #ff10f0, 0 0 14px rgba(255,16,240,.7), inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 5px rgba(255,16,240,.8); }
  22%, 23% { border-color: rgba(40,0,30,.25); box-shadow: none; }
  24% { border-color: #ff10f0; box-shadow: 0 0 5px #ff66ff, 0 0 10px #ff10f0, 0 0 18px rgba(255,16,240,.8), inset 0 0 0 1px rgba(255,255,255,.95), inset 0 0 3px rgba(255,220,255,1), inset 0 0 6px rgba(255,16,240,.9); }
  35% { border-color: #ff66ff; box-shadow: 0 0 8px #ffaaff, 0 0 14px #ff10f0, 0 0 22px rgba(255,16,240,.9), inset 0 0 0 2px rgba(255,255,255,1), inset 0 0 5px rgba(255,230,255,1), inset 0 0 10px rgba(255,16,240,.8); }
  36% { border-color: #ff10f0; box-shadow: 0 0 4px #ff66ff, 0 0 8px #ff10f0, 0 0 14px rgba(255,16,240,.7), inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 5px rgba(255,16,240,.8); }
  48%, 49% { border-color: rgba(40,0,30,.25); box-shadow: none; }
  50% { border-color: #ff10f0; box-shadow: 0 0 4px #ff66ff, 0 0 8px #ff10f0, 0 0 14px rgba(255,16,240,.7), inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 5px rgba(255,16,240,.8); }
  51%, 52% { border-color: rgba(40,0,30,.25); box-shadow: none; }
  53% { border-color: #ff10f0; box-shadow: 0 0 4px #ff66ff, 0 0 8px #ff10f0, 0 0 14px rgba(255,16,240,.7), inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 5px rgba(255,16,240,.8); }
  70% { border-color: #c2009e; box-shadow: 0 0 3px #c2009e, inset 0 0 0 1px rgba(255,200,255,.6), inset 0 0 3px rgba(194,0,158,.5); }
  78% { border-color: #ff10f0; box-shadow: 0 0 4px #ff66ff, 0 0 8px #ff10f0, 0 0 14px rgba(255,16,240,.7), inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 5px rgba(255,16,240,.8); }
  90%, 91% { border-color: rgba(40,0,30,.25); box-shadow: none; }
  92% { border-color: #ff10f0; box-shadow: 0 0 4px #ff66ff, 0 0 8px #ff10f0, 0 0 14px rgba(255,16,240,.7), inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 5px rgba(255,16,240,.8); }
}
@keyframes neon2Tube {
  0%, 100% { border-color: rgba(255,230,255,.95); box-shadow: 0 0 3px rgba(255,150,240,1), inset 0 0 3px rgba(255,200,255,.9); }
  22%, 23% { border-color: transparent; box-shadow: none; }
  24% { border-color: rgba(255,230,255,.95); box-shadow: 0 0 3px rgba(255,150,240,1), inset 0 0 3px rgba(255,200,255,.9); }
  35% { border-color: rgba(255,255,255,1); box-shadow: 0 0 6px rgba(255,200,255,1), inset 0 0 4px rgba(255,230,255,1); }
  36% { border-color: rgba(255,230,255,.95); box-shadow: 0 0 3px rgba(255,150,240,1), inset 0 0 3px rgba(255,200,255,.9); }
  48%, 49% { border-color: transparent; box-shadow: none; }
  50% { border-color: rgba(255,230,255,.95); box-shadow: 0 0 3px rgba(255,150,240,1), inset 0 0 3px rgba(255,200,255,.9); }
  51%, 52% { border-color: transparent; box-shadow: none; }
  53% { border-color: rgba(255,230,255,.95); box-shadow: 0 0 3px rgba(255,150,240,1), inset 0 0 3px rgba(255,200,255,.9); }
  70% { border-color: rgba(255,200,240,.5); box-shadow: 0 0 2px rgba(194,0,158,.6); }
  78% { border-color: rgba(255,230,255,.95); box-shadow: 0 0 3px rgba(255,150,240,1), inset 0 0 3px rgba(255,200,255,.9); }
  90%, 91% { border-color: transparent; box-shadow: none; }
  92% { border-color: rgba(255,230,255,.95); box-shadow: 0 0 3px rgba(255,150,240,1), inset 0 0 3px rgba(255,200,255,.9); }
}
@keyframes neon2Halo {
  0%, 100% { border-color: rgba(255,16,240,.25); box-shadow: 0 0 14px rgba(255,16,240,.45); }
  22%, 23% { border-color: transparent; box-shadow: none; }
  24% { border-color: rgba(255,16,240,.25); box-shadow: 0 0 14px rgba(255,16,240,.45); }
  35% { border-color: rgba(255,16,240,.4); box-shadow: 0 0 22px rgba(255,16,240,.75); }
  36% { border-color: rgba(255,16,240,.25); box-shadow: 0 0 14px rgba(255,16,240,.45); }
  48%, 49% { border-color: transparent; box-shadow: none; }
  50% { border-color: rgba(255,16,240,.25); box-shadow: 0 0 14px rgba(255,16,240,.45); }
  51%, 52% { border-color: transparent; box-shadow: none; }
  53% { border-color: rgba(255,16,240,.25); box-shadow: 0 0 14px rgba(255,16,240,.45); }
  70% { border-color: rgba(194,0,158,.2); box-shadow: 0 0 6px rgba(194,0,158,.3); }
  78% { border-color: rgba(255,16,240,.25); box-shadow: 0 0 14px rgba(255,16,240,.45); }
  90%, 91% { border-color: transparent; box-shadow: none; }
  92% { border-color: rgba(255,16,240,.25); box-shadow: 0 0 14px rgba(255,16,240,.45); }
}
@keyframes neon2Dim {
  0%, 100% { opacity: 0; }
  22%, 23% { opacity: 1; }
  24% { opacity: 0; }
  48%, 49% { opacity: 1; }
  50% { opacity: 0; }
  51%, 52% { opacity: 1; }
  53% { opacity: 0; }
  90%, 91% { opacity: 1; }
  92% { opacity: 0; }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'neon-v2' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-sakura-v2 {
  padding: 0;
  border: 2px solid #ffe4ef;
  background: transparent;
  box-shadow:
    0 0 0 1px rgba(255,235,245,.9), 0 0 8px rgba(255,224,236,.85), 0 0 14px rgba(255,200,222,.55), 0 0 22px rgba(244,127,170,.3),
    inset 0 0 6px rgba(255,240,247,.7);
  animation: sk2Pulse 3.2s ease-in-out infinite;
}
.b-sakura-v2 .petal-field {
  position: absolute;
  inset: -6px -4px -8px -4px;
  border-radius: 50%;
  pointer-events: none;
  overflow: visible;
  z-index: 20;
}
.b-sakura-v2 .petal {
  position: absolute;
  width: 6px; height: 5px;
  background:
    radial-gradient(circle at 70% 28%, rgba(255,255,255,.7) 0 1px, transparent 1.5px),
    radial-gradient(ellipse at 35% 75%, rgba(228,109,155,.35) 0 2px, transparent 2.8px),
    linear-gradient(135deg, var(--pc, #ffd8e8) 0%, var(--pc2, #ffabc9) 55%, var(--pc3, #f47faa) 100%);
  border-radius: 78% 22% 74% 26%;
  transform-origin: 55% 70%;
  filter: drop-shadow(0 0 1px rgba(255,255,255,.55)) drop-shadow(0 1px 1px rgba(160,70,105,.18));
  opacity: 0;
}
.b-sakura-v2 .p1  { --pc: #fffafc; --pc2: #ffe4ef; --pc3: #ffc4d8; left: 4%;  top: -5px; animation: sk2Drop 5.7s ease-in-out -.4s infinite; }
.b-sakura-v2 .p2  { --pc: #ffd8e8; --pc2: #ffabc9; --pc3: #f47faa; left: 16%; top: -5px; animation: sk2Drop 7.1s ease-in-out -2.2s infinite; }
.b-sakura-v2 .p3  { --pc: #ffeaf2; --pc2: #ffcadd; --pc3: #ff9ec0; left: 28%; top: -5px; animation: sk2Drop 6.4s ease-in-out -1.1s infinite; }
.b-sakura-v2 .p4  { --pc: #ffabc9; --pc2: #f47faa; --pc3: #e46d9b; left: 40%; top: -5px; animation: sk2Drop 8.2s ease-in-out -3.6s infinite; }
.b-sakura-v2 .p5  { --pc: #fffafc; --pc2: #ffd8e8; --pc3: #ffabc9; left: 52%; top: -5px; animation: sk2Drop 5.9s ease-in-out -2.9s infinite; }
.b-sakura-v2 .p6  { --pc: #ffd8e8; --pc2: #f47faa; --pc3: #c95480; left: 64%; top: -5px; animation: sk2Drop 7.6s ease-in-out -1.7s infinite; }
.b-sakura-v2 .p7  { --pc: #ffeaf2; --pc2: #ffabc9; --pc3: #f47faa; left: 76%; top: -5px; animation: sk2Drop 6.8s ease-in-out -4.4s infinite; }
.b-sakura-v2 .p8  { --pc: #ffabc9; --pc2: #e46d9b; --pc3: #b04572; left: 86%; top: -5px; animation: sk2Drop 8.8s ease-in-out -5.5s infinite; }
.b-sakura-v2 .p9  { --pc: #fffafc; --pc2: #ffcadd; --pc3: #ffabc9; left: 36%; top: -5px; animation: sk2Drop 9.2s ease-in-out -6.3s infinite; }
.b-sakura-v2 .p10 { --pc: #ffd8e8; --pc2: #ffabc9; --pc3: #e46d9b; left: 58%; top: -5px; animation: sk2Drop 7.9s ease-in-out -5.1s infinite; }
.b-sakura-v2 .petal-pile {
  position: absolute;
  left: 8%; right: 8%; bottom: -2px;
  height: 6px;
  pointer-events: none;
  border-radius: 999em;
  background:
    radial-gradient(ellipse at center, rgba(255,171,201,.45) 0, rgba(244,127,170,.22) 44%, transparent 78%),
    linear-gradient(90deg, transparent 0, rgba(255,213,230,.35) 50%, transparent 100%);
  filter: blur(1.5px);
  opacity: .4;
  z-index: 21;
  animation: sk2Pile 5.8s ease-in-out infinite;
}
.b-sakura-v2 .pic { box-shadow: 0 0 6px rgba(255,200,222,.5), inset 0 -8px 16px rgba(0,0,0,.15); }
@keyframes sk2Pulse {
  0%, 100% { border-color: #ffe4ef; box-shadow: 0 0 0 1px rgba(255,235,245,.9), 0 0 8px rgba(255,224,236,.85), 0 0 14px rgba(255,200,222,.55), 0 0 22px rgba(244,127,170,.3), inset 0 0 6px rgba(255,240,247,.7); }
  50% { border-color: #fff0f6; box-shadow: 0 0 0 1px rgba(255,245,250,1), 0 0 12px rgba(255,235,245,1), 0 0 20px rgba(255,210,228,.75), 0 0 30px rgba(244,127,170,.45), inset 0 0 10px rgba(255,248,251,.9); }
}
@keyframes sk2Drop {
  0% { transform: translate3d(0, -2px, 0) rotate(-30deg) scale(.78); opacity: 0; }
  10% { opacity: .95; }
  35% { transform: translate3d(-3px, 10px, 0) rotate(60deg) scale(.82); opacity: 1; }
  65% { transform: translate3d(4px, 20px, 0) rotate(180deg) scale(.85); opacity: .7; }
  100% { transform: translate3d(0, 32px, 0) rotate(360deg) scale(.7); opacity: 0; }
}
@keyframes sk2Pile {
  0%, 12% { opacity: .12; transform: scaleX(.72) scaleY(.65); }
  48% { opacity: .45; transform: scaleX(1) scaleY(.85); }
  82%, 100% { opacity: .1; transform: scaleX(1.08) scaleY(.74); }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'sakura-v2' AND `is_builtin` = 1;
