-- Granular permission system — Phase 1.
--
-- Replaces the hardcoded `isAdminRole(role)` / `isMasterAdminRole(role)` checks
-- scattered across the codebase with two tables that an install can edit at
-- runtime via the (Phase-2) Roles & Permissions matrix:
--
--   * role_permission_grants     — (role, permission_key) rows. Which
--                                  permissions each role tier holds by
--                                  default. The matrix's "By role"
--                                  sub-tab edits this table.
--
--   * user_permission_overrides  — per-user grants/revokes that layer
--                                  ON TOP of the role grants. Lets the
--                                  install give a specific user a single
--                                  extra power (or take one away) without
--                                  minting a new role tier. Starts empty;
--                                  the matrix's "By user" sub-tab fills it
--                                  in response to admin clicks.
--
-- The masteradmin tier is NOT represented here — its bypass is hardcoded in
-- `apps/server/src/auth/permissions.ts:hasPermission`. Adding a row for it
-- would be redundant and would also make it possible (via a misclick) to
-- accidentally LOSE permissions from the tier that's supposed to be the
-- root of trust.
--
-- Permission resolution precedence (highest wins):
--   1. masteradmin → always true (hardcoded)
--   2. user_permission_overrides[userId][key].granted → explicit grant/revoke
--   3. role_permission_grants[role][key]              → role-level grant
--   4. default → false (deny)
--
-- A *defensive fallback* lives in the permission helper: if
-- role_permission_grants is empty (failed seed, manual DELETE), the helper
-- falls back to the legacy `isAdminRole(role)` / `isMasterAdminRole(role)`
-- checks so an empty table can't lock every admin out of the matrix UI.

CREATE TABLE `role_permission_grants` (
  `role` TEXT NOT NULL,
  `permission_key` TEXT NOT NULL,
  PRIMARY KEY (`role`, `permission_key`)
);
--> statement-breakpoint
CREATE INDEX `role_permission_grants_role_idx` ON `role_permission_grants` (`role`);
--> statement-breakpoint

CREATE TABLE `user_permission_overrides` (
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  -- 1 = explicit grant (give a non-admin a single privilege),
  -- 0 = explicit revoke (take a privilege away from someone who'd otherwise have it).
  -- Cleared entries delete the row; absence = "fall back to role grant."
  `granted` INTEGER NOT NULL,
  `permission_key` TEXT NOT NULL,
  `set_by_user_id` TEXT NOT NULL REFERENCES `users`(`id`),
  `set_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`user_id`, `permission_key`)
);
--> statement-breakpoint
CREATE INDEX `user_permission_overrides_user_idx` ON `user_permission_overrides` (`user_id`);
--> statement-breakpoint

-- Seeded defaults — mirror the legacy `isAdminRole` / `isMasterAdminRole`
-- behavior so deploying this migration changes nothing about who can do
-- what until an admin actively edits the matrix. See plan.md for the full
-- catalog + rationale.
--
-- `trusted` gets nothing here — it's a recognition badge today, not a
-- pre-tier of moderation.
--
-- `mod` gets the moderation actions every install grants today.
--
-- `admin` gets every key EXCEPT the masteradmin-only set:
--   reset_user_password, hard_delete_user, edit_user_email,
--   disable_user, enable_user, view_admin_backups, manage_backups,
--   view_admin_settings, edit_site_settings, view_admin_branding,
--   view_admin_rules, upload_logo, edit_earning_sensitive,
--   manage_permissions.
-- (`view_admin_permissions` IS admin-default so admins can read the matrix
-- without editing it; editing is gated on `manage_permissions`.)
--
-- masteradmin → no row needed; bypass is hardcoded.

INSERT INTO `role_permission_grants` (`role`, `permission_key`) VALUES
  -- mod tier (moderation surface)
  ('mod', 'kick_user'),
  ('mod', 'ban_user'),
  ('mod', 'unban_user'),
  ('mod', 'mute_user'),
  ('mod', 'unmute_user'),
  ('mod', 'delete_others_message'),
  ('mod', 'edit_others_message'),
  ('mod', 'view_deleted_message_body'),
  ('mod', 'lock_forum_topic'),
  ('mod', 'unlock_forum_topic'),
  ('mod', 'bypass_topic_lock'),
  ('mod', 'announce_room'),
  ('mod', 'edit_any_room_metadata'),
  ('mod', 'view_report_queue'),
  ('mod', 'resolve_reports'),
  ('mod', 'view_admin_overview'),
  ('mod', 'view_admin_audit'),
  ('mod', 'view_admin_reports'),

  -- admin tier — every key except the masteradmin-only set
  ('admin', 'kick_user'),
  ('admin', 'ban_user'),
  ('admin', 'unban_user'),
  ('admin', 'mute_user'),
  ('admin', 'unmute_user'),
  ('admin', 'delete_others_message'),
  ('admin', 'edit_others_message'),
  ('admin', 'view_deleted_message_body'),
  ('admin', 'lock_forum_topic'),
  ('admin', 'unlock_forum_topic'),
  ('admin', 'bypass_topic_lock'),
  ('admin', 'pin_forum_topic'),
  ('admin', 'announce_room'),
  ('admin', 'announce_sitewide'),
  ('admin', 'bypass_room_cap'),
  ('admin', 'edit_any_room_metadata'),
  ('admin', 'create_system_room'),
  ('admin', 'bulk_edit_rooms'),
  ('admin', 'delete_room'),
  ('admin', 'grant_admin_role'),
  ('admin', 'revoke_admin_role'),
  ('admin', 'view_user_directory_secure'),
  ('admin', 'edit_user_basic'),
  ('admin', 'edit_others_character'),
  ('admin', 'view_others_journal'),
  ('admin', 'edit_others_journal'),
  ('admin', 'manage_emoticon_catalog'),
  ('admin', 'review_emoticon_submissions'),
  ('admin', 'feature_worlds'),
  ('admin', 'edit_others_world'),
  ('admin', 'delete_others_world'),
  ('admin', 'admin_delete_story'),
  ('admin', 'admin_hide_story'),
  ('admin', 'admin_force_story_rating'),
  ('admin', 'edit_others_scriptorium_content'),
  ('admin', 'view_others_scriptorium_drafts'),
  ('admin', 'view_room_messages_as_admin'),
  ('admin', 'view_report_queue'),
  ('admin', 'resolve_reports'),
  ('admin', 'view_earning_config'),
  ('admin', 'edit_earning_awards'),
  ('admin', 'grant_earning_award'),
  ('admin', 'manage_ranks'),
  ('admin', 'manage_name_styles'),
  ('admin', 'manage_borders'),
  ('admin', 'manage_cosmetics'),
  ('admin', 'clear_user_cosmetic_override'),
  ('admin', 'manage_flash_sale'),
  ('admin', 'manage_custom_commands'),
  ('admin', 'manage_title_kinds'),
  ('admin', 'manage_nav_links'),
  ('admin', 'edit_branding'),
  ('admin', 'view_admin_overview'),
  ('admin', 'view_admin_users'),
  ('admin', 'view_admin_rooms'),
  ('admin', 'view_admin_audit'),
  ('admin', 'view_admin_reports'),
  ('admin', 'view_admin_earning'),
  ('admin', 'view_admin_emoticons'),
  ('admin', 'view_admin_affiliates'),
  ('admin', 'view_admin_scriptorium'),
  ('admin', 'view_admin_custom_commands'),
  ('admin', 'view_admin_title_kinds'),
  ('admin', 'view_admin_nav_links'),
  ('admin', 'view_admin_permissions');
