-- Servers Lift, Phase 1 (additive): seed the four new SERVER permission keys
-- into role_permission_grants. Exact mirror of 0228_forum_permission_grants.sql
-- (the forum quartet) — same posture, same role tiers.
--
-- 0179 (the original grants seed) already ran and won't re-run; with a non-empty
-- role_permission_grants table the resolver default-denies ungranted keys, so
-- every new permission needs its own seed (the 0220 / 0228 pattern). Masteradmin
-- bypasses the table entirely. INSERT OR IGNORE = re-run and hand-granted rows
-- are no-ops.
--
-- Tiers mirror the forum quartet one-for-one (apply_create_forum →
-- apply_create_server, review_forum_applications → review_server_applications,
-- manage_any_forum → manage_any_server, view_admin_forums → view_admin_servers):
--   apply_create_server         user/trusted/mod/admin (anyone may apply to
--                               register their own server; admin-revocable)
--   review_server_applications  mod/admin (the server-creation approval knob,
--                               reviewed by SITE staff, not server owners)
--   manage_any_server           admin only (site override — owner-equivalent on
--                               any server; serverAuthority folds this in)
--   view_admin_servers          mod/admin (admin panel Servers tab)
INSERT OR IGNORE INTO `role_permission_grants` (`role`, `permission_key`) VALUES
  ('user', 'apply_create_server'),
  ('trusted', 'apply_create_server'),
  ('mod', 'apply_create_server'),
  ('admin', 'apply_create_server'),
  ('mod', 'review_server_applications'),
  ('admin', 'review_server_applications'),
  ('admin', 'manage_any_server'),
  ('mod', 'view_admin_servers'),
  ('admin', 'view_admin_servers');
