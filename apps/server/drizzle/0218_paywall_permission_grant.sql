-- Seed the "Buy to Read" bypass permission for the moderating roles.
-- 0179 (the original grants seed) is already applied and the migration runner
-- won't re-run it; with a non-empty role_permission_grants table the resolver
-- default-denies any key that has no grant row, so a new permission needs its
-- own seed here. Mirrors the ('admin', …) / ('mod', …) tuples in 0179.
-- INSERT OR IGNORE so a re-run (or a hand-granted row) is a no-op.
INSERT OR IGNORE INTO role_permission_grants (role, permission_key) VALUES
  ('admin', 'bypass_scriptorium_paywall'),
  ('mod', 'bypass_scriptorium_paywall');
