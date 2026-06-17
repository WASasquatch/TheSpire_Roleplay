-- Moderation case log (migration 0254).
--
-- Mod-authored record of a complaint/dispute and how it was resolved — the
-- accountability trail distinct from the user-filed `reports` table. Reporter
-- and subject are freehand text, but when the mod uses an `@id:`/`@cid:`
-- identity token the route resolves it and also stores the linked
-- userId/characterId + a snapshot label, so cases stay queryable by person.
-- FKs use ON DELETE SET NULL so a case survives a deleted account/report.
--
-- Also seeds the two gating permissions to the `mod` and `admin` roles
-- (masteradmin bypasses): `view_admin_mod_cases` (tab + read) and
-- `manage_mod_cases` (create/edit/resolve).
CREATE TABLE `mod_cases` (
  `id` TEXT PRIMARY KEY,
  `nature` TEXT NOT NULL,
  `complaint_body` TEXT NOT NULL,
  `resolution` TEXT,
  `status` TEXT NOT NULL DEFAULT 'open',
  `reporter_text` TEXT,
  `reporter_user_id` TEXT REFERENCES `users`(`id`) ON DELETE SET NULL,
  `reporter_character_id` TEXT,
  `reporter_label` TEXT,
  `subject_text` TEXT,
  `subject_user_id` TEXT REFERENCES `users`(`id`) ON DELETE SET NULL,
  `subject_character_id` TEXT,
  `subject_label` TEXT,
  `related_report_id` TEXT REFERENCES `reports`(`id`) ON DELETE SET NULL,
  `created_by_user_id` TEXT REFERENCES `users`(`id`) ON DELETE SET NULL,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `resolved_at` INTEGER
);
--> statement-breakpoint
CREATE INDEX `mod_cases_subject_idx` ON `mod_cases` (`subject_user_id`);
--> statement-breakpoint
CREATE INDEX `mod_cases_reporter_idx` ON `mod_cases` (`reporter_user_id`);
--> statement-breakpoint
CREATE INDEX `mod_cases_status_idx` ON `mod_cases` (`status`, `created_at`);
--> statement-breakpoint
INSERT OR IGNORE INTO `role_permission_grants` (`role`, `permission_key`) VALUES
  ('mod', 'view_admin_mod_cases'),
  ('mod', 'manage_mod_cases'),
  ('admin', 'view_admin_mod_cases'),
  ('admin', 'manage_mod_cases');
