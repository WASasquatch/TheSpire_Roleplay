-- Servers Lift, Phase 1 (additive): THE KEYSTONE BACKFILL. Canonical SQL:
-- plan.md §5.5 (with the §6.5 / §9.2 / §9.4 / §9.7 corrections folded in).
--
-- This is the one data rewrite of the lift — the analogue of
-- 0229_seed_spire_forums.sql. apply-migrations.mjs wraps this WHOLE file in ONE
-- better-sqlite3 transaction (the per-statement separators only split the
-- exec() calls WITHIN that single transaction; they do NOT break atomicity), so
-- every step below commits together or rolls back together.
--
-- WHAT IT DOES (all idempotent — INSERT OR IGNORE + `WHERE ... IS NULL` guards,
-- so a re-run is a no-op and a partial-then-rerun heals):
--   1. Create the fixed-id default server `server_spire_system` (is_system=1,
--      is_default=1). Owner = the OLDEST REAL admin, EXCLUDING the login-less
--      'system' sentinel (§9.4). Branding copied from the site_settings
--      singleton so the rail icon + chat shell look byte-identical to today.
--   2. Seed its server_settings row from the singleton (NULL = inherit; we copy
--      the concrete values so per-server behavior is byte-identical to legacy).
--   3. Adopt EVERY existing room AND forum into the default server.
--   4. Point default_room_id at the canonical landing (is_default → The_Spire →
--      is_system → oldest), matching findCanonicalLanding's precedence.
--   5. Re-home the global moderation/content discriminator rows. audit_log and
--      reports route by their room's server (else stay NULL = platform per §9.8);
--      §9.2: there is NO server_reports table — message reports live on
--      reports.server_id; DM/profile reports (no room) stay NULL = platform.
--      mod_cases / announcement_banners / scheduled_announcements / faqs /
--      emoticon_sheets / custom_commands / title_kinds → the default server.
--   6. Insert the owner's explicit server_members row (role 'owner'). Everyone
--      else is an IMPLICIT member of the is_system server (serverAuthority
--      short-circuits on isSystem); the per-account roster rows land in 0281.
--   7. Seed the implicit default usergroup `sug_spire_default` (is_default=1)
--      with the SERVER_FEATURE_PERMISSIONS baseline so ungrouped members keep
--      every member-feature.
--
-- FRESH-INSTALL TOLERANCE (§9.4): if NO real admin exists yet (migrations ran
-- before first registration), step 1's INSERT…SELECT inserts ZERO rows. Every
-- dependent step is then a no-op (the UPDATEs hit nothing because no room has
-- server_id set to a non-existent server; the member/usergroup inserts SELECT
-- FROM `servers WHERE id='server_spire_system'` which is empty, or are guarded
-- by EXISTS). The boot-time ensureSystemServer (Seed stage) provisions the
-- server once an admin appears, exactly as ensureSystemForum covers 0229.

-- 1. Create the fixed-id default server. Owner = oldest REAL admin (§9.4:
--    masteradmin-first, then created_at; EXCLUDING the 'system' sentinel by both
--    username and id). Branding re-homed from the singleton (zero visible
--    change). slug/status mirror plan.md §5.5 ('spire-server' / 'featured').
INSERT OR IGNORE INTO `servers` (
  `id`, `slug`, `name`, `is_system`, `is_default`, `status`, `visibility`,
  `join_mode`, `owner_user_id`, `logo_url`, `theme_json`, `public_browsing`,
  `room_order_json`, `created_at`, `updated_at`)
SELECT
  'server_spire_system',
  'spire-server',
  COALESCE((SELECT `site_name` FROM `site_settings` WHERE `id` = 'singleton'), 'The Spire'),
  1, 1, 'featured', 'public', 'open',
  u.`id`,
  (SELECT `logo_url` FROM `site_settings` WHERE `id` = 'singleton'),
  (SELECT `default_theme_json` FROM `site_settings` WHERE `id` = 'singleton'),
  0, '[]',
  (unixepoch() * 1000), (unixepoch() * 1000)
