-- Servers Lift, Phase 5.7 (per-server economy) — the earning POOLS.
--
-- user_earning and character_earning hold one balance row per identity today
-- (PK = user_id / character_id). Per-server economy means a person's XP /
-- Currency / Rank / equipped cosmetics are SEPARATE in each server they play
-- in, so the grain becomes (server_id, identity_id). SQLite can't widen a PK
-- in place, so each table gets the house rebuild idiom (see
-- 0187_per_identity_memberships.sql): CREATE __new with the wider PK,
-- INSERT...SELECT stamping server_id = the default server, DROP old, RENAME,
-- recreate indexes — all in this one transaction.
--
-- Every existing balance/rank/equip row homes to 'server_spire_system' (the
-- Phase-2 backfill target + the only server until the flag is on), so no
-- balance, rank progress, or equipped cosmetic moves. The equip/flair columns
-- (selected_border_rank_key, typing_phrase, room/session presence templates,
-- marquee, etc.) ride along in the straight copy and thereby become per-server
-- "for free" — a person can equip a different border per server later.
--
-- FK-SAFE: no table has an inbound FK to these pools, so DROP+recreate inside
-- the single transaction has no cascade targets and leaves no dangling refs
-- (verified: grep of REFERENCES user_earning / character_earning is empty).

-- ============================================================
-- user_earning -> PK (server_id, user_id)
-- ============================================================
CREATE TABLE `user_earning_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `xp` integer NOT NULL DEFAULT 0,
  `currency` integer NOT NULL DEFAULT 0,
  `rank_key` text,
  `tier` integer,
  `max_rank_key_ever_held` text,
  `max_tier_ever_held` integer,
  `hide_currency_count` integer NOT NULL DEFAULT 0,
  `hide_xp_count` integer NOT NULL DEFAULT 0,
  `selected_border_rank_key` text,
  `selected_freeform_border_key` text,
  `typing_phrase` text,
  `room_join_template` text,
  `room_leave_template` text,
  `session_connect_template` text,
  `session_exit_template` text,
  `profile_marquee_quotes_json` text,
  `show_profile_visitors_count` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `user_id`)
);
--> statement-breakpoint
INSERT INTO `user_earning_new` (
  `server_id`, `user_id`, `xp`, `currency`, `rank_key`, `tier`,
  `max_rank_key_ever_held`, `max_tier_ever_held`, `hide_currency_count`,
  `hide_xp_count`, `selected_border_rank_key`, `selected_freeform_border_key`,
  `typing_phrase`, `room_join_template`, `room_leave_template`,
  `session_connect_template`, `session_exit_template`,
  `profile_marquee_quotes_json`, `show_profile_visitors_count`,
  `created_at`, `updated_at`
)
SELECT
  'server_spire_system', `user_id`, `xp`, `currency`, `rank_key`, `tier`,
  `max_rank_key_ever_held`, `max_tier_ever_held`, `hide_currency_count`,
  `hide_xp_count`, `selected_border_rank_key`, `selected_freeform_border_key`,
  `typing_phrase`, `room_join_template`, `room_leave_template`,
  `session_connect_template`, `session_exit_template`,
  `profile_marquee_quotes_json`, `show_profile_visitors_count`,
  `created_at`, `updated_at`
FROM `user_earning`;
--> statement-breakpoint
DROP TABLE `user_earning`;
--> statement-breakpoint
ALTER TABLE `user_earning_new` RENAME TO `user_earning`;
--> statement-breakpoint

-- ============================================================
-- character_earning -> PK (server_id, character_id)
-- ============================================================
CREATE TABLE `character_earning_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `character_id` text NOT NULL REFERENCES `characters`(`id`) ON DELETE CASCADE,
  `xp` integer NOT NULL DEFAULT 0,
  `currency` integer NOT NULL DEFAULT 0,
  `rank_key` text,
  `tier` integer,
  `max_rank_key_ever_held` text,
  `max_tier_ever_held` integer,
  `selected_border_rank_key` text,
  `selected_freeform_border_key` text,
  `active_name_style_key` text,
  `active_room_transition_key` text,
  `inline_avatar_enabled` integer NOT NULL DEFAULT 0,
  `lurking_master_enabled` integer NOT NULL DEFAULT 0,
  `profile_banner_url` text,
  `typing_phrase` text,
  `room_join_template` text,
  `room_leave_template` text,
  `profile_marquee_quotes_json` text,
  `show_profile_visitors_count` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `character_id`)
);
--> statement-breakpoint
INSERT INTO `character_earning_new` (
  `server_id`, `character_id`, `xp`, `currency`, `rank_key`, `tier`,
  `max_rank_key_ever_held`, `max_tier_ever_held`, `selected_border_rank_key`,
  `selected_freeform_border_key`, `active_name_style_key`,
  `active_room_transition_key`, `inline_avatar_enabled`,
  `lurking_master_enabled`, `profile_banner_url`, `typing_phrase`,
  `room_join_template`, `room_leave_template`, `profile_marquee_quotes_json`,
  `show_profile_visitors_count`, `created_at`, `updated_at`
)
SELECT
  'server_spire_system', `character_id`, `xp`, `currency`, `rank_key`, `tier`,
  `max_rank_key_ever_held`, `max_tier_ever_held`, `selected_border_rank_key`,
  `selected_freeform_border_key`, `active_name_style_key`,
  `active_room_transition_key`, `inline_avatar_enabled`,
  `lurking_master_enabled`, `profile_banner_url`, `typing_phrase`,
  `room_join_template`, `room_leave_template`, `profile_marquee_quotes_json`,
  `show_profile_visitors_count`, `created_at`, `updated_at`
FROM `character_earning`;
--> statement-breakpoint
DROP TABLE `character_earning`;
--> statement-breakpoint
ALTER TABLE `character_earning_new` RENAME TO `character_earning`;
