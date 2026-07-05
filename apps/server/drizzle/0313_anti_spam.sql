-- Escalating chat anti-spam (see apps/server/src/realtime/antiSpam.ts).
--
-- 1) Admin master switch on site_settings, OFF by default so admins opt in
--    from the console.
-- 2) Seed the `bypass_anti_spam` permission for trusted users, mods, and
--    admins so the rapid-fire warn -> auto-mute ladder only ever polices
--    ordinary accounts (where raids and copy-paste floods come from).
--    Masteradmin bypasses every permission in code, so it needs no row.

ALTER TABLE site_settings ADD COLUMN anti_spam_enabled INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
INSERT OR IGNORE INTO role_permission_grants (role, permission_key) VALUES
  ('trusted', 'bypass_anti_spam'),
  ('mod', 'bypass_anti_spam'),
  ('admin', 'bypass_anti_spam');
