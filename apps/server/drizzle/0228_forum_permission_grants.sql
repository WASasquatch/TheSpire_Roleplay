-- Forums Phase 0: seed the four new permission keys. 0179 (the original
-- grants seed) already ran and won't re-run; with a non-empty
-- role_permission_grants table the resolver default-denies ungranted
-- keys, so every new permission needs its own seed (0220 pattern).
-- Masteradmin bypasses the table entirely. INSERT OR IGNORE = re-run and
-- hand-granted rows are no-ops.
--
--   apply_create_forum        user/trusted/mod/admin (anyone may apply;
--                             admin-revocable per role)
--   review_forum_applications mod/admin (the "Admins/Mods depending on
--                             permissions" approval knob)
--   manage_any_forum          admin only (site override on any forum)
--   view_admin_forums         mod/admin (admin panel Forums tab)
INSERT OR IGNORE INTO role_permission_grants (role, permission_key) VALUES
  ('user', 'apply_create_forum'),
  ('trusted', 'apply_create_forum'),
  ('mod', 'apply_create_forum'),
  ('admin', 'apply_create_forum'),
  ('mod', 'review_forum_applications'),
  ('admin', 'review_forum_applications'),
  ('admin', 'manage_any_forum'),
  ('mod', 'view_admin_forums'),
  ('admin', 'view_admin_forums');
