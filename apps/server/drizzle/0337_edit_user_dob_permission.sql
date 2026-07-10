-- 0337: Seed the `edit_user_dob` permission (age plan, Phase 4).
--
-- Date of birth is set once at signup and is NOT self-service editable
-- (decision #7 — prevents flip-flopping past the age gates). Corrections
-- go through `PATCH /admin/users/:id` behind this key, audited as
-- `user_dob_update`; an edit that turns an adult into a minor also
-- force-logs the user out so stale adult sessions rebuild with gates.
--
-- Seeded to the admin tier only, mirroring 0179's posture: admins already
-- hold the user-directory secure view (email + IPs) that surfaces the DOB
-- column, and the correction workflow (report -> verify -> fix) is an
-- admin task. Mods get nothing; masteradmin bypasses every permission in
-- code, so it needs no row.

INSERT OR IGNORE INTO role_permission_grants (role, permission_key) VALUES
  ('admin', 'edit_user_dob');
