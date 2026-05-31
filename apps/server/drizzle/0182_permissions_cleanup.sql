-- Permission-system cleanup: catalog consolidations.
--
-- Two consolidations land here. Both are forward-only — existing
-- installs that already ran 0179 with the old keys need a cleanup
-- pass; fresh installs running an updated 0179 with the new keys
-- are no-ops for the affected rows.
--
-- (1) `view_audit_log` → consolidated into `view_admin_audit`.
--     The audit coverage audit caught a coherence mismatch: mod was
--     seeded `view_admin_audit` (the tab visibility) but not
--     `view_audit_log` (the route's actual gate), so mod saw the
--     Audit tab and got a 403 the moment the panel tried to fetch.
--     There's no operational reason to split tab visibility from
--     audit-read access — both fully gate "can see the audit feed."
--     Resolution: the route now gates on `view_admin_audit`; the
--     `view_audit_log` key is removed from the catalog and any
--     existing grants/overrides are dropped here.
--
-- (2) `edit_branding_design_map` → renamed to `edit_branding`.
--     The original key was too narrow (named after one of the
--     branding fields) AND wasn't wired into the settings PUT
--     handler. The handler now does per-field gating: a patch that
--     only touches branding fields (site name, logo, banner CSS,
--     welcome HTML, theme-design map, …) is accepted under
--     `edit_branding`; mixed patches still need `edit_site_settings`.
--     Existing rows holding the old key are renamed; user overrides
--     too.

-- ---------- (1) drop view_audit_log ----------
DELETE FROM `role_permission_grants`     WHERE `permission_key` = 'view_audit_log';
--> statement-breakpoint
DELETE FROM `user_permission_overrides` WHERE `permission_key` = 'view_audit_log';
--> statement-breakpoint

-- ---------- (2) rename edit_branding_design_map → edit_branding ----------
-- INSERT-then-DELETE pattern keeps the migration idempotent even if a
-- prior partial run already inserted the new-keyed row. The OR IGNORE
-- short-circuits on the (role, permission_key) primary-key conflict.
INSERT OR IGNORE INTO `role_permission_grants` (`role`, `permission_key`)
SELECT `role`, 'edit_branding'
  FROM `role_permission_grants`
 WHERE `permission_key` = 'edit_branding_design_map';
--> statement-breakpoint
DELETE FROM `role_permission_grants` WHERE `permission_key` = 'edit_branding_design_map';
--> statement-breakpoint

-- Same dance for user overrides. The override table's PK is
-- (user_id, permission_key) so the conflict shape is parallel.
INSERT OR IGNORE INTO `user_permission_overrides`
  (`user_id`, `granted`, `permission_key`, `set_by_user_id`, `set_at`)
SELECT `user_id`, `granted`, 'edit_branding', `set_by_user_id`, `set_at`
  FROM `user_permission_overrides`
 WHERE `permission_key` = 'edit_branding_design_map';
--> statement-breakpoint
DELETE FROM `user_permission_overrides` WHERE `permission_key` = 'edit_branding_design_map';
