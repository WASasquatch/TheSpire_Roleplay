-- Convert several seed free-form borders to use `--c-*` color
-- variables so the per-identity color customization system has
-- something to exercise out of the box.
--
-- Convention (mirrors what `extractFreeformBorderVars()` looks for):
-- every customizable color slot is referenced as
-- `var(--c-<name>, <fallback>)`. The fallback keeps the catalog
-- preview rendering correctly when no user override is saved; the
-- per-identity config_json supplies overrides for any subset of
-- slots and the renderer inlines them onto the BorderedAvatar
-- portal wrapper so the cascade resolves them.
--
-- Color names chosen for player intuition rather than CSS purity,
-- "ring-main" / "ring-accent" / "glow" reads better in a picker
-- label than "stop-1" / "stop-2". The CSS uses `color-mix(...)` to
-- preserve alpha on glows so the user picks a hex and the
-- transparency-modulated paint stays correct.
--
-- `is_builtin = 1` guard restricts these updates to the seeded rows;
-- admin custom edits to a seed are not preserved across this
-- migration.

-- =========================================================
-- aurora-v2, RARE, conic gradient with cyan + purple bloom
-- Customizable slots: ring-main (cyan), ring-soft (mid teal),
--                     ring-accent (purple), glow (outer halo),
--                     wash (highlight overlay sweep)
-- =========================================================
UPDATE `freeform_borders`
SET `style_css` = '.b-aurora-v2 { padding: 2px; background: conic-gradient(from 0deg, var(--c-ring-main, #00e5ff), var(--c-ring-soft, #4dd0e1), var(--c-ring-soft, #80deea), var(--c-ring-accent, #b39ddb), var(--c-ring-soft, #4dd0e1), var(--c-ring-main, #00bcd4), var(--c-ring-main, #00e5ff)); animation: aV2Spin 5s linear infinite; box-shadow: 0 0 8px color-mix(in srgb, var(--c-glow, #00e5ff) 50%, transparent); }
.b-aurora-v2::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from 180deg, transparent, color-mix(in srgb, var(--c-wash, #ffffff) 60%, transparent), transparent, transparent); animation: aV2Wash 3s linear infinite; mix-blend-mode: overlay; }
.b-aurora-v2 .pic { animation: aV2Counter 5s linear infinite; }
@keyframes aV2Spin { to { transform: rotate(360deg); } }
@keyframes aV2Counter { to { transform: rotate(-360deg); } }
@keyframes aV2Wash { to { transform: rotate(-360deg); } }',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'aurora-v2' AND `is_builtin` = 1;
--> statement-breakpoint

-- =========================================================
-- tide, RARE, conic teal gradient with ripple expansion
-- Customizable slots: ring-main (deep teal), ring-soft (light teal),
--                     ripple (expanding ring color)
-- =========================================================
UPDATE `freeform_borders`
SET `style_css` = '.b-tide { padding: 2px; background: conic-gradient(from 90deg, var(--c-ring-main, #006064), var(--c-ring-main, #00838f), var(--c-ring-soft, #0097a7), var(--c-ring-soft, #4dd0e1), var(--c-ring-main, #006064)); animation: tideRotate 8s linear infinite; box-shadow: 0 0 6px color-mix(in srgb, var(--c-glow, #0097a7) 50%, transparent), inset 0 0 4px rgba(255,255,255,.2); }
.b-tide::before { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--c-ripple, #b2ebf2) 70%, transparent); animation: tideRipple 2.5s ease-out infinite; }
.b-tide::after { content: ""; position: absolute; inset: 0; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--c-ripple, #b2ebf2) 70%, transparent); animation: tideRipple 2.5s ease-out infinite 1.25s; }
.b-tide .pic { animation: tideRotate 8s linear infinite reverse; }
@keyframes tideRotate { to { transform: rotate(360deg); } }
@keyframes tideRipple {
  0% { transform: scale(.96); opacity: 1; }
  100% { transform: scale(1.12); opacity: 0; }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'tide' AND `is_builtin` = 1;
--> statement-breakpoint

-- =========================================================
-- forest, RARE, swaying conic green ring with falling leaves
-- Customizable slots: ring-main (deep green), ring-soft (mid green),
--                     ring-accent (light leaf-green),
--                     leaf (color of falling decorative leaves),
--                     glow (outer bloom color)
-- =========================================================
UPDATE `freeform_borders`
SET `style_css` = '.b-forest { padding: 2px; background: conic-gradient(from 45deg, var(--c-ring-main, #2e7d32), var(--c-ring-soft, #66bb6a), var(--c-ring-accent, #aed581), var(--c-ring-soft, #66bb6a), var(--c-ring-main, #1b5e20)); animation: forestSway 6s ease-in-out infinite; box-shadow: 0 0 8px color-mix(in srgb, var(--c-glow, #66bb6a) 40%, transparent); }
.b-forest .leaf { position: absolute; width: 5px; height: 8px; background: var(--c-leaf, #66bb6a); border-radius: 0 100% 0 100%; box-shadow: inset 0 0 0 1px var(--c-ring-main, #2e7d32); }
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
