-- Granular permission system, follow-up grant for `manage_affiliates`.
--
-- The catalog gained the `manage_affiliates` key after migration 0179
-- had already landed in some working trees. Editing 0179 to add the
-- seed row would have silently no-op'd on any instance that already
-- applied it (Drizzle migrations are forward-only and never re-run).
-- This migration carries the row on its own so every install picks
-- it up regardless of when they first ran 0179.
--
-- Idempotent on conflict, if an install ALSO ran an edited 0179
-- that already inserted this row, the INSERT here just skips it.

INSERT INTO `role_permission_grants` (`role`, `permission_key`)
VALUES ('admin', 'manage_affiliates')
ON CONFLICT (`role`, `permission_key`) DO NOTHING;
