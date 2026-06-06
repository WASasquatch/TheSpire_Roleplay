-- Seed the 18 reference free-form borders from
-- complete_avatar_borders.html into the `freeform_borders` catalog.
--
-- All rows ship as `is_builtin = 1` so admin DELETE refuses them
-- (the editor must disable rather than remove, disabling hides
-- the row from the picker while keeping any user equip slots
-- intact). Costs are placeholders tuned by tier; admins re-price
-- via the Flair admin tab without a code change.
--
-- Templates omit the placeholder `.pic` letter from the demo HTML
-- and substitute `{avatar}` which the renderer expands to the
-- viewer's avatar `<img>` (or initials fallback when no avatar).
-- `.av` + `.pic` base styles live in the injector preamble, each
-- row only carries its own `.b-<key>` chain so the SQL stays bounded.
--
-- Idempotent: INSERT OR IGNORE on the primary key (`key`) protects
-- re-runs after a baseline skip on an older install. Admins who
-- edit a seeded row's CSS / template via the admin UI keep their
-- changes, subsequent migration runs don't overwrite.

-- =========================================================
-- RARE, refined
-- =========================================================

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('aurora-v2',
   'Aurora prime',
   'Polar light wash with shimmer.',
   NULL,
   '<div class="av b-aurora-v2"><div class="pic">{avatar}</div></div>',
   '.b-aurora-v2 { padding: 4px; background: conic-gradient(from 0deg, #00e5ff, #4dd0e1, #80deea, #b39ddb, #4dd0e1, #00bcd4, #00e5ff); animation: aV2Spin 5s linear infinite; box-shadow: 0 0 16px rgba(0,229,255,.4); }
.b-aurora-v2::before { content: ""; position: absolute; inset: -2px; border-radius: 50%; background: conic-gradient(from 180deg, transparent, rgba(255,255,255,.6), transparent, transparent); animation: aV2Wash 3s linear infinite; mix-blend-mode: overlay; }
.b-aurora-v2 .pic { animation: aV2Counter 5s linear infinite; }
@keyframes aV2Spin { to { transform: rotate(360deg); } }
@keyframes aV2Counter { to { transform: rotate(-360deg); } }
@keyframes aV2Wash { to { transform: rotate(-360deg); } }',
   'rare', 50000, 1, 1, 10);
--> statement-breakpoint

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('tide',
   'Tide caller',
   'Ocean ripples expand outward.',
   NULL,
   '<div class="av b-tide"><div class="pic">{avatar}</div></div>',
   '.b-tide { padding: 3px; background: conic-gradient(from 90deg, #006064, #00838f, #0097a7, #4dd0e1, #006064); animation: tideRotate 8s linear infinite; box-shadow: 0 0 14px rgba(0,151,167,.5), inset 0 0 8px rgba(255,255,255,.2); }
.b-tide::before { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 2px solid rgba(178,235,242,.7); animation: tideRipple 2.5s ease-out infinite; }
.b-tide::after { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 2px solid rgba(178,235,242,.7); animation: tideRipple 2.5s ease-out infinite 1.25s; }
.b-tide .pic { animation: tideRotate 8s linear infinite reverse; }
@keyframes tideRotate { to { transform: rotate(360deg); } }
@keyframes tideRipple {
  0% { transform: scale(.96); opacity: 1; border-width: 2px; }
  100% { transform: scale(1.35); opacity: 0; border-width: 1px; }
}',
   'rare', 50000, 1, 1, 11);
