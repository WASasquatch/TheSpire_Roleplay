-- Re-port all built-in borders to use SEMANTIC `--c-*` slot
-- names derived from the selector + property context that
-- wraps each color, replacing the prior pass's generic
-- `c1..cN` scheme. Format: `<element>-<property>-<N>`,
-- e.g. `feather-bg-1`, `ring-glow-2`, `ember-shadow-3`.
-- Identical colors across the row dedup to one slot.
--
-- Side effect: any existing user config_json that referenced
-- `c1..cN` slot names will no longer apply (those keys
-- are dropped server-side at write time and are now also
-- dropped at render time). Owners can re-pick from the
-- new (more descriptive) slot list.

UPDATE `freeform_borders`
SET `style_css` = '.b-aurora-v2 { padding: 2px; background: conic-gradient(from 0deg, var(--c-ring-bg-1, #00e5ff), var(--c-ring-bg-2, #4dd0e1), var(--c-ring-bg-3, #80deea), var(--c-ring-bg-4, #b39ddb), var(--c-ring-bg-2, #4dd0e1), var(--c-ring-bg-5, #00bcd4), var(--c-ring-bg-1, #00e5ff)); animation: aV2Spin 5s linear infinite; box-shadow: 0 0 8px color-mix(in srgb, var(--c-ring-bg-1, #00e5ff) 50%, transparent); }
.b-aurora-v2::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from 180deg, transparent, color-mix(in srgb, var(--c-aura-bg-1, #ffffff) 60%, transparent), transparent, transparent); animation: aV2Wash 3s linear infinite; mix-blend-mode: overlay; }
.b-aurora-v2 .pic { animation: aV2Counter 5s linear infinite; }
@keyframes aV2Spin { to { transform: rotate(360deg); } }
@keyframes aV2Counter { to { transform: rotate(-360deg); } }
@keyframes aV2Wash { to { transform: rotate(-360deg); } }',
    `updated_at` = unixepoch() * 1000
WHERE `key` = 'aurora-v2' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-tide { padding: 2px; background: conic-gradient(from 90deg, var(--c-ring-bg-1, #006064), var(--c-ring-bg-2, #00838f), var(--c-ring-bg-3, #0097a7), var(--c-ring-bg-4, #4dd0e1), var(--c-ring-bg-1, #006064)); animation: tideRotate 8s linear infinite; box-shadow: 0 0 6px color-mix(in srgb, var(--c-ring-bg-3, #0097a7) 50%, transparent), inset 0 0 4px var(--c-ring-glow-1, rgba(255,255,255,.2)); }
.b-tide::before { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--c-aura-edge-1, #b2ebf2) 70%, transparent); animation: tideRipple 2.5s ease-out infinite; }
.b-tide::after { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--c-aura-edge-1, #b2ebf2) 70%, transparent); animation: tideRipple 2.5s ease-out infinite 1.25s; }
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
SET `style_css` = '.b-forest { padding: 2px; background: conic-gradient(from 45deg, var(--c-ring-bg-1, #2e7d32), var(--c-ring-bg-2, #66bb6a), var(--c-ring-bg-3, #aed581), var(--c-ring-bg-2, #66bb6a), var(--c-ring-bg-4, #1b5e20)); animation: fxSway 6s ease-in-out infinite; box-shadow: 0 0 0 1px var(--c-ring-glow-1, rgba(174,213,129,.6)), 0 0 10px color-mix(in srgb, var(--c-ring-bg-2, #66bb6a) 50%, transparent), inset 0 0 6px var(--c-ring-glow-2, rgba(46,125,50,.3)); }
.b-forest .leaf-field {
  position: absolute;
  inset: -6px -4px -10px -4px;
  border-radius: 50%;
  pointer-events: none;
  overflow: visible;
  z-index: 20;
}
.b-forest .leaf {
  position: absolute;
  width: 6px; height: 9px;
  background:
    radial-gradient(ellipse at 50% 35%, var(--c-leaf-bg-1, rgba(255,255,255,.35)) 0 1px, transparent 1.8px),
    radial-gradient(circle at 50% 65%, var(--c-leaf-bg-2, rgba(27,94,32,.45)) 0 1.5px, transparent 2.2px),
    linear-gradient(160deg, var(--lc, var(--c-ring-bg-3, #aed581)) 0%, var(--lc2, var(--c-ring-bg-2, #66bb6a)) 55%, var(--lc3, var(--c-ring-bg-1, #2e7d32)) 100%);
  border-radius: 0 100% 0 100%;
  transform-origin: 50% 30%;
  filter: drop-shadow(0 0 1px var(--c-leaf-glow-1, rgba(174,213,129,.55))) drop-shadow(0 1px 1px var(--c-leaf-glow-2, rgba(27,94,32,.25)));
  opacity: 0;
}
.b-forest .lf1  { --lc: var(--c-leaf-color-1, #c5e1a5); --lc2: var(--c-leaf-color-2, #9ccc65); --lc3: var(--c-leaf-color-3, #558b2f); left: 5%;  top: -7px; animation: fxLeafDrop 5.8s ease-in-out -.3s infinite; }
.b-forest .lf2  { --lc: var(--c-ring-bg-3, #aed581); --lc2: var(--c-ring-bg-2, #66bb6a); --lc3: var(--c-ring-bg-1, #2e7d32); left: 18%; top: -7px; animation: fxLeafDrop 7.2s ease-in-out -2.1s infinite; }
.b-forest .lf3  { --lc: var(--c-leaf-color-4, #dcedc8); --lc2: var(--c-ring-bg-3, #aed581); --lc3: var(--c-leaf-color-5, #689f38); left: 30%; top: -7px; animation: fxLeafDrop 6.4s ease-in-out -1.0s infinite; }
.b-forest .lf4  { --lc: var(--c-leaf-color-1, #c5e1a5); --lc2: var(--c-leaf-color-3, #558b2f); --lc3: var(--c-leaf-color-6, #33691e);                left: 42%; top: -7px; animation: fxLeafDrop 8.1s ease-in-out -3.4s infinite; }
.b-forest .lf5  { --lc: var(--c-leaf-color-7, #ffe082); --lc2: var(--c-leaf-color-8, #ffb74d);                --lc3: var(--c-leaf-color-9, #ef6c00);                       left: 53%; top: -7px; animation: fxLeafDrop 6.0s ease-in-out -2.7s infinite; }
.b-forest .lf6  { --lc: var(--c-ring-bg-3, #aed581); --lc2: var(--c-ring-bg-2, #66bb6a); --lc3: var(--c-ring-bg-4, #1b5e20); left: 64%; top: -7px; animation: fxLeafDrop 7.5s ease-in-out -1.5s infinite; }
.b-forest .lf7  { --lc: var(--c-leaf-color-4, #dcedc8); --lc2: var(--c-leaf-color-2, #9ccc65); --lc3: var(--c-leaf-color-3, #558b2f); left: 75%; top: -7px; animation: fxLeafDrop 6.9s ease-in-out -4.2s infinite; }
.b-forest .lf8  { --lc: var(--c-leaf-color-10, #ffcc80); --lc2: var(--c-leaf-color-11, #ffa726);                --lc3: var(--c-leaf-color-12, #e65100);                       left: 85%; top: -7px; animation: fxLeafDrop 8.6s ease-in-out -5.3s infinite; }
.b-forest .lf9  { --lc: var(--c-leaf-color-1, #c5e1a5); --lc2: var(--c-ring-bg-2, #66bb6a); --lc3: var(--c-ring-bg-1, #2e7d32); left: 38%; top: -7px; animation: fxLeafDrop 9.0s ease-in-out -6.0s infinite; }
.b-forest .lf10 { --lc: var(--c-ring-bg-3, #aed581); --lc2: var(--c-leaf-color-5, #689f38); --lc3: var(--c-leaf-color-6, #33691e); left: 60%; top: -7px; animation: fxLeafDrop 7.8s ease-in-out -4.9s infinite; }
.b-forest .leaf-pile {
  position: absolute;
  left: 10%; right: 10%; bottom: -3px;
  height: 6px;
  pointer-events: none;
  border-radius: 999em;
  background:
    radial-gradient(ellipse at center, var(--c-leaf-pile-bg-1, rgba(102,187,106,.45)) 0, var(--c-leaf-pile-bg-2, rgba(46,125,50,.22)) 44%, transparent 78%),
    linear-gradient(90deg, transparent 0, var(--c-leaf-pile-bg-3, rgba(174,213,129,.35)) 50%, transparent 100%);
  filter: blur(1.5px);
  opacity: .4;
  z-index: 21;
  animation: fxPile 6.2s ease-in-out infinite;
}
.b-forest .pic { animation: fxSway 6s ease-in-out infinite reverse; box-shadow: 0 0 6px var(--c-pic-glow-1, rgba(102,187,106,.35)), inset 0 -8px 16px var(--c-pic-glow-2, rgba(0,0,0,.12)); }
@keyframes fxSway {
  0%, 100% { transform: rotate(-2.5deg); }
  50% { transform: rotate(2.5deg); }
}
@keyframes fxLeafDrop {
  0% { transform: translate3d(0, -3px, 0) rotate(-25deg) scale(.78); opacity: 0; }
  10% { opacity: .95; }
  35% { transform: translate3d(-4px, 12px, 0) rotate(80deg) scale(.85); opacity: 1; }
  65% { transform: translate3d(5px, 22px, 0) rotate(220deg) scale(.88); opacity: .7; }
  100% { transform: translate3d(-2px, 34px, 0) rotate(420deg) scale(.7); opacity: 0; }
}
@keyframes fxPile {
  0%, 12% { opacity: .15; transform: scaleX(.74) scaleY(.65); }
  48% { opacity: .5; transform: scaleX(1) scaleY(.9); }
  82%, 100% { opacity: .12; transform: scaleX(1.08) scaleY(.74); }
}',
    `updated_at` = unixepoch() * 1000
WHERE `key` = 'forest' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-phoenix-v4 { padding: 2px; background: conic-gradient(from 90deg, var(--c-ring-bg-1, #ff1744), var(--c-ring-bg-2, #ff6f00), var(--c-ring-bg-3, #ffab00), var(--c-ring-bg-4, #ff3d00), var(--c-ring-bg-1, #ff1744)); animation: phx4Spin 6s linear infinite; box-shadow: 0 0 10px var(--c-ring-glow-1, rgba(255,87,34,.55)), inset 0 0 6px var(--c-ring-glow-2, rgba(255,193,7,.35)); }
.b-phoenix-v4::before { content: ""; position: absolute; inset: -2px; border-radius: 50%; background: radial-gradient(circle, var(--c-aura-bg-1, rgba(255,109,0,.35)), transparent 65%); animation: phx4Aura 2.2s ease-in-out infinite; pointer-events: none; }
.b-phoenix-v4 .pic { animation: phx4Counter 6s linear infinite; }
.b-phoenix-v4 .feather-ring { position: absolute; inset: 0; pointer-events: none; }
.b-phoenix-v4 .feather {
  position: absolute;
  top: 50%; left: 50%;
  width: 6px; height: 14px;
  margin: -7px 0 0 -3px;
  background:
    linear-gradient(180deg, var(--c-feather-bg-1, rgba(255,255,255,.7)) 0%, transparent 22%),
    linear-gradient(to top, var(--c-feather-bg-2, #b71c1c) 0%, var(--c-ring-bg-4, #ff3d00) 35%, var(--c-feather-bg-3, #ff9100) 65%, var(--c-feather-bg-4, #ffeb3b) 95%, transparent 100%);
  border-radius: 50% 50% 50% 50% / 70% 70% 30% 30%;
  transform-origin: 50% 50%;
  filter: drop-shadow(0 0 3px var(--c-feather-glow-1, rgba(255,87,34,.85)));
  animation: phx4Feather 1.4s ease-in-out infinite;
}
.b-phoenix-v4 .ft1  { transform: rotate(0deg)   translate(0,-38px); animation-delay: 0s; }
.b-phoenix-v4 .ft2  { transform: rotate(30deg)  translate(0,-38px); animation-delay: .11s; }
.b-phoenix-v4 .ft3  { transform: rotate(60deg)  translate(0,-38px); animation-delay: .22s; }
.b-phoenix-v4 .ft4  { transform: rotate(90deg)  translate(0,-38px); animation-delay: .33s; }
.b-phoenix-v4 .ft5  { transform: rotate(120deg) translate(0,-38px); animation-delay: .44s; }
.b-phoenix-v4 .ft6  { transform: rotate(150deg) translate(0,-38px); animation-delay: .55s; }
.b-phoenix-v4 .ft7  { transform: rotate(180deg) translate(0,-38px); animation-delay: .66s; }
.b-phoenix-v4 .ft8  { transform: rotate(210deg) translate(0,-38px); animation-delay: .77s; }
.b-phoenix-v4 .ft9  { transform: rotate(240deg) translate(0,-38px); animation-delay: .88s; }
.b-phoenix-v4 .ft10 { transform: rotate(270deg) translate(0,-38px); animation-delay: .99s; }
.b-phoenix-v4 .ft11 { transform: rotate(300deg) translate(0,-38px); animation-delay: 1.1s; }
.b-phoenix-v4 .ft12 { transform: rotate(330deg) translate(0,-38px); animation-delay: 1.21s; }
@keyframes phx4Spin { to { transform: rotate(360deg); } }
@keyframes phx4Counter { to { transform: rotate(-360deg); } }
@keyframes phx4Aura {
  0%, 100% { opacity: .55; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.06); }
}
@keyframes phx4Feather {
  0%, 100% { filter: drop-shadow(0 0 3px var(--c-feather-glow-1, rgba(255,87,34,.85))) brightness(1); }
  50% { filter: drop-shadow(0 0 5px var(--c-ring-glow-3, rgba(255,193,7,1))) brightness(1.3); }
}',
    `updated_at` = unixepoch() * 1000
WHERE `key` = 'phoenix-v4' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-storm { padding: 2px; background: conic-gradient(from 0deg, var(--c-ring-bg-1, #263238), var(--c-ring-bg-2, #37474f), var(--c-ring-bg-3, #455a64), var(--c-ring-bg-2, #37474f), var(--c-ring-bg-1, #263238)); box-shadow: 0 0 10px var(--c-ring-glow-1, rgba(255,235,59,.3)); }
.b-storm::before { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 2px solid var(--c-aura-edge-1, #ffd600); box-shadow: inset 0 0 8px var(--c-aura-glow-1, rgba(255,214,0,.4)); animation: stormFlash 3s steps(1) infinite; }
.b-storm .bolt { position: absolute; color: var(--c-bolt-ink-1, #fff59d); font-weight: 800; font-size: 12px; text-shadow: 0 0 6px var(--c-aura-edge-1, #ffd600), 0 0 10px var(--c-bolt-ink-shadow-1, #ff6f00); opacity: 0; }
.b-storm .bz1 { top: -4px; left: 26%; animation: stormBolt 3s ease-out infinite; }
.b-storm .bz2 { bottom: -2px; right: 22%; animation: stormBolt 3s ease-out infinite 1.5s; }
.b-storm .arc { position: absolute; inset: -1px; border-radius: 50%; border: 1px dashed var(--c-arc-edge-1, #ffeb3b); opacity: 0; animation: stormArc 3s linear infinite; }
@keyframes stormFlash {
  0%, 28%, 33%, 48%, 53%, 100% { border-color: var(--c-aura-edge-1, #ffd600); box-shadow: inset 0 0 8px var(--c-aura-glow-1, rgba(255,214,0,.4)); }
  30%, 50% { border-color: var(--c-ring-edge-1, #fff); box-shadow: inset 0 0 16px var(--c-ring-glow-2, rgba(255,255,255,.9)), 0 0 18px var(--c-ring-glow-3, rgba(255,235,59,1)); }
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
SET `style_css` = '.b-magma { padding: 2px; background: conic-gradient(from 0deg, var(--c-ring-bg-1, #3e2723), var(--c-ring-bg-2, #bf360c), var(--c-ring-bg-3, #ff6f00), var(--c-ring-bg-4, #d84315), var(--c-ring-bg-1, #3e2723)); animation: magmaCrust 4s ease-in-out infinite; box-shadow: 0 0 10px var(--c-ring-glow-1, rgba(216,67,21,.6)); }
.b-magma::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from 0deg, transparent 0deg, var(--c-aura-bg-1, rgba(255,193,7,.7)) 20deg, transparent 60deg, transparent 180deg, var(--c-aura-bg-2, rgba(255,87,34,.7)) 220deg, transparent 280deg); animation: magmaCrack 3s linear infinite; mix-blend-mode: screen; }
.b-magma .drip { position: absolute; width: 3px; height: 5px; background: linear-gradient(to bottom, var(--c-ring-bg-3, #ff6f00), var(--c-ring-bg-2, #bf360c)); border-radius: 50% 50% 60% 60%; box-shadow: 0 0 4px var(--c-drip-glow-1, #ff3d00); }
.b-magma .d1 { bottom: -1px; left: 28%; animation: magmaDrip 2.4s ease-in infinite; }
.b-magma .d2 { bottom: -1px; right: 28%; animation: magmaDrip 2.4s ease-in infinite 1.2s; }
@keyframes magmaCrust {
  0%, 100% { box-shadow: 0 0 10px var(--c-ring-glow-1, rgba(216,67,21,.6)); }
  50% { box-shadow: 0 0 16px var(--c-ring-glow-2, rgba(255,111,0,.9)), inset 0 0 6px var(--c-ring-glow-3, rgba(255,193,7,.3)); }
}
@keyframes magmaCrack { to { transform: rotate(360deg); } }
@keyframes magmaDrip {
  0% { transform: translateY(0) scaleY(1); opacity: 1; }
  100% { transform: translateY(10px) scaleY(1.4); opacity: 0; }
}',
    `updated_at` = unixepoch() * 1000
WHERE `key` = 'magma' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-galaxy-v3 { padding: 2px; background: conic-gradient(from 0deg, var(--c-ring-bg-1, #0d0033), var(--c-ring-bg-2, #4a148c), var(--c-ring-bg-3, #1a237e), var(--c-ring-bg-4, #6a1b9a), var(--c-ring-bg-5, #283593), var(--c-ring-bg-6, #c2185b), var(--c-ring-bg-2, #4a148c), var(--c-ring-bg-1, #0d0033)); animation: gx3Spin 7s linear infinite; box-shadow: 0 0 12px var(--c-ring-glow-1, rgba(106,27,154,.6)); }
.b-galaxy-v3::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(ellipse at 70% 30%, var(--c-aura-bg-1, rgba(255,255,255,.4)), transparent 35%), radial-gradient(ellipse at 30% 70%, var(--c-aura-bg-2, rgba(186,104,200,.5)), transparent 40%), radial-gradient(circle at 50% 50%, transparent 40%, var(--c-aura-bg-3, rgba(13,0,51,.3)) 70%); animation: gx3Drift 7s linear infinite reverse; }
.b-galaxy-v3 .star { position: absolute; background: var(--c-star-bg-1, #fff); border-radius: 50%; box-shadow: 0 0 3px var(--c-star-bg-1, #fff); }
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
SET `style_css` = '.b-royal-v2 { padding: 2px; background: conic-gradient(from 45deg, var(--c-ring-bg-1, #ffd700), var(--c-ring-bg-2, #b8860b), var(--c-ring-bg-1, #ffd700), var(--c-ring-bg-3, #fff8dc), var(--c-ring-bg-4, #daa520), var(--c-ring-bg-1, #ffd700), var(--c-ring-bg-2, #b8860b)); animation: ry2Shimmer 3.5s linear infinite; box-shadow: 0 0 12px var(--c-ring-glow-1, rgba(255,215,0,.5)), inset 0 0 5px var(--c-ring-glow-2, rgba(255,248,220,.4)); }
.b-royal-v2::before { content: ""; position: absolute; inset: -2px; border-radius: 50%; background: conic-gradient(from 0deg, transparent, var(--c-aura-bg-1, rgba(255,215,0,.4)), transparent, transparent, transparent); animation: ry2Glow 2s linear infinite; }
.b-royal-v2 .gem { position: absolute; width: 6px; height: 6px; transform: rotate(45deg); border: 1px solid var(--c-ring-bg-1, #ffd700); box-shadow: 0 0 5px currentColor; }
.b-royal-v2 .gm-ruby { background: linear-gradient(135deg, var(--c-gm-ruby-bg-1, #ff5252), var(--c-gm-ruby-bg-2, #b71c1c)); color: var(--c-gm-ruby-bg-1, #ff5252); top: -4px; left: 50%; margin-left: -3px; animation: ry2Gem 2.4s ease-in-out infinite; }
.b-royal-v2 .gm-sapph { background: linear-gradient(135deg, var(--c-gm-sapph-bg-1, #448aff), var(--c-gm-sapph-bg-2, #0d47a1)); color: var(--c-gm-sapph-bg-1, #448aff); right: -3px; top: 50%; margin-top: -3px; animation: ry2Gem 2.4s ease-in-out infinite .6s; }
.b-royal-v2 .gm-emer { background: linear-gradient(135deg, var(--c-gm-emer-bg-1, #00e676), var(--c-gm-emer-bg-2, #1b5e20)); color: var(--c-gm-emer-bg-1, #00e676); bottom: -4px; left: 50%; margin-left: -3px; animation: ry2Gem 2.4s ease-in-out infinite 1.2s; }
.b-royal-v2 .gm-amth { background: linear-gradient(135deg, var(--c-gm-amth-bg-1, #b388ff), var(--c-gm-amth-bg-2, #4527a0)); color: var(--c-gm-amth-bg-1, #b388ff); left: -3px; top: 50%; margin-top: -3px; animation: ry2Gem 2.4s ease-in-out infinite 1.8s; }
.b-royal-v2 .sparkle { position: absolute; width: 3px; height: 3px; background: var(--c-sparkle-bg-1, #fff); border-radius: 50%; box-shadow: 0 0 4px var(--c-ring-bg-3, #fff8dc); opacity: 0; }
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
SET `style_css` = '.b-holo {
  padding: 2px;
  background: conic-gradient(from 0deg, var(--c-ring-bg-1, #00bcd4), var(--c-ring-bg-2, #e040fb), var(--c-ring-bg-3, #00e5ff), var(--c-ring-bg-4, #ff4081), var(--c-ring-bg-1, #00bcd4));
  box-shadow: 0 0 10px var(--c-ring-glow-1, rgba(0,229,255,.5));
}
/* Scanlines OVER the avatar — z-index 11 puts this above .pic
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
    var(--c-aura-bg-1, rgba(170, 240, 255, .28)) 2px,
    var(--c-aura-bg-1, rgba(170, 240, 255, .28)) 3px
  );
  animation: hoScan 2s linear infinite;
  z-index: 11;
  pointer-events: none;
  mix-blend-mode: screen;
}
/* Outer chromatic glitch ring — sits on top of everything. */
.b-holo::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid var(--c-shine-edge-1, rgba(224, 64, 251, .7));
  animation: hoGlitch 3s steps(1) infinite;
  z-index: 12;
  pointer-events: none;
}
/* Avatar stays stable — only a periodic chromatic-aberration
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
  0%, 92%, 100% { transform: translate(0, 0); border-color: var(--c-shine-edge-1, rgba(224, 64, 251, .7)); }
  93% { transform: translate(1px, -1px); border-color: var(--c-ring-bg-4, #ff4081); }
  95% { transform: translate(-1px, 1px); border-color: var(--c-ring-bg-3, #00e5ff); }
  97% { transform: translate(1px, 0); border-color: var(--c-shine-edge-1, rgba(224, 64, 251, .7)); }
}
@keyframes hoShift {
  0%, 95%, 100% { filter: none; }
  96% { filter: drop-shadow(1px 0 0 var(--c-ring-glow-2, rgba(255, 64, 129, .55))) drop-shadow(-1px 0 0 var(--c-ring-glow-3, rgba(0, 229, 255, .55))) hue-rotate(15deg); }
  98% { filter: drop-shadow(-1px 0 0 var(--c-ring-glow-2, rgba(255, 64, 129, .55))) drop-shadow(1px 0 0 var(--c-ring-glow-3, rgba(0, 229, 255, .55))) hue-rotate(-15deg); }
}',
    `updated_at` = unixepoch() * 1000
WHERE `key` = 'holo' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-dragon-v2 { padding: 3px; background: conic-gradient(from 0deg, var(--c-ring-bg-1, #4a0e0e), var(--c-ring-bg-2, #b71c1c), var(--c-ring-bg-3, #ff6f00), var(--c-ring-bg-4, #ffab00), var(--c-ring-bg-3, #ff6f00), var(--c-ring-bg-2, #b71c1c), var(--c-ring-bg-1, #4a0e0e)); animation: dr2Breath 1.8s ease-in-out infinite; box-shadow: 0 0 14px var(--c-ring-glow-1, rgba(244,67,54,.6)), inset 0 0 8px var(--c-ring-glow-2, rgba(255,193,7,.3)); }
.b-dragon-v2::before { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: radial-gradient(circle, var(--c-aura-bg-1, rgba(255,87,34,.35)) 30%, var(--c-aura-bg-2, rgba(255,193,7,.2)) 50%, transparent 70%); animation: dr2Aura 1.8s ease-in-out infinite; pointer-events: none; }
.b-dragon-v2::after { content: ""; position: absolute; inset: -1px; border-radius: 50%; border: 1px solid var(--c-shine-edge-1, rgba(255,193,7,.7)); animation: dr2Ring 2.5s ease-out infinite; }
.b-dragon-v2 .ember { position: absolute; width: 3px; height: 3px; background: var(--c-ember-bg-1, #ffeb3b); border-radius: 50%; box-shadow: 0 0 4px var(--c-ring-bg-3, #ff6f00), 0 0 6px var(--c-ember-glow-1, #ff3d00); }
.b-dragon-v2 .em1 { top: 10%; right: 0; animation: dr2Ember 2.2s ease-out infinite; }
.b-dragon-v2 .em2 { top: 35%; right: 0; animation: dr2Ember 2.2s ease-out infinite .55s; }
.b-dragon-v2 .em3 { top: 62%; right: 0; animation: dr2Ember 2.2s ease-out infinite 1.1s; }
.b-dragon-v2 .em4 { top: 25%; left: 0; animation: dr2EmberL 2.2s ease-out infinite .3s; }
.b-dragon-v2 .em5 { top: 70%; left: 0; animation: dr2EmberL 2.2s ease-out infinite 1.5s; }
.b-dragon-v2 .scale { position: absolute; width: 4px; height: 6px; background: linear-gradient(to bottom, var(--c-ring-bg-3, #ff6f00), var(--c-ring-bg-2, #b71c1c)); border-radius: 50% 50% 0 0; opacity: .7; }
.b-dragon-v2 .sc1 { top: -1px; left: 28%; animation: dr2Scale 2s ease-in-out infinite; }
.b-dragon-v2 .sc2 { top: -1px; left: 62%; animation: dr2Scale 2s ease-in-out infinite .5s; }
@keyframes dr2Breath {
  0%, 100% { box-shadow: 0 0 14px var(--c-ring-glow-1, rgba(244,67,54,.6)), inset 0 0 8px var(--c-ring-glow-2, rgba(255,193,7,.3)); transform: scale(1); }
  50% { box-shadow: 0 0 20px var(--c-ring-glow-3, rgba(255,87,34,1)), inset 0 0 14px var(--c-ring-glow-4, rgba(255,193,7,.5)); transform: scale(1.02); }
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
SET `style_css` = '.b-celestial-v2 { padding: 2px; background: radial-gradient(circle, var(--c-ring-bg-1, #fffde7) 0%, var(--c-ring-bg-2, #fff59d) 40%, var(--c-ring-bg-3, #ffd54f) 70%, var(--c-ring-bg-4, #ffa726)); box-shadow: 0 0 14px var(--c-ring-glow-1, rgba(255,213,79,.8)), inset 0 0 6px var(--c-ring-glow-2, rgba(255,255,255,.6)); }
.b-celestial-v2::before { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: conic-gradient(from 0deg, transparent, var(--c-aura-bg-1, rgba(255,235,59,.7)), transparent, var(--c-aura-bg-2, rgba(255,193,7,.5)), transparent, var(--c-aura-bg-1, rgba(255,235,59,.7)), transparent); animation: cl2Rotate 5s linear infinite; }
.b-celestial-v2::after { content: ""; position: absolute; inset: -1px; border-radius: 50%; border: 1px solid var(--c-shine-edge-1, #fff); box-shadow: 0 0 0 1px var(--c-ring-bg-3, #ffd54f), 0 0 8px var(--c-shine-glow-1, rgba(255,255,255,.9)); animation: cl2Pulse 2s ease-in-out infinite; }
.b-celestial-v2 .ray { position: absolute; width: 2px; background: linear-gradient(to top, var(--c-ray-bg-1, rgba(255,213,79,1)), transparent); top: -3px; left: 50%; margin-left: -1px; height: 7px; transform-origin: 50% 44px; border-radius: 2px; }
.b-celestial-v2 .ry1 { animation: cl2Ray 4s linear infinite; }
.b-celestial-v2 .ry2 { animation: cl2Ray 4s linear infinite -.66s; }
.b-celestial-v2 .ry3 { animation: cl2Ray 4s linear infinite -1.33s; }
.b-celestial-v2 .ry4 { animation: cl2Ray 4s linear infinite -2s; }
.b-celestial-v2 .ry5 { animation: cl2Ray 4s linear infinite -2.66s; }
.b-celestial-v2 .ry6 { animation: cl2Ray 4s linear infinite -3.33s; }
.b-celestial-v2 .wing { position: absolute; width: 10px; height: 16px; background: radial-gradient(ellipse, var(--c-shine-glow-1, rgba(255,255,255,.9)), var(--c-wing-bg-1, rgba(255,235,59,.4)) 70%, transparent); border-radius: 50% 10% 50% 50%; filter: blur(.5px); }
.b-celestial-v2 .wL { left: -4px; top: 34%; transform: rotate(-30deg) scaleX(-1); animation: cl2Wing 2s ease-in-out infinite; }
.b-celestial-v2 .wR { right: -4px; top: 34%; transform: rotate(30deg); animation: cl2Wing 2s ease-in-out infinite; }
@keyframes cl2Rotate { to { transform: rotate(360deg); } }
@keyframes cl2Pulse {
  0%, 100% { box-shadow: 0 0 0 1px var(--c-ring-bg-3, #ffd54f), 0 0 8px var(--c-shine-glow-1, rgba(255,255,255,.9)); }
  50% { box-shadow: 0 0 0 1px var(--c-ring-glow-3, #fff8e1), 0 0 14px var(--c-ring-glow-4, rgba(255,255,255,1)), 0 0 20px var(--c-ring-glow-1, rgba(255,213,79,.8)); }
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
SET `style_css` = '.b-void-v2 { padding: 2px; background: radial-gradient(circle, var(--c-ring-bg-1, #000) 25%, var(--c-ring-bg-2, #1a0033) 50%, var(--c-ring-bg-3, #4a148c) 75%, var(--c-ring-bg-4, #6a1b9a)); box-shadow: 0 0 16px var(--c-ring-glow-1, rgba(123,31,162,.9)), inset 0 0 10px var(--c-ring-bg-1, #000); animation: vd2Pulse 3s ease-in-out infinite; }
.b-void-v2::before { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: conic-gradient(from 0deg, transparent, var(--c-aura-bg-1, rgba(186,104,200,.8)), var(--c-aura-bg-2, rgba(225,190,231,.6)), transparent, transparent, var(--c-aura-bg-1, rgba(186,104,200,.8)), transparent); animation: vd2Disk 4s linear infinite; filter: blur(1px); }
.b-void-v2::after { content: ""; position: absolute; inset: -1px; border-radius: 50%; border: 1px solid var(--c-shine-edge-1, #ce93d8); box-shadow: 0 0 6px var(--c-shine-glow-1, #ba68c8), inset 0 0 6px var(--c-shine-glow-2, rgba(186,104,200,.4)); animation: vd2Ring 6s linear infinite reverse; }
.b-void-v2 .ring2 { position: absolute; inset: -5px; border-radius: 50%; border: 1px dashed var(--c-ring-edge-1, rgba(206,147,216,.5)); animation: vd2Ring 9s linear infinite; }
.b-void-v2 .particle { position: absolute; width: 2px; height: 2px; background: var(--c-particle-bg-1, #e1bee7); border-radius: 50%; box-shadow: 0 0 3px var(--c-shine-glow-1, #ba68c8), 0 0 6px var(--c-particle-glow-1, #7b1fa2); }
.b-void-v2 .pt1 { top: 12%; left: 88%; animation: vd2Pull 2.4s ease-in infinite; }
.b-void-v2 .pt2 { top: 78%; left: 12%; animation: vd2Pull 2.4s ease-in infinite .6s; }
.b-void-v2 .pt3 { top: 50%; left: 95%; animation: vd2Pull 2.4s ease-in infinite 1.2s; }
.b-void-v2 .pt4 { top: 8%; left: 42%; animation: vd2Pull 2.4s ease-in infinite 1.8s; }
.b-void-v2 .pt5 { top: 90%; left: 58%; animation: vd2Pull 2.4s ease-in infinite .3s; }
.b-void-v2 .pic { box-shadow: 0 0 0 2px var(--c-ring-bg-2, #1a0033), inset 0 0 10px var(--c-pic-glow-1, rgba(123,31,162,.4)); }
@keyframes vd2Pulse {
  0%, 100% { box-shadow: 0 0 16px var(--c-ring-glow-1, rgba(123,31,162,.9)), inset 0 0 10px var(--c-ring-bg-1, #000); }
  50% { box-shadow: 0 0 24px var(--c-ring-glow-2, rgba(186,104,200,1)), inset 0 0 14px var(--c-ring-glow-3, #2a0050); }
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

UPDATE `freeform_borders`
SET `style_css` = '.b-runic { padding: 2px; background: conic-gradient(from 0deg, var(--c-ring-bg-1, #1a237e), var(--c-ring-bg-2, #0d47a1), var(--c-ring-bg-3, #1565c0), var(--c-ring-bg-2, #0d47a1), var(--c-ring-bg-1, #1a237e)); box-shadow: 0 0 12px var(--c-ring-glow-1, rgba(13,71,161,.6)); }
.b-runic::before { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 1px solid var(--c-aura-edge-1, #4fc3f7); box-shadow: inset 0 0 8px var(--c-aura-glow-1, rgba(79,195,247,.4)); }
.b-runic .glyph-ring { position: absolute; inset: -6px; animation: runeOrbit 12s linear infinite; }
.b-runic .glyph { position: absolute; font-size: 10px; font-weight: 700; color: var(--c-aura-edge-1, #4fc3f7); text-shadow: 0 0 4px var(--c-glyph-ink-shadow-1, #29b6f6), 0 0 8px var(--c-glyph-ink-shadow-2, #0288d1); font-family: ''Times New Roman'', serif; }
.b-runic .g1 { top: 0; left: 50%; margin-left: -5px; animation: runeFlicker 1.5s ease-in-out infinite; }
.b-runic .g2 { right: 0; top: 50%; margin-top: -5px; animation: runeFlicker 1.5s ease-in-out infinite .3s; }
.b-runic .g3 { bottom: 0; left: 50%; margin-left: -5px; animation: runeFlicker 1.5s ease-in-out infinite .6s; }
.b-runic .g4 { left: 0; top: 50%; margin-top: -5px; animation: runeFlicker 1.5s ease-in-out infinite .9s; }
.b-runic .g5 { top: 14%; right: 14%; animation: runeFlicker 1.5s ease-in-out infinite 1.2s; }
.b-runic .g6 { bottom: 14%; left: 14%; animation: runeFlicker 1.5s ease-in-out infinite .45s; }
.b-runic::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; border: 1px solid var(--c-aura-glow-1, rgba(79,195,247,.4)); animation: runeRing 8s linear infinite reverse; }
@keyframes runeOrbit { to { transform: rotate(360deg); } }
@keyframes runeRing { to { transform: rotate(360deg); } }
@keyframes runeFlicker {
  0%, 100% { opacity: .5; }
  50% { opacity: 1; text-shadow: 0 0 6px var(--c-glyph-ink-shadow-1, #29b6f6), 0 0 10px var(--c-ring-ink-shadow-1, #03a9f4), 0 0 16px var(--c-ring-ink-shadow-2, #01579b); }
}',
    `updated_at` = unixepoch() * 1000
WHERE `key` = 'runic' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-quantum { padding: 2px; background: conic-gradient(from 0deg, var(--c-ring-bg-1, #00bcd4), var(--c-ring-bg-2, #00897b), var(--c-ring-bg-1, #00bcd4)); box-shadow: 0 0 10px var(--c-ring-glow-1, rgba(0,188,212,.5)); }
.b-quantum::before { content: ""; position: absolute; inset: -1px; border-radius: 50%; border: 1px solid var(--c-aura-edge-1, #ff4081); mix-blend-mode: screen; animation: qPhaseA 1.4s ease-in-out infinite; }
.b-quantum::after { content: ""; position: absolute; inset: -1px; border-radius: 50%; border: 1px solid var(--c-shine-edge-1, #00e5ff); mix-blend-mode: screen; animation: qPhaseB 1.4s ease-in-out infinite; }
.b-quantum .qdot {
  position: absolute;
  top: 50%; left: 50%;
  width: 3px; height: 3px;
  margin: -1.5px 0 0 -1.5px;
  border-radius: 50%;
  z-index: 11;
}
.b-quantum .qd1 { background: var(--c-aura-edge-1, #ff4081); box-shadow: 0 0 4px var(--c-aura-edge-1, #ff4081); animation: qOrbit 2s linear infinite; }
.b-quantum .qd2 { background: var(--c-shine-edge-1, #00e5ff); box-shadow: 0 0 4px var(--c-shine-edge-1, #00e5ff); animation: qOrbit 2s linear infinite -1s; }
.b-quantum .qd3 { background: var(--c-qd-bg-1, #ffeb3b); box-shadow: 0 0 4px var(--c-qd-bg-1, #ffeb3b); animation: qOrbit 2.6s linear infinite -1.3s; }
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
SET `style_css` = '.b-prism { padding: 2px; background: conic-gradient(from 0deg, var(--c-ring-bg-1, #f44336), var(--c-ring-bg-2, #ff9800), var(--c-ring-bg-3, #ffeb3b), var(--c-ring-bg-4, #4caf50), var(--c-ring-bg-5, #00bcd4), var(--c-ring-bg-6, #3f51b5), var(--c-ring-bg-7, #9c27b0), var(--c-ring-bg-1, #f44336)); animation: prSpin 4s linear infinite; box-shadow: 0 0 12px var(--c-ring-glow-1, rgba(156,39,176,.5)); }
.b-prism::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from 90deg, transparent, var(--c-aura-bg-1, rgba(255,255,255,.7)), transparent, transparent); animation: prShine 2s linear infinite; mix-blend-mode: overlay; }
.b-prism::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: conic-gradient(from 0deg, transparent, var(--c-shine-bg-1, rgba(255,255,255,.3)), transparent); animation: prHalo 3s linear infinite reverse; filter: blur(2px); }
.b-prism .ref { position: absolute; width: 2px; height: 8px; background: linear-gradient(to top, transparent, currentColor, transparent); border-radius: 2px; }
.b-prism .rf1 { color: var(--c-ring-bg-1, #f44336); top: -4px; left: 32%; animation: prRefract 2s ease-in-out infinite; }
.b-prism .rf2 { color: var(--c-ring-bg-5, #00bcd4); top: -4px; left: 64%; animation: prRefract 2s ease-in-out infinite .4s; }
.b-prism .rf3 { color: var(--c-ring-bg-3, #ffeb3b); bottom: -4px; left: 50%; animation: prRefract 2s ease-in-out infinite .8s; }
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

UPDATE `freeform_borders`
SET `style_css` = '.b-fog-v2 { position: relative; }
.b-fog-v2 .moon-ring {
  position: absolute; inset: 0; border-radius: 50%;
  border: 2px solid var(--c-moon-ring-edge-1, rgba(220,230,255,.85));
  box-shadow: 0 0 8px var(--c-moon-ring-glow-1, rgba(200,220,255,.7)), 0 0 14px var(--c-moon-ring-glow-2, rgba(180,200,240,.45)), 0 0 22px var(--c-moon-ring-glow-3, rgba(150,170,220,.3)), inset 0 0 8px var(--c-moon-ring-glow-4, rgba(220,230,255,.4));
  animation: fog2MoonGlow 4.5s ease-in-out infinite;
  z-index: 5;
}
.b-fog-v2 .pic { box-shadow: 0 0 0 2px var(--c-moon-ring-glow-4, rgba(220,230,255,.4)), 0 0 10px var(--c-pic-glow-1, rgba(200,215,240,.4)), inset 0 -8px 16px var(--c-pic-glow-2, rgba(0,0,0,.15)); filter: blur(.5px); }
.b-fog-v2 .fog-band {
  position: absolute; left: -4%; right: -4%;
  border-radius: 50%; pointer-events: none; filter: blur(4px); z-index: 15;
}
.b-fog-v2 .fb1 { top: 22%; height: 10px; background: linear-gradient(90deg, transparent 0%, var(--c-fb-bg-1, rgba(230,238,252,.85)) 25%, var(--c-fb-bg-2, rgba(245,248,255,.95)) 50%, var(--c-fb-bg-1, rgba(230,238,252,.85)) 75%, transparent 100%); animation: fog2BandA 11s ease-in-out infinite; }
.b-fog-v2 .fb2 { top: 48%; height: 14px; background: linear-gradient(90deg, transparent 0%, var(--c-fb-bg-3, rgba(220,230,250,.7)) 20%, var(--c-fb-bg-4, rgba(240,245,255,.88)) 50%, var(--c-fb-bg-3, rgba(220,230,250,.7)) 80%, transparent 100%); animation: fog2BandB 14s ease-in-out infinite; filter: blur(5px); }
.b-fog-v2 .fb3 { top: 68%; height: 9px; background: linear-gradient(90deg, transparent 0%, var(--c-fb-bg-5, rgba(225,235,252,.75)) 30%, var(--c-fb-bg-6, rgba(245,250,255,.92)) 50%, var(--c-fb-bg-5, rgba(225,235,252,.75)) 70%, transparent 100%); animation: fog2BandC 9s ease-in-out infinite; filter: blur(3px); }
.b-fog-v2 .fog-halo { position: absolute; inset: -4px; border-radius: 50%; background: radial-gradient(circle, var(--c-fog-halo-bg-1, rgba(220,230,255,.35)) 30%, var(--c-fog-halo-bg-2, rgba(200,215,245,.18)) 55%, transparent 75%); filter: blur(6px); z-index: 1; animation: fog2Halo 6s ease-in-out infinite; pointer-events: none; }
@keyframes fog2MoonGlow {
  0%, 100% { box-shadow: 0 0 8px var(--c-moon-ring-glow-1, rgba(200,220,255,.7)), 0 0 14px var(--c-moon-ring-glow-2, rgba(180,200,240,.45)), 0 0 22px var(--c-moon-ring-glow-3, rgba(150,170,220,.3)), inset 0 0 8px var(--c-moon-ring-glow-4, rgba(220,230,255,.4)); border-color: var(--c-moon-ring-edge-1, rgba(220,230,255,.85)); }
  50% { box-shadow: 0 0 12px var(--c-ring-glow-1, rgba(220,235,255,1)), 0 0 20px var(--c-ring-glow-2, rgba(200,220,250,.7)), 0 0 30px var(--c-ring-glow-3, rgba(170,190,230,.5)), inset 0 0 12px var(--c-ring-glow-4, rgba(230,240,255,.6)); border-color: var(--c-ring-edge-1, rgba(245,248,255,1)); }
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
  border: 2px solid var(--c-ring-edge-1, #ff10f0);
  background: transparent;
  box-shadow:
    0 0 4px var(--c-ring-glow-1, #ff66ff), 0 0 8px var(--c-ring-edge-1, #ff10f0), 0 0 14px var(--c-ring-glow-2, rgba(255,16,240,.7)),
    inset 0 0 0 1px var(--c-ring-glow-3, rgba(255,255,255,.9)), inset 0 0 3px var(--c-ring-glow-4, rgba(255,200,255,.95)), inset 0 0 5px var(--c-ring-glow-5, rgba(255,16,240,.8));
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
  border: 1px solid var(--c-aura-edge-1, rgba(255,16,240,.25));
  box-shadow: 0 0 14px var(--c-aura-glow-1, rgba(255,16,240,.45));
  animation: neon2Halo 5s steps(1, end) infinite; pointer-events: none;
}
.b-neon-v2 .neon-dim {
  position: absolute; inset: 0; border-radius: 50%;
  background: radial-gradient(circle, transparent 55%, var(--c-neon-dim-bg-1, rgba(0,0,0,.4)) 85%);
  animation: neon2Dim 5s steps(1, end) infinite;
  pointer-events: none; z-index: 6;
}
.b-neon-v2 .pic { box-shadow: 0 0 0 2px var(--c-pic-glow-1, #1a0014), inset 0 -8px 16px var(--c-pic-glow-2, rgba(0,0,0,.15)); filter: saturate(.9); }
@keyframes neon2Flicker {
  0%, 100% { border-color: var(--c-ring-edge-1, #ff10f0); box-shadow: 0 0 4px var(--c-ring-glow-1, #ff66ff), 0 0 8px var(--c-ring-edge-1, #ff10f0), 0 0 14px var(--c-ring-glow-2, rgba(255,16,240,.7)), inset 0 0 0 1px var(--c-ring-glow-3, rgba(255,255,255,.9)), inset 0 0 3px var(--c-ring-glow-4, rgba(255,200,255,.95)), inset 0 0 5px var(--c-ring-glow-5, rgba(255,16,240,.8)); }
  8% { border-color: var(--c-ring-edge-2, #b30087); box-shadow: 0 0 2px var(--c-ring-edge-2, #b30087), inset 0 0 0 1px var(--c-ring-glow-6, rgba(255,200,255,.4)), inset 0 0 2px var(--c-ring-glow-7, rgba(179,0,135,.4)); }
  9% { border-color: var(--c-ring-edge-1, #ff10f0); box-shadow: 0 0 4px var(--c-ring-glow-1, #ff66ff), 0 0 8px var(--c-ring-edge-1, #ff10f0), 0 0 14px var(--c-ring-glow-2, rgba(255,16,240,.7)), inset 0 0 0 1px var(--c-ring-glow-3, rgba(255,255,255,.9)), inset 0 0 3px var(--c-ring-glow-4, rgba(255,200,255,.95)), inset 0 0 5px var(--c-ring-glow-5, rgba(255,16,240,.8)); }
  22%, 23% { border-color: var(--c-ring-edge-3, rgba(40,0,30,.25)); box-shadow: none; }
  24% { border-color: var(--c-ring-edge-1, #ff10f0); box-shadow: 0 0 5px var(--c-ring-glow-1, #ff66ff), 0 0 10px var(--c-ring-edge-1, #ff10f0), 0 0 18px var(--c-ring-glow-5, rgba(255,16,240,.8)), inset 0 0 0 1px var(--c-ring-glow-8, rgba(255,255,255,.95)), inset 0 0 3px var(--c-ring-glow-9, rgba(255,220,255,1)), inset 0 0 6px var(--c-ring-glow-10, rgba(255,16,240,.9)); }
  35% { border-color: var(--c-ring-glow-1, #ff66ff); box-shadow: 0 0 8px var(--c-ring-glow-11, #ffaaff), 0 0 14px var(--c-ring-edge-1, #ff10f0), 0 0 22px var(--c-ring-glow-10, rgba(255,16,240,.9)), inset 0 0 0 2px var(--c-ring-glow-12, rgba(255,255,255,1)), inset 0 0 5px var(--c-ring-glow-13, rgba(255,230,255,1)), inset 0 0 10px var(--c-ring-glow-5, rgba(255,16,240,.8)); }
  36% { border-color: var(--c-ring-edge-1, #ff10f0); box-shadow: 0 0 4px var(--c-ring-glow-1, #ff66ff), 0 0 8px var(--c-ring-edge-1, #ff10f0), 0 0 14px var(--c-ring-glow-2, rgba(255,16,240,.7)), inset 0 0 0 1px var(--c-ring-glow-3, rgba(255,255,255,.9)), inset 0 0 3px var(--c-ring-glow-4, rgba(255,200,255,.95)), inset 0 0 5px var(--c-ring-glow-5, rgba(255,16,240,.8)); }
  48%, 49% { border-color: var(--c-ring-edge-3, rgba(40,0,30,.25)); box-shadow: none; }
  50% { border-color: var(--c-ring-edge-1, #ff10f0); box-shadow: 0 0 4px var(--c-ring-glow-1, #ff66ff), 0 0 8px var(--c-ring-edge-1, #ff10f0), 0 0 14px var(--c-ring-glow-2, rgba(255,16,240,.7)), inset 0 0 0 1px var(--c-ring-glow-3, rgba(255,255,255,.9)), inset 0 0 3px var(--c-ring-glow-4, rgba(255,200,255,.95)), inset 0 0 5px var(--c-ring-glow-5, rgba(255,16,240,.8)); }
  51%, 52% { border-color: var(--c-ring-edge-3, rgba(40,0,30,.25)); box-shadow: none; }
  53% { border-color: var(--c-ring-edge-1, #ff10f0); box-shadow: 0 0 4px var(--c-ring-glow-1, #ff66ff), 0 0 8px var(--c-ring-edge-1, #ff10f0), 0 0 14px var(--c-ring-glow-2, rgba(255,16,240,.7)), inset 0 0 0 1px var(--c-ring-glow-3, rgba(255,255,255,.9)), inset 0 0 3px var(--c-ring-glow-4, rgba(255,200,255,.95)), inset 0 0 5px var(--c-ring-glow-5, rgba(255,16,240,.8)); }
  70% { border-color: var(--c-ring-edge-4, #c2009e); box-shadow: 0 0 3px var(--c-ring-edge-4, #c2009e), inset 0 0 0 1px var(--c-ring-glow-14, rgba(255,200,255,.6)), inset 0 0 3px var(--c-ring-glow-15, rgba(194,0,158,.5)); }
  78% { border-color: var(--c-ring-edge-1, #ff10f0); box-shadow: 0 0 4px var(--c-ring-glow-1, #ff66ff), 0 0 8px var(--c-ring-edge-1, #ff10f0), 0 0 14px var(--c-ring-glow-2, rgba(255,16,240,.7)), inset 0 0 0 1px var(--c-ring-glow-3, rgba(255,255,255,.9)), inset 0 0 3px var(--c-ring-glow-4, rgba(255,200,255,.95)), inset 0 0 5px var(--c-ring-glow-5, rgba(255,16,240,.8)); }
  90%, 91% { border-color: var(--c-ring-edge-3, rgba(40,0,30,.25)); box-shadow: none; }
  92% { border-color: var(--c-ring-edge-1, #ff10f0); box-shadow: 0 0 4px var(--c-ring-glow-1, #ff66ff), 0 0 8px var(--c-ring-edge-1, #ff10f0), 0 0 14px var(--c-ring-glow-2, rgba(255,16,240,.7)), inset 0 0 0 1px var(--c-ring-glow-3, rgba(255,255,255,.9)), inset 0 0 3px var(--c-ring-glow-4, rgba(255,200,255,.95)), inset 0 0 5px var(--c-ring-glow-5, rgba(255,16,240,.8)); }
}
@keyframes neon2Tube {
  0%, 100% { border-color: var(--c-ring-edge-5, rgba(255,230,255,.95)); box-shadow: 0 0 3px var(--c-ring-glow-16, rgba(255,150,240,1)), inset 0 0 3px var(--c-ring-glow-17, rgba(255,200,255,.9)); }
  22%, 23% { border-color: transparent; box-shadow: none; }
  24% { border-color: var(--c-ring-edge-5, rgba(255,230,255,.95)); box-shadow: 0 0 3px var(--c-ring-glow-16, rgba(255,150,240,1)), inset 0 0 3px var(--c-ring-glow-17, rgba(255,200,255,.9)); }
  35% { border-color: var(--c-ring-glow-12, rgba(255,255,255,1)); box-shadow: 0 0 6px var(--c-ring-glow-18, rgba(255,200,255,1)), inset 0 0 4px var(--c-ring-glow-13, rgba(255,230,255,1)); }
  36% { border-color: var(--c-ring-edge-5, rgba(255,230,255,.95)); box-shadow: 0 0 3px var(--c-ring-glow-16, rgba(255,150,240,1)), inset 0 0 3px var(--c-ring-glow-17, rgba(255,200,255,.9)); }
  48%, 49% { border-color: transparent; box-shadow: none; }
  50% { border-color: var(--c-ring-edge-5, rgba(255,230,255,.95)); box-shadow: 0 0 3px var(--c-ring-glow-16, rgba(255,150,240,1)), inset 0 0 3px var(--c-ring-glow-17, rgba(255,200,255,.9)); }
  51%, 52% { border-color: transparent; box-shadow: none; }
  53% { border-color: var(--c-ring-edge-5, rgba(255,230,255,.95)); box-shadow: 0 0 3px var(--c-ring-glow-16, rgba(255,150,240,1)), inset 0 0 3px var(--c-ring-glow-17, rgba(255,200,255,.9)); }
  70% { border-color: var(--c-ring-edge-6, rgba(255,200,240,.5)); box-shadow: 0 0 2px var(--c-ring-glow-19, rgba(194,0,158,.6)); }
  78% { border-color: var(--c-ring-edge-5, rgba(255,230,255,.95)); box-shadow: 0 0 3px var(--c-ring-glow-16, rgba(255,150,240,1)), inset 0 0 3px var(--c-ring-glow-17, rgba(255,200,255,.9)); }
  90%, 91% { border-color: transparent; box-shadow: none; }
  92% { border-color: var(--c-ring-edge-5, rgba(255,230,255,.95)); box-shadow: 0 0 3px var(--c-ring-glow-16, rgba(255,150,240,1)), inset 0 0 3px var(--c-ring-glow-17, rgba(255,200,255,.9)); }
}
@keyframes neon2Halo {
  0%, 100% { border-color: var(--c-aura-edge-1, rgba(255,16,240,.25)); box-shadow: 0 0 14px var(--c-aura-glow-1, rgba(255,16,240,.45)); }
  22%, 23% { border-color: transparent; box-shadow: none; }
  24% { border-color: var(--c-aura-edge-1, rgba(255,16,240,.25)); box-shadow: 0 0 14px var(--c-aura-glow-1, rgba(255,16,240,.45)); }
  35% { border-color: var(--c-ring-edge-7, rgba(255,16,240,.4)); box-shadow: 0 0 22px var(--c-ring-glow-20, rgba(255,16,240,.75)); }
  36% { border-color: var(--c-aura-edge-1, rgba(255,16,240,.25)); box-shadow: 0 0 14px var(--c-aura-glow-1, rgba(255,16,240,.45)); }
  48%, 49% { border-color: transparent; box-shadow: none; }
  50% { border-color: var(--c-aura-edge-1, rgba(255,16,240,.25)); box-shadow: 0 0 14px var(--c-aura-glow-1, rgba(255,16,240,.45)); }
  51%, 52% { border-color: transparent; box-shadow: none; }
  53% { border-color: var(--c-aura-edge-1, rgba(255,16,240,.25)); box-shadow: 0 0 14px var(--c-aura-glow-1, rgba(255,16,240,.45)); }
  70% { border-color: var(--c-ring-edge-8, rgba(194,0,158,.2)); box-shadow: 0 0 6px var(--c-ring-glow-21, rgba(194,0,158,.3)); }
  78% { border-color: var(--c-aura-edge-1, rgba(255,16,240,.25)); box-shadow: 0 0 14px var(--c-aura-glow-1, rgba(255,16,240,.45)); }
  90%, 91% { border-color: transparent; box-shadow: none; }
  92% { border-color: var(--c-aura-edge-1, rgba(255,16,240,.25)); box-shadow: 0 0 14px var(--c-aura-glow-1, rgba(255,16,240,.45)); }
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
  border: 2px solid var(--c-ring-edge-1, #ffe4ef);
  background: transparent;
  box-shadow:
    0 0 0 1px var(--c-ring-glow-1, rgba(255,235,245,.9)), 0 0 8px var(--c-ring-glow-2, rgba(255,224,236,.85)), 0 0 14px var(--c-ring-glow-3, rgba(255,200,222,.55)), 0 0 22px var(--c-ring-glow-4, rgba(244,127,170,.3)),
    inset 0 0 6px var(--c-ring-glow-5, rgba(255,240,247,.7));
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
    radial-gradient(circle at 70% 28%, var(--c-petal-bg-1, rgba(255,255,255,.7)) 0 1px, transparent 1.5px),
    radial-gradient(ellipse at 35% 75%, var(--c-petal-bg-2, rgba(228,109,155,.35)) 0 2px, transparent 2.8px),
    linear-gradient(135deg, var(--pc, var(--c-petal-bg-3, #ffd8e8)) 0%, var(--pc2, var(--c-petal-bg-4, #ffabc9)) 55%, var(--pc3, var(--c-petal-bg-5, #f47faa)) 100%);
  border-radius: 78% 22% 74% 26%;
  transform-origin: 55% 70%;
  filter: drop-shadow(0 0 1px var(--c-petal-glow-1, rgba(255,255,255,.55))) drop-shadow(0 1px 1px var(--c-petal-glow-2, rgba(160,70,105,.18)));
  opacity: 0;
}
.b-sakura-v2 .p1  { --pc: var(--c-petal-color-1, #fffafc); --pc2: var(--c-ring-edge-1, #ffe4ef); --pc3: var(--c-petal-color-2, #ffc4d8); left: 4%;  top: -5px; animation: sk2Drop 5.7s ease-in-out -.4s infinite; }
.b-sakura-v2 .p2  { --pc: var(--c-petal-bg-3, #ffd8e8); --pc2: var(--c-petal-bg-4, #ffabc9); --pc3: var(--c-petal-bg-5, #f47faa); left: 16%; top: -5px; animation: sk2Drop 7.1s ease-in-out -2.2s infinite; }
.b-sakura-v2 .p3  { --pc: var(--c-petal-color-3, #ffeaf2); --pc2: var(--c-petal-color-4, #ffcadd); --pc3: var(--c-petal-color-5, #ff9ec0); left: 28%; top: -5px; animation: sk2Drop 6.4s ease-in-out -1.1s infinite; }
.b-sakura-v2 .p4  { --pc: var(--c-petal-bg-4, #ffabc9); --pc2: var(--c-petal-bg-5, #f47faa); --pc3: var(--c-petal-color-6, #e46d9b); left: 40%; top: -5px; animation: sk2Drop 8.2s ease-in-out -3.6s infinite; }
.b-sakura-v2 .p5  { --pc: var(--c-petal-color-1, #fffafc); --pc2: var(--c-petal-bg-3, #ffd8e8); --pc3: var(--c-petal-bg-4, #ffabc9); left: 52%; top: -5px; animation: sk2Drop 5.9s ease-in-out -2.9s infinite; }
.b-sakura-v2 .p6  { --pc: var(--c-petal-bg-3, #ffd8e8); --pc2: var(--c-petal-bg-5, #f47faa); --pc3: var(--c-petal-color-7, #c95480); left: 64%; top: -5px; animation: sk2Drop 7.6s ease-in-out -1.7s infinite; }
.b-sakura-v2 .p7  { --pc: var(--c-petal-color-3, #ffeaf2); --pc2: var(--c-petal-bg-4, #ffabc9); --pc3: var(--c-petal-bg-5, #f47faa); left: 76%; top: -5px; animation: sk2Drop 6.8s ease-in-out -4.4s infinite; }
.b-sakura-v2 .p8  { --pc: var(--c-petal-bg-4, #ffabc9); --pc2: var(--c-petal-color-6, #e46d9b); --pc3: var(--c-petal-color-8, #b04572); left: 86%; top: -5px; animation: sk2Drop 8.8s ease-in-out -5.5s infinite; }
.b-sakura-v2 .p9  { --pc: var(--c-petal-color-1, #fffafc); --pc2: var(--c-petal-color-4, #ffcadd); --pc3: var(--c-petal-bg-4, #ffabc9); left: 36%; top: -5px; animation: sk2Drop 9.2s ease-in-out -6.3s infinite; }
.b-sakura-v2 .p10 { --pc: var(--c-petal-bg-3, #ffd8e8); --pc2: var(--c-petal-bg-4, #ffabc9); --pc3: var(--c-petal-color-6, #e46d9b); left: 58%; top: -5px; animation: sk2Drop 7.9s ease-in-out -5.1s infinite; }
.b-sakura-v2 .petal-pile {
  position: absolute;
  left: 8%; right: 8%; bottom: -2px;
  height: 6px;
  pointer-events: none;
  border-radius: 999em;
  background:
    radial-gradient(ellipse at center, var(--c-petal-pile-bg-1, rgba(255,171,201,.45)) 0, var(--c-petal-pile-bg-2, rgba(244,127,170,.22)) 44%, transparent 78%),
    linear-gradient(90deg, transparent 0, var(--c-petal-pile-bg-3, rgba(255,213,230,.35)) 50%, transparent 100%);
  filter: blur(1.5px);
  opacity: .4;
  z-index: 21;
  animation: sk2Pile 5.8s ease-in-out infinite;
}
.b-sakura-v2 .pic { box-shadow: 0 0 6px var(--c-pic-glow-1, rgba(255,200,222,.5)), inset 0 -8px 16px var(--c-pic-glow-2, rgba(0,0,0,.15)); }
@keyframes sk2Pulse {
  0%, 100% { border-color: var(--c-ring-edge-1, #ffe4ef); box-shadow: 0 0 0 1px var(--c-ring-glow-1, rgba(255,235,245,.9)), 0 0 8px var(--c-ring-glow-2, rgba(255,224,236,.85)), 0 0 14px var(--c-ring-glow-3, rgba(255,200,222,.55)), 0 0 22px var(--c-ring-glow-4, rgba(244,127,170,.3)), inset 0 0 6px var(--c-ring-glow-5, rgba(255,240,247,.7)); }
  50% { border-color: var(--c-ring-edge-2, #fff0f6); box-shadow: 0 0 0 1px var(--c-ring-glow-6, rgba(255,245,250,1)), 0 0 12px var(--c-ring-glow-7, rgba(255,235,245,1)), 0 0 20px var(--c-ring-glow-8, rgba(255,210,228,.75)), 0 0 30px var(--c-ring-glow-9, rgba(244,127,170,.45)), inset 0 0 10px var(--c-ring-glow-10, rgba(255,248,251,.9)); }
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
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-ember-glow { padding: 2px; background: conic-gradient(from 180deg, var(--c-ring-bg-1, #b71c1c), var(--c-ring-bg-2, #d84315), var(--c-ring-bg-3, #ff6f00), var(--c-ring-bg-2, #d84315), var(--c-ring-bg-4, #6d1b1b)); animation: egPulse 3.6s ease-in-out infinite; box-shadow: 0 0 0 1px var(--c-ring-glow-1, rgba(255,138,80,.55)), 0 0 10px color-mix(in srgb, var(--c-ring-bg-3, #ff6f00) 65%, transparent), inset 0 0 6px var(--c-ring-glow-2, rgba(255,193,7,.32)); }
.b-ember-glow .ember-field {
  position: absolute;
  inset: -10px -4px -4px -4px;
  border-radius: 50%;
  pointer-events: none;
  overflow: visible;
  z-index: 20;
}
.b-ember-glow .ember {
  position: absolute;
  width: 3px; height: 3px;
  border-radius: 50%;
  background:
    radial-gradient(circle, var(--ec, var(--c-ember-bg-1, #fff59d)) 0 25%, var(--ec2, var(--c-ember-bg-2, #ffab40)) 55%, transparent 75%);
  filter: drop-shadow(0 0 3px var(--eglow, var(--c-ring-bg-3, #ff6f00))) drop-shadow(0 0 6px var(--eglow2, var(--c-ring-bg-2, #d84315)));
  opacity: 0;
}
.b-ember-glow .em1  { --ec: var(--c-ember-color-1, #fff9c4); --ec2: var(--c-ember-color-2, #ffca28); --eglow: var(--c-ember-color-3, #ff8f00); --eglow2: var(--c-ember-color-4, #e65100); left: 8%;  bottom: -5px; animation: egRise 4.4s ease-out -.2s infinite; }
.b-ember-glow .em2  { --ec: var(--c-ember-bg-1, #fff59d); --ec2: var(--c-ember-bg-2, #ffab40); --eglow: var(--c-ring-bg-3, #ff6f00); --eglow2: var(--c-ember-color-5, #bf360c); left: 19%; bottom: -5px; animation: egRise 5.6s ease-out -1.8s infinite; }
.b-ember-glow .em3  { --ec: var(--c-ember-color-6, #fff176); --ec2: var(--c-ember-color-7, #ff8a65); --eglow: var(--c-ember-color-8, #ff5722); --eglow2: var(--c-ring-bg-1, #b71c1c); left: 31%; bottom: -5px; animation: egRise 4.9s ease-out -2.9s infinite; }
.b-ember-glow .em4  { --ec: var(--c-ember-color-1, #fff9c4); --ec2: var(--c-ember-color-9, #ffa726); --eglow: var(--c-ring-bg-3, #ff6f00); --eglow2: var(--c-ember-color-4, #e65100); left: 42%; bottom: -5px; animation: egRise 6.2s ease-out -3.7s infinite; }
.b-ember-glow .em5  { --ec: var(--c-ember-bg-1, #fff59d); --ec2: var(--c-ember-color-10, #ff7043); --eglow: var(--c-ember-color-11, #ef6c00); --eglow2: var(--c-ember-color-5, #bf360c); left: 53%; bottom: -5px; animation: egRise 4.5s ease-out -.9s infinite; }
.b-ember-glow .em6  { --ec: var(--c-ember-color-12, #ffd54f); --ec2: var(--c-ember-color-8, #ff5722); --eglow: var(--c-ring-bg-2, #d84315); --eglow2: var(--c-ring-bg-1, #b71c1c); left: 65%; bottom: -5px; animation: egRise 5.3s ease-out -4.6s infinite; }
.b-ember-glow .em7  { --ec: var(--c-ember-color-6, #fff176); --ec2: var(--c-ember-color-13, #ff9100); --eglow: var(--c-ring-bg-3, #ff6f00); --eglow2: var(--c-ember-color-5, #bf360c); left: 76%; bottom: -5px; animation: egRise 4.2s ease-out -1.4s infinite; }
.b-ember-glow .em8  { --ec: var(--c-ember-bg-1, #fff59d); --ec2: var(--c-ember-color-7, #ff8a65); --eglow: var(--c-ember-color-8, #ff5722); --eglow2: var(--c-ring-bg-1, #b71c1c); left: 87%; bottom: -5px; animation: egRise 6.0s ease-out -3.2s infinite; }
.b-ember-glow .em9  { --ec: var(--c-ember-color-14, #fffde7); --ec2: var(--c-ember-color-15, #ffb74d); --eglow: var(--c-ember-color-3, #ff8f00); --eglow2: var(--c-ember-color-4, #e65100); left: 36%; bottom: -5px; animation: egRise 5.0s ease-out -5.5s infinite; }
.b-ember-glow .em10 { --ec: var(--c-ember-color-6, #fff176); --ec2: var(--c-ember-color-8, #ff5722); --eglow: var(--c-ring-bg-2, #d84315); --eglow2: var(--c-ring-bg-4, #6d1b1b); left: 60%; bottom: -5px; animation: egRise 5.8s ease-out -2.3s infinite; }
.b-ember-glow .pic { box-shadow: 0 0 8px var(--c-pic-glow-1, rgba(255,138,80,.4)), inset 0 0 10px var(--c-pic-glow-2, rgba(0,0,0,.18)); }
@keyframes egPulse {
  0%, 100% { box-shadow: 0 0 0 1px var(--c-ring-glow-1, rgba(255,138,80,.55)), 0 0 10px color-mix(in srgb, var(--c-ring-bg-3, #ff6f00) 65%, transparent), inset 0 0 6px var(--c-ring-glow-2, rgba(255,193,7,.32)); }
  50%      { box-shadow: 0 0 0 1px var(--c-ring-glow-3, rgba(255,193,7,.85)), 0 0 16px color-mix(in srgb, var(--c-ember-color-3, #ff8f00) 95%, transparent), inset 0 0 10px var(--c-ring-glow-4, rgba(255,213,79,.45)); }
}
@keyframes egRise {
  0%   { transform: translate3d(0, 0, 0) scale(.6); opacity: 0; }
  12%  { opacity: 1; transform: translate3d(-1px, -6px, 0) scale(.95); }
  45%  { transform: translate3d(3px, -18px, 0) scale(1); opacity: .9; }
  75%  { transform: translate3d(-2px, -28px, 0) scale(.85); opacity: .5; }
  100% { transform: translate3d(2px, -38px, 0) scale(.5); opacity: 0; }
}',
    `updated_at` = unixepoch() * 1000
WHERE `key` = 'ember-glow' AND `is_builtin` = 1;
--> statement-breakpoint

UPDATE `freeform_borders`
SET `style_css` = '.b-hearth-flame { padding: 2px; background: linear-gradient(to top, var(--c-ring-bg-1, #b71c1c) 0%, var(--c-ring-bg-2, #ff7700) 50%, var(--c-ring-bg-3, #ffd244) 100%); background-size: 100% 250%; animation: hfPan 2.4s ease-in-out infinite; box-shadow: 0 -4px 14px color-mix(in srgb, var(--c-ring-glow-1, #ff8f00) 70%, transparent), 0 0 0 1px var(--c-ring-glow-2, rgba(255,87,34,.45)), inset 0 -6px 10px var(--c-ring-glow-3, rgba(255,213,79,.35)), inset 0 4px 6px var(--c-ring-glow-4, rgba(0,0,0,.15)); }
.b-hearth-flame .pic { box-shadow: 0 -2px 8px var(--c-pic-glow-1, rgba(255,138,80,.5)), inset 0 -6px 14px var(--c-pic-glow-2, rgba(0,0,0,.18)); }
.b-hearth-flame .haze {
  position: absolute;
  inset: -2px -2px 50% -2px;
  border-radius: 50%;
  pointer-events: none;
  background: radial-gradient(ellipse at 50% 100%, var(--c-haze-bg-1, rgba(255,180,80,.32)) 0%, var(--c-haze-bg-2, rgba(255,140,60,.18)) 35%, transparent 65%);
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
  background: linear-gradient(to top, var(--c-ring-bg-1, #b71c1c) 0%, var(--c-flame-bg-1, #ff6f00) 45%, var(--c-flame-bg-2, #ffd54f) 80%, transparent 100%);
  border-radius: 50% 50% 50% 50% / 75% 75% 30% 30%;
  transform-origin: 50% 100%;
  filter: drop-shadow(0 0 4px var(--c-flame-bg-1, #ff6f00)) drop-shadow(0 0 8px var(--c-flame-glow-1, #d84315));
  opacity: .92;
}
.b-hearth-flame .fl1 { left: 28%; animation: hfFlicker 1.1s ease-in-out -.0s infinite; }
.b-hearth-flame .fl2 { left: 46%; width: 10px; height: 22px; animation: hfFlicker 1.35s ease-in-out -.32s infinite; }
.b-hearth-flame .fl3 { left: 62%; animation: hfFlicker 1.2s ease-in-out -.18s infinite; }
.b-hearth-flame .hearth-log {
  position: absolute;
  left: 14%; right: 14%; bottom: -4px;
  height: 7px;
  border-radius: 999em;
  background:
    radial-gradient(ellipse at center, var(--c-hearth-log-bg-1, rgba(255,213,79,.85)) 0%, var(--c-hearth-log-bg-2, rgba(255,111,0,.55)) 35%, transparent 70%),
    linear-gradient(90deg, var(--c-hearth-log-bg-3, rgba(62,39,35,.85)) 0%, var(--c-hearth-log-bg-4, rgba(109,76,65,.9)) 50%, var(--c-hearth-log-bg-3, rgba(62,39,35,.85)) 100%);
  box-shadow: 0 -1px 4px var(--c-hearth-log-glow-1, rgba(255,143,0,.55));
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
    `updated_at` = unixepoch() * 1000
WHERE `key` = 'hearth-flame' AND `is_builtin` = 1;
--> statement-breakpoint

