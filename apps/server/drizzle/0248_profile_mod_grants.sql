-- Grant the new profile-moderation permissions to mod + admin. These are
-- in-context moderation actions taken while viewing a profile. masteradmin
-- bypasses all permission checks in code, so it needs no rows here.
--
-- `edit_others_character` already existed (admin-only). The profile-modal
-- moderation tools gate CHARACTER bio edits + gallery NSFW flagging on it,
-- so mods get it too here, otherwise they could moderate master/OOC
-- profiles but not characters (which carry most galleries). admin already
-- holds it from 0179; INSERT OR IGNORE makes the duplicate a no-op.
INSERT OR IGNORE INTO `role_permission_grants` (`role`, `permission_key`) VALUES
  ('mod', 'edit_others_character'),
  ('mod', 'edit_others_user'),
  ('mod', 'ban_account'),
  ('mod', 'unban_account'),
  ('admin', 'edit_others_user'),
  ('admin', 'ban_account'),
  ('admin', 'unban_account');