--> statement-breakpoint

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('forest',
   'Sylvan',
   'Falling autumn leaves.',
   NULL,
   '<div class="av b-forest"><div class="leaf lf1"></div><div class="leaf lf2"></div><div class="leaf lf3"></div><div class="pic">{avatar}</div></div>',
   '.b-forest { padding: 3px; background: conic-gradient(from 45deg, #2e7d32, #66bb6a, #aed581, #66bb6a, #1b5e20); animation: forestSway 6s ease-in-out infinite; box-shadow: 0 0 12px rgba(102,187,106,.4); }
.b-forest .leaf { position: absolute; width: 8px; height: 12px; background: #66bb6a; border-radius: 0 100% 0 100%; box-shadow: inset 0 0 0 1px #2e7d32; }
.b-forest .lf1 { top: -8px; left: 30%; animation: leafFall 4s ease-in infinite; }
.b-forest .lf2 { top: -8px; left: 65%; animation: leafFall 4s ease-in infinite 1.3s; }
.b-forest .lf3 { top: -8px; left: 45%; animation: leafFall 4s ease-in infinite 2.6s; }
.b-forest .pic { animation: forestSway 6s ease-in-out infinite reverse; }
@keyframes forestSway {
  0%, 100% { transform: rotate(-3deg); }
  50% { transform: rotate(3deg); }
}
@keyframes leafFall {
  0% { transform: translateY(0) rotate(0deg); opacity: 0; }
  15% { opacity: 1; }
  100% { transform: translateY(110px) rotate(540deg) translateX(20px); opacity: 0; }
}',
   'rare', 50000, 1, 1, 12);
--> statement-breakpoint

-- =========================================================
-- EPIC, elemental
-- =========================================================

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('phoenix-v4',
   'Phoenix plumage',
   'Aligned feather crown shimmers.',
   NULL,
   '<div class="av b-phoenix-v4"><div class="feather-ring"><div class="feather ft1"></div><div class="feather ft2"></div><div class="feather ft3"></div><div class="feather ft4"></div><div class="feather ft5"></div><div class="feather ft6"></div><div class="feather ft7"></div><div class="feather ft8"></div><div class="feather ft9"></div><div class="feather ft10"></div><div class="feather ft11"></div><div class="feather ft12"></div></div><div class="pic">{avatar}</div></div>',
   '.b-phoenix-v4 { padding: 4px; background: conic-gradient(from 90deg, #ff1744, #ff6f00, #ffab00, #ff3d00, #ff1744); animation: phx4Spin 6s linear infinite; box-shadow: 0 0 18px rgba(255,87,34,.55), inset 0 0 10px rgba(255,193,7,.35); }
.b-phoenix-v4::before { content: ""; position: absolute; inset: -10px; border-radius: 50%; background: radial-gradient(circle, rgba(255,109,0,.35), transparent 65%); animation: phx4Aura 2.2s ease-in-out infinite; pointer-events: none; }
.b-phoenix-v4 .pic { animation: phx4Counter 6s linear infinite; }
.b-phoenix-v4 .feather-ring { position: absolute; inset: 0; pointer-events: none; }
.b-phoenix-v4 .feather {
  position: absolute;
  top: 50%; left: 50%;
  width: 9px; height: 22px;
  margin: -11px 0 0 -4.5px;
  background:
    linear-gradient(180deg, rgba(255,255,255,.65) 0%, transparent 18%),
    linear-gradient(to top, #b71c1c 0%, #ff3d00 35%, #ff9100 65%, #ffeb3b 95%, transparent 100%);
  border-radius: 50% 50% 50% 50% / 70% 70% 30% 30%;
  transform-origin: 50% 50%;
  filter: drop-shadow(0 0 3px rgba(255,87,34,.7));
  animation: phx4Feather 1.4s ease-in-out infinite;
}
.b-phoenix-v4 .feather::before {
  content: ""; position: absolute; left: 50%; top: 10%;
  width: 1px; height: 70%;
  background: linear-gradient(to top, rgba(120,30,0,.6), transparent);
  transform: translateX(-50%);
}
.b-phoenix-v4 .ft1  { transform: rotate(0deg)   translate(0,-58px); animation-delay: 0s; }
.b-phoenix-v4 .ft2  { transform: rotate(30deg)  translate(0,-58px); animation-delay: .11s; }
.b-phoenix-v4 .ft3  { transform: rotate(60deg)  translate(0,-58px); animation-delay: .22s; }
.b-phoenix-v4 .ft4  { transform: rotate(90deg)  translate(0,-58px); animation-delay: .33s; }
.b-phoenix-v4 .ft5  { transform: rotate(120deg) translate(0,-58px); animation-delay: .44s; }
.b-phoenix-v4 .ft6  { transform: rotate(150deg) translate(0,-58px); animation-delay: .55s; }
.b-phoenix-v4 .ft7  { transform: rotate(180deg) translate(0,-58px); animation-delay: .66s; }
.b-phoenix-v4 .ft8  { transform: rotate(210deg) translate(0,-58px); animation-delay: .77s; }
.b-phoenix-v4 .ft9  { transform: rotate(240deg) translate(0,-58px); animation-delay: .88s; }
.b-phoenix-v4 .ft10 { transform: rotate(270deg) translate(0,-58px); animation-delay: .99s; }
.b-phoenix-v4 .ft11 { transform: rotate(300deg) translate(0,-58px); animation-delay: 1.1s; }
.b-phoenix-v4 .ft12 { transform: rotate(330deg) translate(0,-58px); animation-delay: 1.21s; }
@keyframes phx4Spin { to { transform: rotate(360deg); } }
@keyframes phx4Counter { to { transform: rotate(-360deg); } }
@keyframes phx4Aura {
  0%, 100% { opacity: .55; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.12); }
}
@keyframes phx4Feather {
  0%, 100% { filter: drop-shadow(0 0 3px rgba(255,87,34,.7)) brightness(1); }
  50% { filter: drop-shadow(0 0 7px rgba(255,193,7,1)) brightness(1.3); }
}',
   'epic', 150000, 1, 1, 20);
--> statement-breakpoint

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('storm',
   'Tempest lord',
   'Lightning strikes the ring.',
   NULL,
   '<div class="av b-storm"><div class="bolt bz1">⚡</div><div class="bolt bz2">⚡</div><div class="arc"></div><div class="pic">{avatar}</div></div>',
   '.b-storm { padding: 4px; background: conic-gradient(from 0deg, #263238, #37474f, #455a64, #37474f, #263238); box-shadow: 0 0 18px rgba(255,235,59,.3); }
.b-storm::before { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 2px solid #ffd600; box-shadow: inset 0 0 12px rgba(255,214,0,.4); animation: stormFlash 3s steps(1) infinite; }
.b-storm .bolt { position: absolute; color: #fff59d; font-weight: 800; font-size: 22px; text-shadow: 0 0 10px #ffd600, 0 0 20px #ff6f00; opacity: 0; }
.b-storm .bz1 { top: -12px; left: 20%; animation: stormBolt 3s ease-out infinite; }
.b-storm .bz2 { bottom: -8px; right: 15%; animation: stormBolt 3s ease-out infinite 1.5s; }
.b-storm .arc { position: absolute; inset: -3px; border-radius: 50%; border: 1px dashed #ffeb3b; opacity: 0; animation: stormArc 3s linear infinite; }
@keyframes stormFlash {
  0%, 28%, 33%, 48%, 53%, 100% { border-color: #ffd600; box-shadow: inset 0 0 12px rgba(255,214,0,.4); }
  30%, 50% { border-color: #fff; box-shadow: inset 0 0 24px rgba(255,255,255,.9), 0 0 30px rgba(255,235,59,1); }
}
@keyframes stormBolt {
  0%, 25%, 100% { opacity: 0; transform: scale(.4); }
  28%, 32% { opacity: 1; transform: scale(1.3); }
  40% { opacity: 0; transform: scale(1.5); }
}
@keyframes stormArc {
  0%, 25%, 100% { opacity: 0; transform: rotate(0deg); }
  30% { opacity: .9; transform: rotate(180deg); }
  50% { opacity: 0; transform: rotate(360deg); }
}',
   'epic', 150000, 1, 1, 21);
--> statement-breakpoint

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('magma',
   'Magma core',
   'Cracked molten crust drips.',
   NULL,
   '<div class="av b-magma"><div class="drip d1"></div><div class="drip d2"></div><div class="pic">{avatar}</div></div>',
   '.b-magma { padding: 4px; background: conic-gradient(from 0deg, #3e2723, #bf360c, #ff6f00, #d84315, #3e2723); animation: magmaCrust 4s ease-in-out infinite; box-shadow: 0 0 16px rgba(216,67,21,.6); }
.b-magma::before { content: ""; position: absolute; inset: -2px; border-radius: 50%; background: conic-gradient(from 0deg, transparent 0deg, rgba(255,193,7,.7) 20deg, transparent 60deg, transparent 180deg, rgba(255,87,34,.7) 220deg, transparent 280deg); animation: magmaCrack 3s linear infinite; mix-blend-mode: screen; }
.b-magma .drip { position: absolute; width: 5px; height: 8px; background: linear-gradient(to bottom, #ff6f00, #bf360c); border-radius: 50% 50% 60% 60%; box-shadow: 0 0 6px #ff3d00; }
.b-magma .d1 { bottom: -3px; left: 25%; animation: magmaDrip 2.4s ease-in infinite; }
.b-magma .d2 { bottom: -3px; right: 25%; animation: magmaDrip 2.4s ease-in infinite 1.2s; }
@keyframes magmaCrust {
  0%, 100% { box-shadow: 0 0 16px rgba(216,67,21,.6); }
  50% { box-shadow: 0 0 28px rgba(255,111,0,.9), inset 0 0 10px rgba(255,193,7,.3); }
}
@keyframes magmaCrack { to { transform: rotate(360deg); } }
@keyframes magmaDrip {
  0% { transform: translateY(0) scaleY(1); opacity: 1; }
  100% { transform: translateY(18px) scaleY(1.6); opacity: 0; }
}',
   'epic', 150000, 1, 1, 22);
--> statement-breakpoint

-- =========================================================
-- LEGENDARY, prestige
-- =========================================================

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('galaxy-v3',
   'Nebula crown',
   'Dense starfield over swirling nebula.',
   NULL,
   '<div class="av b-galaxy-v3"><div class="star s1"></div><div class="star s2"></div><div class="star s3"></div><div class="star s4"></div><div class="star s5"></div><div class="star s6"></div><div class="star s7"></div><div class="star s8"></div><div class="pic">{avatar}</div></div>',
   '.b-galaxy-v3 { padding: 4px; background: conic-gradient(from 0deg, #0d0033, #4a148c, #1a237e, #6a1b9a, #283593, #c2185b, #4a148c, #0d0033); animation: gx3Spin 7s linear infinite; box-shadow: 0 0 20px rgba(106,27,154,.6); }
.b-galaxy-v3::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(ellipse at 70% 30%, rgba(255,255,255,.4), transparent 35%), radial-gradient(ellipse at 30% 70%, rgba(186,104,200,.5), transparent 40%), radial-gradient(circle at 50% 50%, transparent 40%, rgba(13,0,51,.3) 70%); animation: gx3Drift 7s linear infinite reverse; }
.b-galaxy-v3 .star { position: absolute; background: #fff; border-radius: 50%; box-shadow: 0 0 4px #fff, 0 0 8px rgba(255,255,255,.6); }
.b-galaxy-v3 .s1 { width: 3px; height: 3px; top: 12%; left: 75%; animation: gx3Twinkle 1.6s ease-in-out infinite; }
.b-galaxy-v3 .s2 { width: 2px; height: 2px; top: 68%; left: 15%; animation: gx3Twinkle 1.6s ease-in-out infinite .4s; }
.b-galaxy-v3 .s3 { width: 3px; height: 3px; top: 30%; left: 8%; animation: gx3Twinkle 1.6s ease-in-out infinite .8s; }
.b-galaxy-v3 .s4 { width: 2px; height: 2px; top: 82%; left: 78%; animation: gx3Twinkle 1.6s ease-in-out infinite 1.2s; }
.b-galaxy-v3 .s5 { width: 2px; height: 2px; top: 18%; left: 50%; animation: gx3Twinkle 1.6s ease-in-out infinite .2s; }
.b-galaxy-v3 .s6 { width: 3px; height: 3px; top: 55%; left: 88%; animation: gx3Twinkle 1.6s ease-in-out infinite .6s; }
.b-galaxy-v3 .s7 { width: 2px; height: 2px; top: 40%; left: 32%; animation: gx3Twinkle 1.6s ease-in-out infinite 1s; }
.b-galaxy-v3 .s8 { width: 2px; height: 2px; top: 88%; left: 45%; animation: gx3Twinkle 1.6s ease-in-out infinite 1.5s; }
.b-galaxy-v3 .pic { animation: gx3Counter 7s linear infinite; }
@keyframes gx3Spin { to { transform: rotate(360deg); } }
@keyframes gx3Counter { to { transform: rotate(-360deg); } }
@keyframes gx3Drift { to { transform: rotate(360deg); } }
@keyframes gx3Twinkle {
  0%, 100% { opacity: .3; transform: scale(.5); }
  50% { opacity: 1; transform: scale(1.5); }
}',
   'legendary', 400000, 1, 1, 30);
--> statement-breakpoint

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('royal-v2',
   'Crown jewels',
   'Four gemstones set in gold.',
   NULL,
   '<div class="av b-royal-v2"><div class="gem gm-ruby"></div><div class="gem gm-sapph"></div><div class="gem gm-emer"></div><div class="gem gm-amth"></div><div class="sparkle sp1"></div><div class="sparkle sp2"></div><div class="pic">{avatar}</div></div>',
   '.b-royal-v2 { padding: 4px; background: conic-gradient(from 45deg, #ffd700, #b8860b, #ffd700, #fff8dc, #daa520, #ffd700, #b8860b); animation: ry2Shimmer 3.5s linear infinite; box-shadow: 0 0 18px rgba(255,215,0,.5), inset 0 0 8px rgba(255,248,220,.4); }
.b-royal-v2::before { content: ""; position: absolute; inset: -6px; border-radius: 50%; background: conic-gradient(from 0deg, transparent, rgba(255,215,0,.4), transparent, transparent, transparent); animation: ry2Glow 2s linear infinite; }
.b-royal-v2 .gem { position: absolute; width: 9px; height: 9px; transform: rotate(45deg); border: 1px solid #ffd700; box-shadow: 0 0 8px currentColor; }
.b-royal-v2 .gm-ruby { background: linear-gradient(135deg, #ff5252, #b71c1c); color: #ff5252; top: -10px; left: 50%; margin-left: -5px; animation: ry2Gem 2.4s ease-in-out infinite; }
.b-royal-v2 .gm-sapph { background: linear-gradient(135deg, #448aff, #0d47a1); color: #448aff; right: -6px; top: 50%; margin-top: -5px; animation: ry2Gem 2.4s ease-in-out infinite .6s; }
.b-royal-v2 .gm-emer { background: linear-gradient(135deg, #00e676, #1b5e20); color: #00e676; bottom: -10px; left: 50%; margin-left: -5px; animation: ry2Gem 2.4s ease-in-out infinite 1.2s; }
.b-royal-v2 .gm-amth { background: linear-gradient(135deg, #b388ff, #4527a0); color: #b388ff; left: -6px; top: 50%; margin-top: -5px; animation: ry2Gem 2.4s ease-in-out infinite 1.8s; }
.b-royal-v2 .sparkle { position: absolute; width: 4px; height: 4px; background: #fff; border-radius: 50%; box-shadow: 0 0 6px #fff8dc; opacity: 0; }
.b-royal-v2 .sp1 { top: 20%; right: 15%; animation: ry2Sparkle 2s ease-in-out infinite; }
.b-royal-v2 .sp2 { bottom: 25%; left: 20%; animation: ry2Sparkle 2s ease-in-out infinite 1s; }
.b-royal-v2 .pic { animation: ry2Counter 3.5s linear infinite; }
@keyframes ry2Shimmer { to { transform: rotate(360deg); } }
@keyframes ry2Counter { to { transform: rotate(-360deg); } }
@keyframes ry2Glow { to { transform: rotate(360deg); } }
@keyframes ry2Gem {
  0%, 100% { transform: rotate(45deg) scale(1); filter: brightness(1); }
  50% { transform: rotate(45deg) scale(1.25); filter: brightness(1.4); }
}
@keyframes ry2Sparkle {
  0%, 100% { opacity: 0; transform: scale(.3); }
  50% { opacity: 1; transform: scale(1.5); }
}',
   'legendary', 400000, 1, 1, 31);
--> statement-breakpoint

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('holo',
   'Hologram',
   'Scanlines and chromatic shift.',
   NULL,
   '<div class="av b-holo"><div class="pic">{avatar}</div></div>',
   '.b-holo { padding: 4px; background: conic-gradient(from 0deg, #00bcd4, #e040fb, #00e5ff, #ff4081, #00bcd4); animation: hoSpin 3s linear infinite; box-shadow: 0 0 16px rgba(0,229,255,.5); }
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
   'legendary', 400000, 1, 1, 32);
--> statement-breakpoint

-- =========================================================
-- MYTHIC, godlike
-- =========================================================

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('dragon-v2',
   'Wyrm sovereign',
   'Scaled with ember spray.',
   NULL,
   '<div class="av b-dragon-v2"><div class="scale sc1"></div><div class="scale sc2"></div><div class="ember em1"></div><div class="ember em2"></div><div class="ember em3"></div><div class="ember em4"></div><div class="ember em5"></div><div class="pic">{avatar}</div></div>',
   '.b-dragon-v2 { padding: 5px; background: conic-gradient(from 0deg, #4a0e0e, #b71c1c, #ff6f00, #ffab00, #ff6f00, #b71c1c, #4a0e0e); animation: dr2Breath 1.8s ease-in-out infinite; box-shadow: 0 0 24px rgba(244,67,54,.6), inset 0 0 12px rgba(255,193,7,.3); }
.b-dragon-v2::before { content: ""; position: absolute; inset: -12px; border-radius: 50%; background: radial-gradient(circle, rgba(255,87,34,.35) 30%, rgba(255,193,7,.2) 50%, transparent 70%); animation: dr2Aura 1.8s ease-in-out infinite; pointer-events: none; }
.b-dragon-v2::after { content: ""; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid rgba(255,193,7,.7); animation: dr2Ring 2.5s ease-out infinite; }
.b-dragon-v2 .ember { position: absolute; width: 4px; height: 4px; background: #ffeb3b; border-radius: 50%; box-shadow: 0 0 6px #ff6f00, 0 0 12px #ff3d00; }
.b-dragon-v2 .em1 { top: 8%; right: -2px; animation: dr2Ember 2.2s ease-out infinite; }
.b-dragon-v2 .em2 { top: 35%; right: -8px; animation: dr2Ember 2.2s ease-out infinite .55s; }
.b-dragon-v2 .em3 { top: 60%; right: -4px; animation: dr2Ember 2.2s ease-out infinite 1.1s; }
.b-dragon-v2 .em4 { top: 25%; left: -6px; animation: dr2EmberL 2.2s ease-out infinite .3s; }
.b-dragon-v2 .em5 { top: 70%; left: -2px; animation: dr2EmberL 2.2s ease-out infinite 1.5s; }
.b-dragon-v2 .scale { position: absolute; width: 6px; height: 8px; background: linear-gradient(to bottom, #ff6f00, #b71c1c); border-radius: 50% 50% 0 0; opacity: .7; }
.b-dragon-v2 .sc1 { top: -2px; left: 25%; animation: dr2Scale 2s ease-in-out infinite; }
.b-dragon-v2 .sc2 { top: -2px; left: 65%; animation: dr2Scale 2s ease-in-out infinite .5s; }
@keyframes dr2Breath {
  0%, 100% { box-shadow: 0 0 24px rgba(244,67,54,.6), inset 0 0 12px rgba(255,193,7,.3); transform: scale(1); }
  50% { box-shadow: 0 0 36px rgba(255,87,34,1), inset 0 0 20px rgba(255,193,7,.5); transform: scale(1.02); }
}
@keyframes dr2Aura {
  0%, 100% { opacity: .6; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.15); }
}
@keyframes dr2Ring {
  0% { transform: scale(.95); opacity: .8; }
  100% { transform: scale(1.3); opacity: 0; }
}
@keyframes dr2Ember {
  0% { transform: translate(0,0) scale(1); opacity: 1; }
  100% { transform: translate(18px, -32px) scale(.2); opacity: 0; }
}
@keyframes dr2EmberL {
  0% { transform: translate(0,0) scale(1); opacity: 1; }
  100% { transform: translate(-18px, -32px) scale(.2); opacity: 0; }
}
@keyframes dr2Scale {
  0%, 100% { opacity: .5; transform: scaleY(1); }
  50% { opacity: 1; transform: scaleY(1.3); }
}',
   'mythic', 800000, 1, 1, 40);
--> statement-breakpoint

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('celestial-v2',
   'Seraph',
   'Winged radiant halo.',
   NULL,
   '<div class="av b-celestial-v2"><div class="wing wL"></div><div class="wing wR"></div><div class="ray ry1"></div><div class="ray ry2"></div><div class="ray ry3"></div><div class="ray ry4"></div><div class="ray ry5"></div><div class="ray ry6"></div><div class="pic">{avatar}</div></div>',
   '.b-celestial-v2 { padding: 4px; background: radial-gradient(circle, #fffde7 0%, #fff59d 40%, #ffd54f 70%, #ffa726); box-shadow: 0 0 24px rgba(255,213,79,.8), inset 0 0 10px rgba(255,255,255,.6); }
.b-celestial-v2::before { content: ""; position: absolute; inset: -14px; border-radius: 50%; background: conic-gradient(from 0deg, transparent, rgba(255,235,59,.7), transparent, rgba(255,193,7,.5), transparent, rgba(255,235,59,.7), transparent); animation: cl2Rotate 5s linear infinite; }
.b-celestial-v2::after { content: ""; position: absolute; inset: -2px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px #ffd54f, 0 0 12px rgba(255,255,255,.9); animation: cl2Pulse 2s ease-in-out infinite; }
.b-celestial-v2 .ray { position: absolute; width: 3px; background: linear-gradient(to top, rgba(255,213,79,1), transparent); top: -20px; left: 50%; margin-left: -1.5px; height: 22px; transform-origin: 50% 70px; border-radius: 2px; }
.b-celestial-v2 .ry1 { animation: cl2Ray 4s linear infinite; }
.b-celestial-v2 .ry2 { animation: cl2Ray 4s linear infinite -.66s; }
.b-celestial-v2 .ry3 { animation: cl2Ray 4s linear infinite -1.33s; }
.b-celestial-v2 .ry4 { animation: cl2Ray 4s linear infinite -2s; }
.b-celestial-v2 .ry5 { animation: cl2Ray 4s linear infinite -2.66s; }
.b-celestial-v2 .ry6 { animation: cl2Ray 4s linear infinite -3.33s; }
.b-celestial-v2 .wing { position: absolute; width: 24px; height: 32px; background: radial-gradient(ellipse, rgba(255,255,255,.9), rgba(255,235,59,.4) 70%, transparent); border-radius: 50% 10% 50% 50%; filter: blur(.5px); }
.b-celestial-v2 .wL { left: -16px; top: 30%; transform: rotate(-30deg) scaleX(-1); animation: cl2Wing 2s ease-in-out infinite; }
.b-celestial-v2 .wR { right: -16px; top: 30%; transform: rotate(30deg); animation: cl2Wing 2s ease-in-out infinite; }
@keyframes cl2Rotate { to { transform: rotate(360deg); } }
@keyframes cl2Pulse {
  0%, 100% { box-shadow: 0 0 0 1px #ffd54f, 0 0 12px rgba(255,255,255,.9); }
  50% { box-shadow: 0 0 0 2px #fff8e1, 0 0 24px rgba(255,255,255,1), 0 0 36px rgba(255,213,79,.8); }
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
   'mythic', 800000, 1, 1, 41);
--> statement-breakpoint

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('void-v2',
   'Event horizon',
   'Accretion disk pulls matter in.',
   NULL,
   '<div class="av b-void-v2"><div class="ring2"></div><div class="particle pt1"></div><div class="particle pt2"></div><div class="particle pt3"></div><div class="particle pt4"></div><div class="particle pt5"></div><div class="pic">{avatar}</div></div>',
   '.b-void-v2 { padding: 4px; background: radial-gradient(circle, #000 25%, #1a0033 50%, #4a148c 75%, #6a1b9a); box-shadow: 0 0 28px rgba(123,31,162,.9), inset 0 0 16px #000; animation: vd2Pulse 3s ease-in-out infinite; }
.b-void-v2::before { content: ""; position: absolute; inset: -8px; border-radius: 50%; background: conic-gradient(from 0deg, transparent, rgba(186,104,200,.8), rgba(225,190,231,.6), transparent, transparent, rgba(186,104,200,.8), transparent); animation: vd2Disk 4s linear infinite; filter: blur(1px); }
.b-void-v2::after { content: ""; position: absolute; inset: -2px; border-radius: 50%; border: 1px solid #ce93d8; box-shadow: 0 0 8px #ba68c8, inset 0 0 8px rgba(186,104,200,.4); animation: vd2Ring 6s linear infinite reverse; }
.b-void-v2 .ring2 { position: absolute; inset: -14px; border-radius: 50%; border: 1px dashed rgba(206,147,216,.5); animation: vd2Ring 9s linear infinite; }
.b-void-v2 .particle { position: absolute; width: 3px; height: 3px; background: #e1bee7; border-radius: 50%; box-shadow: 0 0 4px #ba68c8, 0 0 8px #7b1fa2; }
.b-void-v2 .pt1 { top: 10%; left: 90%; animation: vd2Pull 2.4s ease-in infinite; }
.b-void-v2 .pt2 { top: 80%; left: 10%; animation: vd2Pull 2.4s ease-in infinite .6s; }
.b-void-v2 .pt3 { top: 50%; left: 100%; animation: vd2Pull 2.4s ease-in infinite 1.2s; }
.b-void-v2 .pt4 { top: 5%; left: 40%; animation: vd2Pull 2.4s ease-in infinite 1.8s; }
.b-void-v2 .pt5 { top: 95%; left: 60%; animation: vd2Pull 2.4s ease-in infinite .3s; }
.b-void-v2 .pic { box-shadow: 0 0 0 2px #1a0033, inset 0 0 12px rgba(123,31,162,.4); }
@keyframes vd2Pulse {
  0%, 100% { box-shadow: 0 0 28px rgba(123,31,162,.9), inset 0 0 16px #000; }
  50% { box-shadow: 0 0 44px rgba(186,104,200,1), inset 0 0 22px #2a0050; }
}
@keyframes vd2Disk { to { transform: rotate(360deg); } }
@keyframes vd2Ring { to { transform: rotate(360deg); } }
@keyframes vd2Pull {
  0% { transform: scale(1) translate(0,0); opacity: 1; }
  100% { transform: scale(.1) translate(-30px, -15px) rotate(180deg); opacity: 0; }
}',
   'mythic', 800000, 1, 1, 42);
--> statement-breakpoint

-- =========================================================
-- EXOTIC, beyond rarity
-- =========================================================

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('runic',
   'Runebound',
   'Orbiting glyphs glow in turn.',
   NULL,
   '<div class="av b-runic"><div class="glyph-ring"><span class="glyph g1">ᚱ</span><span class="glyph g2">ᚦ</span><span class="glyph g3">ᛟ</span><span class="glyph g4">ᛞ</span><span class="glyph g5">ᚨ</span><span class="glyph g6">ᛉ</span></div><div class="pic">{avatar}</div></div>',
   '.b-runic { padding: 4px; background: conic-gradient(from 0deg, #1a237e, #0d47a1, #1565c0, #0d47a1, #1a237e); box-shadow: 0 0 18px rgba(13,71,161,.6); }
.b-runic::before { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 2px solid #4fc3f7; box-shadow: inset 0 0 10px rgba(79,195,247,.4); }
.b-runic .glyph-ring { position: absolute; inset: -16px; animation: runeOrbit 12s linear infinite; }
.b-runic .glyph { position: absolute; font-size: 14px; font-weight: 700; color: #4fc3f7; text-shadow: 0 0 6px #29b6f6, 0 0 12px #0288d1; font-family: ''Times New Roman'', serif; }
.b-runic .g1 { top: 0; left: 50%; margin-left: -7px; animation: runeFlicker 1.5s ease-in-out infinite; }
.b-runic .g2 { right: 0; top: 50%; margin-top: -7px; animation: runeFlicker 1.5s ease-in-out infinite .3s; }
.b-runic .g3 { bottom: 0; left: 50%; margin-left: -7px; animation: runeFlicker 1.5s ease-in-out infinite .6s; }
.b-runic .g4 { left: 0; top: 50%; margin-top: -7px; animation: runeFlicker 1.5s ease-in-out infinite .9s; }
.b-runic .g5 { top: 14%; right: 14%; animation: runeFlicker 1.5s ease-in-out infinite 1.2s; }
.b-runic .g6 { bottom: 14%; left: 14%; animation: runeFlicker 1.5s ease-in-out infinite .45s; }
.b-runic::after { content: ""; position: absolute; inset: -8px; border-radius: 50%; border: 1px solid rgba(79,195,247,.4); animation: runeRing 8s linear infinite reverse; }
@keyframes runeOrbit { to { transform: rotate(360deg); } }
@keyframes runeRing { to { transform: rotate(360deg); } }
@keyframes runeFlicker {
  0%, 100% { opacity: .5; }
  50% { opacity: 1; text-shadow: 0 0 8px #29b6f6, 0 0 16px #03a9f4, 0 0 24px #01579b; }
}',
   'exotic', 1500000, 1, 1, 50);
--> statement-breakpoint

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('quantum',
   'Quantum drift',
   'Phasing rings and orbital dots.',
   NULL,
   '<div class="av b-quantum"><div class="qdot qd1"></div><div class="qdot qd2"></div><div class="qdot qd3"></div><div class="pic">{avatar}</div></div>',
   '.b-quantum { padding: 4px; background: conic-gradient(from 0deg, #00bcd4, #00897b, #00bcd4); box-shadow: 0 0 14px rgba(0,188,212,.5); }
.b-quantum::before { content: ""; position: absolute; inset: -2px; border-radius: 50%; border: 2px solid #ff4081; mix-blend-mode: screen; animation: qPhaseA 1.4s ease-in-out infinite; }
.b-quantum::after { content: ""; position: absolute; inset: -2px; border-radius: 50%; border: 2px solid #00e5ff; mix-blend-mode: screen; animation: qPhaseB 1.4s ease-in-out infinite; }
.b-quantum .qdot { position: absolute; width: 4px; height: 4px; border-radius: 50%; }
.b-quantum .qd1 { background: #ff4081; box-shadow: 0 0 6px #ff4081; top: 50%; left: -2px; margin-top: -2px; animation: qOrbit 2s linear infinite; }
.b-quantum .qd2 { background: #00e5ff; box-shadow: 0 0 6px #00e5ff; top: 50%; right: -2px; margin-top: -2px; animation: qOrbit 2s linear infinite reverse; }
.b-quantum .qd3 { background: #ffeb3b; box-shadow: 0 0 6px #ffeb3b; top: -2px; left: 50%; margin-left: -2px; animation: qOrbit 2.6s linear infinite; }
@keyframes qPhaseA {
  0%, 100% { transform: translate(0,0); opacity: .9; }
  50% { transform: translate(-2px, 1px); opacity: .4; }
}
@keyframes qPhaseB {
  0%, 100% { transform: translate(0,0); opacity: .9; }
  50% { transform: translate(2px, -1px); opacity: .4; }
}
@keyframes qOrbit {
  from { transform: rotate(0deg) translateX(48px) rotate(0deg); }
  to { transform: rotate(360deg) translateX(48px) rotate(-360deg); }
}',
   'exotic', 1500000, 1, 1, 51);
--> statement-breakpoint

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('prism',
   'Prismatic',
   'Full spectrum with refraction.',
   NULL,
   '<div class="av b-prism"><div class="ref rf1"></div><div class="ref rf2"></div><div class="ref rf3"></div><div class="pic">{avatar}</div></div>',
   '.b-prism { padding: 4px; background: conic-gradient(from 0deg, #f44336, #ff9800, #ffeb3b, #4caf50, #00bcd4, #3f51b5, #9c27b0, #f44336); animation: prSpin 4s linear infinite; box-shadow: 0 0 18px rgba(156,39,176,.5); }
.b-prism::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from 90deg, transparent, rgba(255,255,255,.7), transparent, transparent); animation: prShine 2s linear infinite; mix-blend-mode: overlay; }
.b-prism::after { content: ""; position: absolute; inset: -8px; border-radius: 50%; background: conic-gradient(from 0deg, transparent, rgba(255,255,255,.3), transparent); animation: prHalo 3s linear infinite reverse; filter: blur(2px); }
.b-prism .ref { position: absolute; width: 2px; height: 12px; background: linear-gradient(to top, transparent, currentColor, transparent); border-radius: 2px; }
.b-prism .rf1 { color: #f44336; top: -8px; left: 30%; animation: prRefract 2s ease-in-out infinite; }
.b-prism .rf2 { color: #00bcd4; top: -8px; left: 70%; animation: prRefract 2s ease-in-out infinite .4s; }
.b-prism .rf3 { color: #ffeb3b; bottom: -8px; left: 50%; animation: prRefract 2s ease-in-out infinite .8s; }
.b-prism .pic { animation: prCounter 4s linear infinite; }
@keyframes prSpin { to { transform: rotate(360deg); } }
@keyframes prCounter { to { transform: rotate(-360deg); } }
@keyframes prShine { to { transform: rotate(360deg); } }
@keyframes prHalo { to { transform: rotate(360deg); } }
@keyframes prRefract {
  0%, 100% { opacity: .4; transform: scaleY(1); }
  50% { opacity: 1; transform: scaleY(1.4); }
}',
   'exotic', 1500000, 1, 1, 52);
--> statement-breakpoint

-- =========================================================
-- ATMOSPHERIC, ambient
-- =========================================================

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('fog-v2',
   'The fog',
   'Moonlit ring through drifting mist.',
   NULL,
   '<div class="av b-fog-v2"><div class="fog-halo"></div><div class="moon-ring"></div><div class="pic">{avatar}</div><div class="fog-band fb1"></div><div class="fog-band fb2"></div><div class="fog-band fb3"></div></div>',
   '.b-fog-v2 { position: relative; }
.b-fog-v2 .moon-ring {
  position: absolute; inset: 0; border-radius: 50%;
  border: 3px solid rgba(220,230,255,.85);
  box-shadow: 0 0 14px rgba(200,220,255,.7), 0 0 28px rgba(180,200,240,.45), 0 0 48px rgba(150,170,220,.3), inset 0 0 12px rgba(220,230,255,.4);
  animation: fog2MoonGlow 4.5s ease-in-out infinite;
  z-index: 5;
}
.b-fog-v2 .pic { box-shadow: 0 0 0 3px rgba(220,230,255,.4), 0 0 16px rgba(200,215,240,.4), inset 0 -8px 16px rgba(0,0,0,.15); filter: blur(.5px); }
.b-fog-v2 .fog-band {
  position: absolute; left: -30%; right: -30%;
  border-radius: 50%; pointer-events: none; filter: blur(6px); z-index: 15;
}
.b-fog-v2 .fb1 { top: 22%; height: 16px; background: linear-gradient(90deg, transparent 0%, rgba(230,238,252,.85) 25%, rgba(245,248,255,.95) 50%, rgba(230,238,252,.85) 75%, transparent 100%); animation: fog2BandA 11s ease-in-out infinite; }
.b-fog-v2 .fb2 { top: 48%; height: 22px; background: linear-gradient(90deg, transparent 0%, rgba(220,230,250,.7) 20%, rgba(240,245,255,.88) 50%, rgba(220,230,250,.7) 80%, transparent 100%); animation: fog2BandB 14s ease-in-out infinite; filter: blur(8px); }
.b-fog-v2 .fb3 { top: 68%; height: 14px; background: linear-gradient(90deg, transparent 0%, rgba(225,235,252,.75) 30%, rgba(245,250,255,.92) 50%, rgba(225,235,252,.75) 70%, transparent 100%); animation: fog2BandC 9s ease-in-out infinite; filter: blur(5px); }
.b-fog-v2 .fog-halo { position: absolute; inset: -20px; border-radius: 50%; background: radial-gradient(circle, rgba(220,230,255,.35) 30%, rgba(200,215,245,.18) 55%, transparent 75%); filter: blur(10px); z-index: 1; animation: fog2Halo 6s ease-in-out infinite; pointer-events: none; }
@keyframes fog2MoonGlow {
  0%, 100% { box-shadow: 0 0 14px rgba(200,220,255,.7), 0 0 28px rgba(180,200,240,.45), 0 0 48px rgba(150,170,220,.3), inset 0 0 12px rgba(220,230,255,.4); border-color: rgba(220,230,255,.85); }
  50% { box-shadow: 0 0 22px rgba(220,235,255,1), 0 0 44px rgba(200,220,250,.7), 0 0 70px rgba(170,190,230,.5), inset 0 0 18px rgba(230,240,255,.6); border-color: rgba(245,248,255,1); }
}
@keyframes fog2BandA {
  0%, 100% { transform: translateX(-8%) scaleX(1); opacity: .85; }
  50% { transform: translateX(8%) scaleX(1.1); opacity: 1; }
}
@keyframes fog2BandB {
  0%, 100% { transform: translateX(10%) scaleX(1); opacity: .75; }
  50% { transform: translateX(-10%) scaleX(1.15); opacity: .95; }
}
@keyframes fog2BandC {
  0%, 100% { transform: translateX(-6%) scaleX(1.05); opacity: .8; }
  50% { transform: translateX(10%) scaleX(.95); opacity: 1; }
}
@keyframes fog2Halo {
  0%, 100% { opacity: .7; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.08); }
}',
   'atmospheric', 100000, 1, 1, 60);
--> statement-breakpoint

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('neon-v2',
   'Neon sign',
   'Flickering tube light.',
   NULL,
   '<div class="av b-neon-v2"><div class="neon-dim"></div><div class="pic">{avatar}</div></div>',
   '.b-neon-v2 {
  padding: 0;
  border: 4px solid #ff10f0;
  background: transparent;
  box-shadow:
    0 0 4px #ff66ff, 0 0 10px #ff10f0, 0 0 22px rgba(255,16,240,.7), 0 0 40px rgba(255,16,240,.4),
    inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 6px rgba(255,16,240,.8), inset 0 0 12px rgba(255,16,240,.5);
  animation: neon2Flicker 5s steps(1, end) infinite;
}
.b-neon-v2::after {
  content: ""; position: absolute; inset: 1px;
  border-radius: 50%;
  border: 2px solid transparent;
  pointer-events: none; z-index: 7;
  animation: neon2Tube 5s steps(1, end) infinite;
}
.b-neon-v2::before {
  content: ""; position: absolute; inset: -8px; border-radius: 50%;
  border: 1px solid rgba(255,16,240,.25);
  box-shadow: 0 0 24px rgba(255,16,240,.45);
  animation: neon2Halo 5s steps(1, end) infinite; pointer-events: none;
}
.b-neon-v2 .neon-dim {
  position: absolute; inset: 0; border-radius: 50%;
  background: radial-gradient(circle, transparent 55%, rgba(0,0,0,.4) 85%);
  animation: neon2Dim 5s steps(1, end) infinite;
  pointer-events: none; z-index: 6;
}
.b-neon-v2 .pic { box-shadow: 0 0 0 3px #1a0014, inset 0 -8px 16px rgba(0,0,0,.15); filter: saturate(.9); }
@keyframes neon2Flicker {
  0%, 100% { border-color: #ff10f0; box-shadow: 0 0 4px #ff66ff, 0 0 10px #ff10f0, 0 0 22px rgba(255,16,240,.7), 0 0 40px rgba(255,16,240,.4), inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 6px rgba(255,16,240,.8), inset 0 0 12px rgba(255,16,240,.5); }
  8% { border-color: #b30087; box-shadow: 0 0 2px #b30087, 0 0 4px rgba(179,0,135,.4), inset 0 0 0 1px rgba(255,200,255,.4), inset 0 0 2px rgba(179,0,135,.4); }
  9% { border-color: #ff10f0; box-shadow: 0 0 4px #ff66ff, 0 0 10px #ff10f0, 0 0 22px rgba(255,16,240,.7), 0 0 40px rgba(255,16,240,.4), inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 6px rgba(255,16,240,.8), inset 0 0 12px rgba(255,16,240,.5); }
  22%, 23% { border-color: rgba(40,0,30,.25); box-shadow: none; }
  24% { border-color: #ff10f0; box-shadow: 0 0 6px #ff66ff, 0 0 14px #ff10f0, 0 0 28px rgba(255,16,240,.8), inset 0 0 0 1px rgba(255,255,255,.95), inset 0 0 4px rgba(255,220,255,1), inset 0 0 8px rgba(255,16,240,.9); }
  35% { border-color: #ff66ff; box-shadow: 0 0 10px #ffaaff, 0 0 24px #ff10f0, 0 0 44px rgba(255,16,240,.9), 0 0 60px rgba(255,16,240,.5), inset 0 0 0 2px rgba(255,255,255,1), inset 0 0 6px rgba(255,230,255,1), inset 0 0 14px rgba(255,16,240,.8); }
  36% { border-color: #ff10f0; box-shadow: 0 0 4px #ff66ff, 0 0 10px #ff10f0, 0 0 22px rgba(255,16,240,.7), 0 0 40px rgba(255,16,240,.4), inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 6px rgba(255,16,240,.8), inset 0 0 12px rgba(255,16,240,.5); }
  48%, 49% { border-color: rgba(40,0,30,.25); box-shadow: none; }
  50% { border-color: #ff10f0; box-shadow: 0 0 4px #ff66ff, 0 0 10px #ff10f0, 0 0 22px rgba(255,16,240,.7), 0 0 40px rgba(255,16,240,.4), inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 6px rgba(255,16,240,.8), inset 0 0 12px rgba(255,16,240,.5); }
  51%, 52% { border-color: rgba(40,0,30,.25); box-shadow: none; }
  53% { border-color: #ff10f0; box-shadow: 0 0 4px #ff66ff, 0 0 10px #ff10f0, 0 0 22px rgba(255,16,240,.7), 0 0 40px rgba(255,16,240,.4), inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 6px rgba(255,16,240,.8), inset 0 0 12px rgba(255,16,240,.5); }
  70% { border-color: #c2009e; box-shadow: 0 0 3px #c2009e, 0 0 6px rgba(194,0,158,.5), inset 0 0 0 1px rgba(255,200,255,.6), inset 0 0 3px rgba(194,0,158,.5); }
  78% { border-color: #ff10f0; box-shadow: 0 0 4px #ff66ff, 0 0 10px #ff10f0, 0 0 22px rgba(255,16,240,.7), 0 0 40px rgba(255,16,240,.4), inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 6px rgba(255,16,240,.8), inset 0 0 12px rgba(255,16,240,.5); }
  90%, 91% { border-color: rgba(40,0,30,.25); box-shadow: none; }
  92% { border-color: #ff10f0; box-shadow: 0 0 4px #ff66ff, 0 0 10px #ff10f0, 0 0 22px rgba(255,16,240,.7), 0 0 40px rgba(255,16,240,.4), inset 0 0 0 1px rgba(255,255,255,.9), inset 0 0 3px rgba(255,200,255,.95), inset 0 0 6px rgba(255,16,240,.8), inset 0 0 12px rgba(255,16,240,.5); }
}
@keyframes neon2Tube {
  0%, 100% { border-color: rgba(255,230,255,.95); box-shadow: 0 0 4px rgba(255,150,240,1), inset 0 0 4px rgba(255,200,255,.9); }
  22%, 23% { border-color: transparent; box-shadow: none; }
  24% { border-color: rgba(255,230,255,.95); box-shadow: 0 0 4px rgba(255,150,240,1), inset 0 0 4px rgba(255,200,255,.9); }
  35% { border-color: rgba(255,255,255,1); box-shadow: 0 0 8px rgba(255,200,255,1), inset 0 0 6px rgba(255,230,255,1); }
  36% { border-color: rgba(255,230,255,.95); box-shadow: 0 0 4px rgba(255,150,240,1), inset 0 0 4px rgba(255,200,255,.9); }
  48%, 49% { border-color: transparent; box-shadow: none; }
  50% { border-color: rgba(255,230,255,.95); box-shadow: 0 0 4px rgba(255,150,240,1), inset 0 0 4px rgba(255,200,255,.9); }
  51%, 52% { border-color: transparent; box-shadow: none; }
  53% { border-color: rgba(255,230,255,.95); box-shadow: 0 0 4px rgba(255,150,240,1), inset 0 0 4px rgba(255,200,255,.9); }
  70% { border-color: rgba(255,200,240,.5); box-shadow: 0 0 2px rgba(194,0,158,.6); }
  78% { border-color: rgba(255,230,255,.95); box-shadow: 0 0 4px rgba(255,150,240,1), inset 0 0 4px rgba(255,200,255,.9); }
  90%, 91% { border-color: transparent; box-shadow: none; }
  92% { border-color: rgba(255,230,255,.95); box-shadow: 0 0 4px rgba(255,150,240,1), inset 0 0 4px rgba(255,200,255,.9); }
}
@keyframes neon2Halo {
  0%, 100% { border-color: rgba(255,16,240,.25); box-shadow: 0 0 24px rgba(255,16,240,.45); }
  22%, 23% { border-color: transparent; box-shadow: none; }
  24% { border-color: rgba(255,16,240,.25); box-shadow: 0 0 24px rgba(255,16,240,.45); }
  35% { border-color: rgba(255,16,240,.4); box-shadow: 0 0 40px rgba(255,16,240,.75); }
  36% { border-color: rgba(255,16,240,.25); box-shadow: 0 0 24px rgba(255,16,240,.45); }
  48%, 49% { border-color: transparent; box-shadow: none; }
  50% { border-color: rgba(255,16,240,.25); box-shadow: 0 0 24px rgba(255,16,240,.45); }
  51%, 52% { border-color: transparent; box-shadow: none; }
  53% { border-color: rgba(255,16,240,.25); box-shadow: 0 0 24px rgba(255,16,240,.45); }
  70% { border-color: rgba(194,0,158,.2); box-shadow: 0 0 10px rgba(194,0,158,.3); }
  78% { border-color: rgba(255,16,240,.25); box-shadow: 0 0 24px rgba(255,16,240,.45); }
  90%, 91% { border-color: transparent; box-shadow: none; }
  92% { border-color: rgba(255,16,240,.25); box-shadow: 0 0 24px rgba(255,16,240,.45); }
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
   'atmospheric', 100000, 1, 1, 61);
--> statement-breakpoint

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `image_url`, `template`, `style_css`,
   `rarity`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('sakura-v2',
   'Sakura petals',
   'Varied pinks rain across face.',
   NULL,
   '<div class="av b-sakura-v2"><div class="pic">{avatar}</div><div class="petal-field"><div class="petal p1"></div><div class="petal p2"></div><div class="petal p3"></div><div class="petal p4"></div><div class="petal p5"></div><div class="petal p6"></div><div class="petal p7"></div><div class="petal p8"></div><div class="petal p9"></div><div class="petal p10"></div></div><div class="petal-pile"></div></div>',
   '.b-sakura-v2 {
  padding: 0;
  border: 3px solid #ffe4ef;
  background: transparent;
  box-shadow:
    0 0 0 1px rgba(255,235,245,.9), 0 0 12px rgba(255,224,236,.85), 0 0 24px rgba(255,200,222,.55), 0 0 40px rgba(244,127,170,.3),
    inset 0 0 8px rgba(255,240,247,.7);
  animation: sk2Pulse 3.2s ease-in-out infinite;
}
.b-sakura-v2 .petal-field {
  position: absolute;
  inset: -22px -16px -26px -16px;
  border-radius: 50%;
  pointer-events: none;
  overflow: visible;
  z-index: 20;
}
.b-sakura-v2 .petal {
  position: absolute;
  width: 10px; height: 8px;
  background:
    radial-gradient(circle at 70% 28%, rgba(255,255,255,.7) 0 1.2px, transparent 1.8px),
    radial-gradient(ellipse at 35% 75%, rgba(228,109,155,.35) 0 2.2px, transparent 3.2px),
    linear-gradient(135deg, var(--pc, #ffd8e8) 0%, var(--pc2, #ffabc9) 55%, var(--pc3, #f47faa) 100%);
  border-radius: 78% 22% 74% 26%;
  transform-origin: 55% 70%;
  filter: drop-shadow(0 0 1.5px rgba(255,255,255,.55)) drop-shadow(0 1px 1.5px rgba(160,70,105,.18));
  opacity: 0;
}
.b-sakura-v2 .p1  { --pc: #fffafc; --pc2: #ffe4ef; --pc3: #ffc4d8; left: 4%;  top: -8px; animation: sk2Drop 5.7s ease-in-out -.4s infinite; }
.b-sakura-v2 .p2  { --pc: #ffd8e8; --pc2: #ffabc9; --pc3: #f47faa; left: 16%; top: -8px; animation: sk2Drop 7.1s ease-in-out -2.2s infinite; }
.b-sakura-v2 .p3  { --pc: #ffeaf2; --pc2: #ffcadd; --pc3: #ff9ec0; left: 28%; top: -8px; animation: sk2Drop 6.4s ease-in-out -1.1s infinite; }
.b-sakura-v2 .p4  { --pc: #ffabc9; --pc2: #f47faa; --pc3: #e46d9b; left: 40%; top: -8px; animation: sk2Drop 8.2s ease-in-out -3.6s infinite; }
.b-sakura-v2 .p5  { --pc: #fffafc; --pc2: #ffd8e8; --pc3: #ffabc9; left: 52%; top: -8px; animation: sk2Drop 5.9s ease-in-out -2.9s infinite; }
.b-sakura-v2 .p6  { --pc: #ffd8e8; --pc2: #f47faa; --pc3: #c95480; left: 64%; top: -8px; animation: sk2Drop 7.6s ease-in-out -1.7s infinite; }
.b-sakura-v2 .p7  { --pc: #ffeaf2; --pc2: #ffabc9; --pc3: #f47faa; left: 76%; top: -8px; animation: sk2Drop 6.8s ease-in-out -4.4s infinite; }
.b-sakura-v2 .p8  { --pc: #ffabc9; --pc2: #e46d9b; --pc3: #b04572; left: 86%; top: -8px; animation: sk2Drop 8.8s ease-in-out -5.5s infinite; }
.b-sakura-v2 .p9  { --pc: #fffafc; --pc2: #ffcadd; --pc3: #ffabc9; left: 36%; top: -8px; animation: sk2Drop 9.2s ease-in-out -6.3s infinite; }
.b-sakura-v2 .p10 { --pc: #ffd8e8; --pc2: #ffabc9; --pc3: #e46d9b; left: 58%; top: -8px; animation: sk2Drop 7.9s ease-in-out -5.1s infinite; }
.b-sakura-v2 .petal-pile {
  position: absolute;
  left: 6%; right: 6%; bottom: -5px;
  height: 10px;
  pointer-events: none;
  border-radius: 999em;
  background:
    radial-gradient(ellipse at center, rgba(255,171,201,.45) 0, rgba(244,127,170,.22) 44%, transparent 78%),
    linear-gradient(90deg, transparent 0, rgba(255,213,230,.35) 50%, transparent 100%);
  filter: blur(2px);
  opacity: .4;
  z-index: 21;
  animation: sk2Pile 5.8s ease-in-out infinite;
}
.b-sakura-v2 .pic { box-shadow: 0 0 10px rgba(255,200,222,.5), inset 0 -8px 16px rgba(0,0,0,.15); }
@keyframes sk2Pulse {
  0%, 100% { border-color: #ffe4ef; box-shadow: 0 0 0 1px rgba(255,235,245,.9), 0 0 12px rgba(255,224,236,.85), 0 0 24px rgba(255,200,222,.55), 0 0 40px rgba(244,127,170,.3), inset 0 0 8px rgba(255,240,247,.7); }
  50% { border-color: #fff0f6; box-shadow: 0 0 0 1px rgba(255,245,250,1), 0 0 18px rgba(255,235,245,1), 0 0 36px rgba(255,210,228,.75), 0 0 56px rgba(244,127,170,.45), inset 0 0 12px rgba(255,248,251,.9); }
}
@keyframes sk2Drop {
  0% { transform: translate3d(0, -4px, 0) rotate(-30deg) scale(.78); opacity: 0; }
  8% { opacity: .95; }
  30% { transform: translate3d(-10px, 30px, 0) rotate(60deg) scale(.82); opacity: 1; }
  55% { transform: translate3d(12px, 64px, 0) rotate(180deg) scale(.85); opacity: .95; }
  78% { transform: translate3d(-6px, 96px, 0) rotate(280deg) scale(.8); opacity: .7; }
  100% { transform: translate3d(0, 128px, 0) rotate(360deg) scale(.7); opacity: 0; }
}
@keyframes sk2Pile {
  0%, 12% { opacity: .12; transform: scaleX(.72) scaleY(.65); }
  48% { opacity: .45; transform: scaleX(1) scaleY(.85); }
  82%, 100% { opacity: .1; transform: scaleX(1.08) scaleY(.74); }
}',
   'atmospheric', 100000, 1, 1, 62);
