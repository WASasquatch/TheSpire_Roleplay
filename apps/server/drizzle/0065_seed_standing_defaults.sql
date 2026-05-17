-- Seed defaults for the Standing system.
--
-- Inserts (idempotently, via INSERT OR IGNORE on the primary keys):
--   6 ranks       New Arrival → Legacy Member
--   24 rank_tiers 4 tiers per rank, with XP thresholds + sigil/border URLs
--   6 name_styles gradient, gradient_shadow, gradient_glow,
--                 gradient_shadow_glow, pulsing, panning_gradient
--   2 cosmetics   inline_avatar, rank_border
--
-- And populates `site_settings.standing_config_json` with the default
-- awards / caps / transfer-limits document so the admin UI starts
-- with a concrete config to edit. The shape mirrors StandingConfig
-- in apps/server/src/standing/config.ts.
--
-- Asset URLs point at /assets/ranks/* (bundled into the web build).
-- Admins can replace any sigil/border by uploading a PNG through the
-- admin Ranks tab which rewrites the URL to /uploads/ranks/<hash>.png.
--
-- Thresholds are starter values to be tuned during beta. Every row is
-- admin-editable from the Ranks tab.

-- ranks ----------------------------------------------------------------
INSERT OR IGNORE INTO `ranks` (`key`, `name`, `order`, `enabled`) VALUES
  ('new_arrival',  'New Arrival',   1, 1),
  ('active',       'Active',        2, 1),
  ('recognized',   'Recognized',    3, 1),
  ('established',  'Established',   4, 1),
  ('distinguished','Distinguished', 5, 1),
  ('legacy_member','Legacy Member', 6, 1);
--> statement-breakpoint

-- rank_tiers -----------------------------------------------------------
-- Tier 4 of every rank is the "Verified" capstone (Tier 4 of Legacy
-- Member is "Eternalized") and is the only tier that carries
-- border_image_url + border_cost. Borders are purchasable cosmetics;
-- prices are starter values for tuning.
INSERT OR IGNORE INTO `rank_tiers`
  (`id`, `rank_key`, `tier`, `label`, `xp_threshold`, `sigil_image_url`, `border_image_url`, `border_cost`, `enabled`)
VALUES
  ('rt_new_arrival_1',  'new_arrival',  1, 'I',              0,    '/assets/ranks/rank1_tier1.png',        NULL,                                            NULL,  1),
  ('rt_new_arrival_2',  'new_arrival',  2, 'II',             25,   '/assets/ranks/rank1_tier2.png',        NULL,                                            NULL,  1),
  ('rt_new_arrival_3',  'new_arrival',  3, 'III',            75,   '/assets/ranks/rank1_tier3.png',        NULL,                                            NULL,  1),
  ('rt_new_arrival_4',  'new_arrival',  4, 'IV: Verified',   150,  '/assets/ranks/rank1_tier4.png',        '/assets/ranks/rank1_tier4_border.png',          100,   1),

  ('rt_active_1',       'active',       1, 'I',              300,  '/assets/ranks/rank2_tier1.png',        NULL,                                            NULL,  1),
  ('rt_active_2',       'active',       2, 'II',             600,  '/assets/ranks/rank2_tier2.png',        NULL,                                            NULL,  1),
  ('rt_active_3',       'active',       3, 'III',            1000, '/assets/ranks/rank2_tier3.png',        NULL,                                            NULL,  1),
  ('rt_active_4',       'active',       4, 'IV: Verified',   1500, '/assets/ranks/rank2_tier4.png',        '/assets/ranks/rank2_tier4_border.png',          250,   1),

  ('rt_recognized_1',   'recognized',   1, 'I',              2500, '/assets/ranks/rank3_tier1.png',        NULL,                                            NULL,  1),
  ('rt_recognized_2',   'recognized',   2, 'II',             4000, '/assets/ranks/rank3_tier2.png',        NULL,                                            NULL,  1),
  ('rt_recognized_3',   'recognized',   3, 'III',            6000, '/assets/ranks/rank3_tier3.png',        NULL,                                            NULL,  1),
  ('rt_recognized_4',   'recognized',   4, 'IV: Verified',   9000, '/assets/ranks/rank3_tier4.png',        '/assets/ranks/rank3_tier4_border.png',          500,   1),

  ('rt_established_1',  'established',  1, 'I',              13000,'/assets/ranks/rank4_tier1.png',        NULL,                                            NULL,  1),
  ('rt_established_2',  'established',  2, 'II',             18000,'/assets/ranks/rank4_tier2.png',        NULL,                                            NULL,  1),
  ('rt_established_3',  'established',  3, 'III',            24000,'/assets/ranks/rank4_tier3.png',        NULL,                                            NULL,  1),
  ('rt_established_4',  'established',  4, 'IV: Verified',   32000,'/assets/ranks/rank4_tier4.png',        '/assets/ranks/rank4_tier4_border.png',          1000,  1),

  ('rt_distinguished_1','distinguished',1, 'I',              42000,'/assets/ranks/rank5_tier1.png',        NULL,                                            NULL,  1),
  ('rt_distinguished_2','distinguished',2, 'II',             55000,'/assets/ranks/rank5_tier2.png',        NULL,                                            NULL,  1),
  ('rt_distinguished_3','distinguished',3, 'III',            70000,'/assets/ranks/rank5_tier3.png',        NULL,                                            NULL,  1),
  ('rt_distinguished_4','distinguished',4, 'IV: Verified',   90000,'/assets/ranks/rank5_tier4.png',        '/assets/ranks/rank5_tier4_border.png',          2000,  1),

  ('rt_legacy_member_1','legacy_member',1, 'I',              115000,'/assets/ranks/rank6_tier1.png',       NULL,                                            NULL,  1),
  ('rt_legacy_member_2','legacy_member',2, 'II',             145000,'/assets/ranks/rank6_tier2.png',       NULL,                                            NULL,  1),
  ('rt_legacy_member_3','legacy_member',3, 'III',            180000,'/assets/ranks/rank6_tier3.png',       NULL,                                            NULL,  1),
  ('rt_legacy_member_4','legacy_member',4, 'IV: Eternalized',225000,'/assets/ranks/rank6_tier4.png',       '/assets/ranks/rank6_tier4_border.png',          5000,  1);
--> statement-breakpoint

-- name_styles ----------------------------------------------------------
-- Six seed templates. All use CSS custom properties (--user-color-1,
-- --user-color-2, --user-glow) that the StyledName renderer sets
-- inline per user from their per-style config in user_owned_name_styles.
-- Each declares a unique wrapper class (ns-<key>) so multiple styles
-- can coexist on the page without interfering.
--
-- Costs are starter values to be tuned.
INSERT OR IGNORE INTO `name_styles`
  (`key`, `name`, `description`, `template`, `style_css`, `cost`, `enabled`, `is_builtin`, `order`)
VALUES
  ('gradient',
   'Gradient',
   'Two-color linear gradient across the displayed name.',
   '<span class="ns-gradient">{username}</span>',
   '.ns-gradient { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; color: transparent; }',
   100, 1, 1, 1),

  ('gradient_shadow',
   'Gradient with Shadow',
   'Two-color gradient plus a soft drop shadow.',
   '<span class="ns-gradient-shadow">{username}</span>',
   '.ns-gradient-shadow { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; color: transparent; filter: drop-shadow(1px 1px 1px rgba(0,0,0,0.6)); }',
   150, 1, 1, 2),

  ('gradient_glow',
   'Gradient with Glow',
   'Two-color gradient with a colored glow halo.',
   '<span class="ns-gradient-glow">{username}</span>',
   '.ns-gradient-glow { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; color: transparent; filter: drop-shadow(0 0 6px var(--user-glow, rgba(255,170,80,0.6))); }',
   200, 1, 1, 3),

  ('gradient_shadow_glow',
   'Gradient with Shadow and Glow',
   'Two-color gradient with both a drop shadow and a colored glow.',
   '<span class="ns-gradient-sg">{username}</span>',
   '.ns-gradient-sg { background: linear-gradient(90deg, var(--user-color-1, currentColor), var(--user-color-2, currentColor)); -webkit-background-clip: text; background-clip: text; color: transparent; filter: drop-shadow(1px 1px 1px rgba(0,0,0,0.6)) drop-shadow(0 0 6px var(--user-glow, rgba(255,170,80,0.6))); }',
   275, 1, 1, 4),

  ('pulsing',
   'Pulsing',
   'Subtle opacity pulse so the name breathes.',
   '<span class="ns-pulse">{username}</span>',
   '.ns-pulse { color: var(--user-color-1, currentColor); animation: ns-pulse 2.4s ease-in-out infinite; } @keyframes ns-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }',
   175, 1, 1, 5),

  ('panning_gradient',
   'Panning Gradient',
   'Animated gradient that slowly slides across the name.',
   '<span class="ns-pan">{username}</span>',
   '.ns-pan { background: linear-gradient(90deg, var(--user-color-1, currentColor) 0%, var(--user-color-2, currentColor) 50%, var(--user-color-1, currentColor) 100%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: ns-pan 6s linear infinite; } @keyframes ns-pan { from { background-position: 0% 50%; } to { background-position: 200% 50%; } }',
   300, 1, 1, 6);
--> statement-breakpoint

-- cosmetics ------------------------------------------------------------
-- inline_avatar : round avatar shown in chat after the timestamp.
-- rank_border   : placeholder row for the border-purchase flow. Actual
--                 per-rank prices live on rank_tiers.border_cost (this
--                 row exists so the admin Cosmetics tab can surface the
--                 feature with one enabled toggle).
INSERT OR IGNORE INTO `cosmetics` (`key`, `name`, `description`, `cost`, `enabled`, `config_json`) VALUES
  ('inline_avatar',
   'Inline Avatar',
   'Show your round avatar in chat lines after the timestamp.',
   100, 1,
   '{"avatarPx":16,"position":"after-timestamp"}'),

  ('rank_border',
   'Rank Border',
   'Wrap your avatar with the unlockable border for any rank you have ever reached at Tier IV. Per-rank prices configured in the Ranks tab.',
   0, 1,
   NULL);
--> statement-breakpoint

-- standing_config_json on the site_settings singleton -----------------
-- Sets the default awards / caps / transfer-limits document. NULL was
-- a valid state too (engine falls back to DEFAULT_STANDING_CONFIG in
-- code) but seeding it here means the admin Awards tab loads a
-- concrete object instead of presenting blank fields.
--
-- The singleton row is normally created at runtime by
-- `ensureSiteSettings()`. To make this migration work on a fresh DB
-- where the server has not yet booted, we INSERT OR IGNORE the
-- singleton row first so the subsequent UPDATE has a target.
INSERT OR IGNORE INTO `site_settings` (`id`) VALUES ('singleton');
--> statement-breakpoint
UPDATE `site_settings`
SET `standing_config_json` = '{"enabled":true,"awards":{"message":{"say":{"xp":3,"currency":3},"action":{"xp":5,"currency":5},"whisper":{"xp":0,"currency":0}},"forum":{"topic":{"xp":25,"currency":25},"reply":{"xp":10,"currency":10}},"presence":{"perBlock":{"xp":1,"currency":1}}},"bodyFloorChars":5,"presenceBlockMinutes":5,"presenceDailyBlockCap":12,"enabledSources":{"message":{"xp":true,"currency":true},"forum":{"xp":true,"currency":true},"presence":{"xp":true,"currency":true}},"multiCharacterEarnDivisor":1.0,"currencyTransfer":{"enabled":true,"dailySendCap":500,"dailyReceiveCap":5000,"minSenderAccountAgeDays":14,"minRecipientAccountAgeDays":14,"minTransferAmount":1,"maxTransferAmount":1000},"backfill":{"xpPerHistoricalMessage":1.0,"completedAt":null}}'
WHERE `id` = 'singleton' AND `standing_config_json` IS NULL;
