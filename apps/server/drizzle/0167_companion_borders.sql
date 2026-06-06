-- Companion borders for existing name styles, kicking off the
-- "matched name-style + border" cosmetic pairings.
--
-- This pass:
--   1. Upgrades Sylvan (key: 'forest') to Sakura-grade, many falling
--      leaves with size + drift variation, a forest-floor pile fade,
--      gentle ring sway. Replaces the threadbare 3-leaf strip with
--      the same particle-field structure sakura-v2 uses.
--   2. Adds 'ember-glow', companion to the 'embers' name style.
--      Embers float UP from the bottom rim instead of down, fading
--      toward the top. Pulsing inner ring of warm orange/red.
--   3. Adds 'hearth-flame', companion to the 'hearth_fire' name
--      style. Flickering flame tongues licking around the avatar
--      rim plus a smouldering log glow at the bottom. Steady,
--      cozy warmth rather than chaos.
--
-- Both new borders use the `--c-*` color-customization convention
-- so owners can re-tint via the freeform-border config endpoint.

-- =========================================================
-- SYLVAN UPGRADE
-- =========================================================

UPDATE `freeform_borders`
SET `style_css` = '.b-forest { padding: 2px; background: conic-gradient(from 45deg, var(--c-ring-main, #2e7d32), var(--c-ring-soft, #66bb6a), var(--c-ring-accent, #aed581), var(--c-ring-soft, #66bb6a), var(--c-ring-main, #1b5e20)); animation: fxSway 6s ease-in-out infinite; box-shadow: 0 0 0 1px rgba(174,213,129,.6), 0 0 10px color-mix(in srgb, var(--c-glow, #66bb6a) 50%, transparent), inset 0 0 6px rgba(46,125,50,.3); }
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
    radial-gradient(ellipse at 50% 35%, rgba(255,255,255,.35) 0 1px, transparent 1.8px),
    radial-gradient(circle at 50% 65%, rgba(27,94,32,.45) 0 1.5px, transparent 2.2px),
    linear-gradient(160deg, var(--lc, #aed581) 0%, var(--lc2, #66bb6a) 55%, var(--lc3, #2e7d32) 100%);
  border-radius: 0 100% 0 100%;
  transform-origin: 50% 30%;
  filter: drop-shadow(0 0 1px rgba(174,213,129,.55)) drop-shadow(0 1px 1px rgba(27,94,32,.25));
  opacity: 0;
}
.b-forest .lf1  { --lc: var(--c-leaf-light, #c5e1a5); --lc2: var(--c-leaf, #9ccc65); --lc3: var(--c-leaf-dark, #558b2f); left: 5%;  top: -7px; animation: fxLeafDrop 5.8s ease-in-out -.3s infinite; }
.b-forest .lf2  { --lc: var(--c-leaf-light, #aed581); --lc2: var(--c-leaf, #66bb6a); --lc3: var(--c-leaf-dark, #2e7d32); left: 18%; top: -7px; animation: fxLeafDrop 7.2s ease-in-out -2.1s infinite; }
.b-forest .lf3  { --lc: var(--c-leaf-light, #dcedc8); --lc2: var(--c-leaf, #aed581); --lc3: var(--c-leaf-dark, #689f38); left: 30%; top: -7px; animation: fxLeafDrop 6.4s ease-in-out -1.0s infinite; }
.b-forest .lf4  { --lc: var(--c-leaf-light, #c5e1a5); --lc2: var(--c-leaf-dark, #558b2f); --lc3: #33691e;                left: 42%; top: -7px; animation: fxLeafDrop 8.1s ease-in-out -3.4s infinite; }
.b-forest .lf5  { --lc: var(--c-leaf-light, #ffe082); --lc2: #ffb74d;                --lc3: #ef6c00;                       left: 53%; top: -7px; animation: fxLeafDrop 6.0s ease-in-out -2.7s infinite; }
.b-forest .lf6  { --lc: var(--c-leaf-light, #aed581); --lc2: var(--c-leaf, #66bb6a); --lc3: var(--c-leaf-dark, #1b5e20); left: 64%; top: -7px; animation: fxLeafDrop 7.5s ease-in-out -1.5s infinite; }
.b-forest .lf7  { --lc: var(--c-leaf-light, #dcedc8); --lc2: var(--c-leaf, #9ccc65); --lc3: var(--c-leaf-dark, #558b2f); left: 75%; top: -7px; animation: fxLeafDrop 6.9s ease-in-out -4.2s infinite; }
.b-forest .lf8  { --lc: var(--c-leaf-light, #ffcc80); --lc2: #ffa726;                --lc3: #e65100;                       left: 85%; top: -7px; animation: fxLeafDrop 8.6s ease-in-out -5.3s infinite; }
.b-forest .lf9  { --lc: var(--c-leaf-light, #c5e1a5); --lc2: var(--c-leaf, #66bb6a); --lc3: var(--c-leaf-dark, #2e7d32); left: 38%; top: -7px; animation: fxLeafDrop 9.0s ease-in-out -6.0s infinite; }
.b-forest .lf10 { --lc: var(--c-leaf-light, #aed581); --lc2: var(--c-leaf, #689f38); --lc3: var(--c-leaf-dark, #33691e); left: 60%; top: -7px; animation: fxLeafDrop 7.8s ease-in-out -4.9s infinite; }
.b-forest .leaf-pile {
  position: absolute;
  left: 10%; right: 10%; bottom: -3px;
  height: 6px;
  pointer-events: none;
  border-radius: 999em;
  background:
    radial-gradient(ellipse at center, rgba(102,187,106,.45) 0, rgba(46,125,50,.22) 44%, transparent 78%),
    linear-gradient(90deg, transparent 0, rgba(174,213,129,.35) 50%, transparent 100%);
  filter: blur(1.5px);
  opacity: .4;
  z-index: 21;
  animation: fxPile 6.2s ease-in-out infinite;
}
.b-forest .pic { animation: fxSway 6s ease-in-out infinite reverse; box-shadow: 0 0 6px rgba(102,187,106,.35), inset 0 -8px 16px rgba(0,0,0,.12); }
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
  `template` = '<div class="av b-forest"><div class="pic">{avatar}</div><div class="leaf-field"><div class="leaf lf1"></div><div class="leaf lf2"></div><div class="leaf lf3"></div><div class="leaf lf4"></div><div class="leaf lf5"></div><div class="leaf lf6"></div><div class="leaf lf7"></div><div class="leaf lf8"></div><div class="leaf lf9"></div><div class="leaf lf10"></div></div><div class="leaf-pile"></div></div>',
  `description` = 'Falling leaves drift past a swaying forest-canopy ring.',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'forest' AND `is_builtin` = 1;
--> statement-breakpoint

-- =========================================================
-- EMBER GLOW, companion to 'embers' name style
-- =========================================================

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `rarity`, `cost`, `is_builtin`, `enabled`, `order`,
   `image_url`, `template`, `style_css`)
VALUES
  ('ember-glow',
   'Ember glow',
   'Glowing embers drift upward past a smouldering ring.',
   'rare',
   50000,
   1, 1, 1010,
   NULL,
   '<div class="av b-ember-glow"><div class="pic">{avatar}</div><div class="ember-field"><div class="ember em1"></div><div class="ember em2"></div><div class="ember em3"></div><div class="ember em4"></div><div class="ember em5"></div><div class="ember em6"></div><div class="ember em7"></div><div class="ember em8"></div><div class="ember em9"></div><div class="ember em10"></div></div></div>',
   '.b-ember-glow { padding: 2px; background: conic-gradient(from 180deg, var(--c-ring-main, #b71c1c), var(--c-ring-soft, #d84315), var(--c-ring-accent, #ff6f00), var(--c-ring-soft, #d84315), var(--c-ring-main, #6d1b1b)); animation: egPulse 3.6s ease-in-out infinite; box-shadow: 0 0 0 1px rgba(255,138,80,.55), 0 0 10px color-mix(in srgb, var(--c-glow, #ff6f00) 65%, transparent), inset 0 0 6px rgba(255,193,7,.32); }
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
    radial-gradient(circle, var(--ec, #fff59d) 0 25%, var(--ec2, #ffab40) 55%, transparent 75%);
  filter: drop-shadow(0 0 3px var(--eglow, #ff6f00)) drop-shadow(0 0 6px var(--eglow2, #d84315));
  opacity: 0;
}
.b-ember-glow .em1  { --ec: #fff9c4; --ec2: #ffca28; --eglow: #ff8f00; --eglow2: #e65100; left: 8%;  bottom: -5px; animation: egRise 4.4s ease-out -.2s infinite; }
.b-ember-glow .em2  { --ec: #fff59d; --ec2: #ffab40; --eglow: #ff6f00; --eglow2: #bf360c; left: 19%; bottom: -5px; animation: egRise 5.6s ease-out -1.8s infinite; }
.b-ember-glow .em3  { --ec: #fff176; --ec2: #ff8a65; --eglow: #ff5722; --eglow2: #b71c1c; left: 31%; bottom: -5px; animation: egRise 4.9s ease-out -2.9s infinite; }
.b-ember-glow .em4  { --ec: #fff9c4; --ec2: #ffa726; --eglow: #ff6f00; --eglow2: #e65100; left: 42%; bottom: -5px; animation: egRise 6.2s ease-out -3.7s infinite; }
.b-ember-glow .em5  { --ec: #fff59d; --ec2: #ff7043; --eglow: #ef6c00; --eglow2: #bf360c; left: 53%; bottom: -5px; animation: egRise 4.5s ease-out -.9s infinite; }
.b-ember-glow .em6  { --ec: #ffd54f; --ec2: #ff5722; --eglow: #d84315; --eglow2: #b71c1c; left: 65%; bottom: -5px; animation: egRise 5.3s ease-out -4.6s infinite; }
.b-ember-glow .em7  { --ec: #fff176; --ec2: #ff9100; --eglow: #ff6f00; --eglow2: #bf360c; left: 76%; bottom: -5px; animation: egRise 4.2s ease-out -1.4s infinite; }
.b-ember-glow .em8  { --ec: #fff59d; --ec2: #ff8a65; --eglow: #ff5722; --eglow2: #b71c1c; left: 87%; bottom: -5px; animation: egRise 6.0s ease-out -3.2s infinite; }
.b-ember-glow .em9  { --ec: #fffde7; --ec2: #ffb74d; --eglow: #ff8f00; --eglow2: #e65100; left: 36%; bottom: -5px; animation: egRise 5.0s ease-out -5.5s infinite; }
.b-ember-glow .em10 { --ec: #fff176; --ec2: #ff5722; --eglow: #d84315; --eglow2: #6d1b1b; left: 60%; bottom: -5px; animation: egRise 5.8s ease-out -2.3s infinite; }
.b-ember-glow .pic { box-shadow: 0 0 8px rgba(255,138,80,.4), inset 0 0 10px rgba(0,0,0,.18); }
@keyframes egPulse {
  0%, 100% { box-shadow: 0 0 0 1px rgba(255,138,80,.55), 0 0 10px color-mix(in srgb, var(--c-glow, #ff6f00) 65%, transparent), inset 0 0 6px rgba(255,193,7,.32); }
  50%      { box-shadow: 0 0 0 1px rgba(255,193,7,.85), 0 0 16px color-mix(in srgb, var(--c-glow, #ff8f00) 95%, transparent), inset 0 0 10px rgba(255,213,79,.45); }
}
@keyframes egRise {
  0%   { transform: translate3d(0, 0, 0) scale(.6); opacity: 0; }
  12%  { opacity: 1; transform: translate3d(-1px, -6px, 0) scale(.95); }
  45%  { transform: translate3d(3px, -18px, 0) scale(1); opacity: .9; }
  75%  { transform: translate3d(-2px, -28px, 0) scale(.85); opacity: .5; }
  100% { transform: translate3d(2px, -38px, 0) scale(.5); opacity: 0; }
}');
--> statement-breakpoint

-- =========================================================
-- HEARTH FLAME, companion to 'hearth_fire' name style
-- =========================================================

INSERT OR IGNORE INTO `freeform_borders`
  (`key`, `name`, `description`, `rarity`, `cost`, `is_builtin`, `enabled`, `order`,
   `image_url`, `template`, `style_css`)
VALUES
  ('hearth-flame',
   'Hearth flame',
   'A cozy ring of flickering hearth-fire with a smouldering log at the base.',
   'epic',
   150000,
   1, 1, 2010,
   NULL,
   '<div class="av b-hearth-flame"><div class="pic">{avatar}</div><div class="flame-ring"><div class="flame fl1"></div><div class="flame fl2"></div><div class="flame fl3"></div><div class="flame fl4"></div><div class="flame fl5"></div><div class="flame fl6"></div><div class="flame fl7"></div><div class="flame fl8"></div></div><div class="hearth-log"></div></div>',
   '.b-hearth-flame { padding: 2px; background: conic-gradient(from 0deg, var(--c-ring-main, #b71c1c), var(--c-ring-soft, #ff6f00), var(--c-ring-accent, #ffc107), var(--c-ring-soft, #ff8f00), var(--c-ring-main, #d84315), var(--c-ring-soft, #ff6f00), var(--c-ring-main, #b71c1c)); animation: hfBreathe 4.4s ease-in-out infinite; box-shadow: 0 0 0 1px rgba(255,87,34,.5), 0 0 14px color-mix(in srgb, var(--c-glow, #ff8f00) 80%, transparent), inset 0 0 8px rgba(255,213,79,.4); }
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
}
.b-hearth-flame .fl1 { --fc-base: #b71c1c; --fc-mid: #ff6f00; --fc-top: #ffeb3b; transform: rotate(  0deg) translate(0, -46px); animation: hfFlicker 1.1s ease-in-out -.0s infinite; }
.b-hearth-flame .fl2 { --fc-base: #bf360c; --fc-mid: #ff8f00; --fc-top: #ffc107; transform: rotate( 45deg) translate(0, -46px); animation: hfFlicker 1.3s ease-in-out -.18s infinite; }
.b-hearth-flame .fl3 { --fc-base: #b71c1c; --fc-mid: #ff5722; --fc-top: #ffb300; transform: rotate( 90deg) translate(0, -46px); animation: hfFlicker 1.0s ease-in-out -.35s infinite; }
.b-hearth-flame .fl4 { --fc-base: #6d1b1b; --fc-mid: #ff6f00; --fc-top: #ffd54f; transform: rotate(135deg) translate(0, -46px); animation: hfFlicker 1.4s ease-in-out -.52s infinite; }
.b-hearth-flame .fl5 { --fc-base: #b71c1c; --fc-mid: #ff8f00; --fc-top: #ffeb3b; transform: rotate(180deg) translate(0, -46px); animation: hfFlicker 1.2s ease-in-out -.7s infinite; }
.b-hearth-flame .fl6 { --fc-base: #bf360c; --fc-mid: #ff5722; --fc-top: #ffc107; transform: rotate(225deg) translate(0, -46px); animation: hfFlicker 1.05s ease-in-out -.87s infinite; }
.b-hearth-flame .fl7 { --fc-base: #b71c1c; --fc-mid: #ff6f00; --fc-top: #ffb300; transform: rotate(270deg) translate(0, -46px); animation: hfFlicker 1.35s ease-in-out -1.05s infinite; }
.b-hearth-flame .fl8 { --fc-base: #6d1b1b; --fc-mid: #ff8f00; --fc-top: #ffd54f; transform: rotate(315deg) translate(0, -46px); animation: hfFlicker 1.15s ease-in-out -1.22s infinite; }
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
}');
