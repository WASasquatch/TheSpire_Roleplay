-- Grant the Spire Arcade permission keys (added to the shared catalog in
-- this revision) to every role by default. The Arcade is a fun, opt-in,
-- PURCHASE-gated feature, so permissions are the admin kill-switch rather
-- than the real gate: a player still has to buy each game's unlock to
-- play it. Admins can revoke `use_arcade` (hides the whole section) or
-- `use_eidolon_tamer` (disables just that game) per-role or per-user via
-- the Roles & Permissions matrix. Masteradmins have everything via the
-- hardcoded bypass. Mirrors the use_theater_mode grant in 0198.
INSERT INTO `role_permission_grants` (`role`, `permission_key`)
VALUES
  ('user',    'use_arcade'),
  ('trusted', 'use_arcade'),
  ('mod',     'use_arcade'),
  ('admin',   'use_arcade'),
  ('user',    'use_eidolon_tamer'),
  ('trusted', 'use_eidolon_tamer'),
  ('mod',     'use_eidolon_tamer'),
  ('admin',   'use_eidolon_tamer')
ON CONFLICT (`role`, `permission_key`) DO NOTHING;