FROM `users` u
WHERE u.`role` IN ('masteradmin', 'admin')
  AND u.`username` != 'system'
  AND u.`id` != 'system'
ORDER BY CASE u.`role` WHEN 'masteradmin' THEN 0 ELSE 1 END, u.`created_at`
LIMIT 1;
--> statement-breakpoint

-- 2. Seed per-server settings from the singleton (byte-identical behavior). The
--    EXISTS guard makes this a no-op on a fresh install where step 1 inserted no
--    server (the server_settings FK would otherwise fail). earning_config_json /
--    flash_sale_enabled are deliberately left NULL = inherit the platform/shared
--    config (plan.md §5.5; the per-server economy lands in 0282+).
INSERT OR IGNORE INTO `server_settings` (
  `server_id`, `message_retention_ms`, `max_message_length`, `edit_grace_ms`,
  `default_theme_json`, `default_style_key`, `theme_design_map`,
  `rules_html`, `security_notice_html`, `welcome_html`, `new_user_welcome_html`,
  `max_forum_post_length`, `forum_topics_per_page`, `max_rooms_per_owner`,
  `created_at`, `updated_at`)
SELECT
  'server_spire_system',
  `message_retention_ms`, `max_message_length`, `edit_grace_ms`,
  `default_theme_json`, `default_style_key`, `theme_design_map`,
  `rules_html`, `security_notice_html`, `welcome_html`, `new_user_welcome_html`,
  `max_forum_post_length`, `forum_topics_per_page`, `max_rooms_per_owner`,
  (unixepoch() * 1000), (unixepoch() * 1000)
FROM `site_settings`
WHERE `id` = 'singleton'
  AND EXISTS (SELECT 1 FROM `servers` WHERE `id` = 'server_spire_system');
--> statement-breakpoint

-- 3. Adopt EVERY existing room (standalone AND forum boards) into the default
--    server. Guarded on EXISTS so a fresh install (no server row) leaves rooms
--    server_id NULL — serverAuthority adopts NULL → the is_system server, and
--    ensureSystemServer will point things once it provisions the server.
UPDATE `rooms` SET `server_id` = 'server_spire_system'
WHERE `server_id` IS NULL
  AND EXISTS (SELECT 1 FROM `servers` WHERE `id` = 'server_spire_system');
--> statement-breakpoint
UPDATE `forums` SET `server_id` = 'server_spire_system'
WHERE `server_id` IS NULL
  AND EXISTS (SELECT 1 FROM `servers` WHERE `id` = 'server_spire_system');
--> statement-breakpoint

-- 4. Point the server's landing at the canonical room, matching the precedence
--    findCanonicalLanding uses: is_default → name='The_Spire' → is_system →
--    oldest. Only overwrites when still NULL so a re-run can't move an
--    admin-chosen landing. No-op when no adopted room exists.
UPDATE `servers` SET `default_room_id` = (
  SELECT r.`id` FROM `rooms` r
  WHERE r.`server_id` = 'server_spire_system' AND r.`archived_at` IS NULL
  ORDER BY CASE
    WHEN r.`is_default` = 1 THEN 0
    WHEN r.`name` = 'The_Spire' THEN 1
    WHEN r.`is_system` = 1 THEN 2
    ELSE 3 END, r.`created_at`
  LIMIT 1)
WHERE `id` = 'server_spire_system' AND `default_room_id` IS NULL;
--> statement-breakpoint

-- 5. Re-home the global moderation/content rows. §9.8: audit_log + reports route
--    BY THEIR ROOM's server (rows with no room stay NULL = platform). §9.2:
--    reports is the single home for message reports — DM/profile reports (no
--    room_id) stay NULL = platform/site staff. The other discriminator tables
--    have no room linkage, so they re-home to the default server wholesale.
UPDATE `audit_log` SET `server_id` = (
  SELECT `server_id` FROM `rooms` WHERE `rooms`.`id` = `audit_log`.`target_room_id`)
WHERE `server_id` IS NULL AND `target_room_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `reports` SET `server_id` = (
  SELECT `server_id` FROM `rooms` WHERE `rooms`.`id` = `reports`.`room_id`)
WHERE `server_id` IS NULL AND `room_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `mod_cases` SET `server_id` = 'server_spire_system'
WHERE `server_id` IS NULL
  AND EXISTS (SELECT 1 FROM `servers` WHERE `id` = 'server_spire_system');
--> statement-breakpoint
UPDATE `announcement_banners` SET `server_id` = 'server_spire_system'
WHERE `server_id` IS NULL
  AND EXISTS (SELECT 1 FROM `servers` WHERE `id` = 'server_spire_system');
--> statement-breakpoint
UPDATE `scheduled_announcements` SET `server_id` = 'server_spire_system'
WHERE `server_id` IS NULL
  AND EXISTS (SELECT 1 FROM `servers` WHERE `id` = 'server_spire_system');
--> statement-breakpoint
UPDATE `faqs` SET `server_id` = 'server_spire_system'
WHERE `server_id` IS NULL
  AND EXISTS (SELECT 1 FROM `servers` WHERE `id` = 'server_spire_system');
--> statement-breakpoint
UPDATE `emoticon_sheets` SET `server_id` = 'server_spire_system'
WHERE `server_id` IS NULL
  AND EXISTS (SELECT 1 FROM `servers` WHERE `id` = 'server_spire_system');
--> statement-breakpoint
UPDATE `custom_commands` SET `server_id` = 'server_spire_system'
WHERE `server_id` IS NULL
  AND EXISTS (SELECT 1 FROM `servers` WHERE `id` = 'server_spire_system');
--> statement-breakpoint
UPDATE `title_kinds` SET `server_id` = 'server_spire_system'
WHERE `server_id` IS NULL
  AND EXISTS (SELECT 1 FROM `servers` WHERE `id` = 'server_spire_system');
--> statement-breakpoint

-- 6. The owner's explicit server_members row (role 'owner'). Everyone else is an
--    IMPLICIT member of the is_system server (serverAuthority short-circuits on
--    isSystem); 0281 writes the per-account roster rows for enumeration (§9.7).
--    Selecting FROM servers means a fresh install (no server row) inserts
--    nothing; INSERT OR IGNORE makes a re-run a no-op.
INSERT OR IGNORE INTO `server_members` (
  `server_id`, `user_id`, `role`, `permissions_json`, `joined_at`)
SELECT 'server_spire_system', `owner_user_id`, 'owner', '[]', (unixepoch() * 1000)
FROM `servers` WHERE `id` = 'server_spire_system';
--> statement-breakpoint

-- 7. Seed the implicit default usergroup with the SERVER_FEATURE_PERMISSIONS
--    baseline (post_messages, create_rooms, upload_images, use_emoticons,
--    send_invites — packages/shared/src/server.ts). Ungrouped members get this
--    set, so editing it later narrows what everyone may do. Guarded on EXISTS so
--    a fresh install (no server row) inserts nothing; INSERT OR IGNORE +
--    server_usergroups_one_default make a re-run a no-op.
INSERT OR IGNORE INTO `server_usergroups` (
  `id`, `server_id`, `name`, `permissions_json`, `is_default`, `sort_order`,
  `auto_rules_json`, `created_at`)
SELECT
  'sug_spire_default', 'server_spire_system', 'Members',
  '["post_messages","create_rooms","upload_images","use_emoticons","send_invites"]',
  1, 0, '[]', (unixepoch() * 1000)
WHERE EXISTS (SELECT 1 FROM `servers` WHERE `id` = 'server_spire_system');
