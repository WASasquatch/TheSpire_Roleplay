-- Servers Lift, Phase 1 (additive): scope discriminator on `audit_log`.
-- Canonical DDL: plan.md §5.4. §9.3 split — ONE ADD COLUMN per file so a partial
-- re-apply baselines only this table, not 14 others.
--
-- POSTURE: NULL = app-global / platform-owned. First-class scope column
-- (recommended over the forum json_extract hack) so the global /admin/audit can
-- exclude server rows and per-server Mod Logs are an indexed read.
-- auditServerAction() stamps this; the per-server Mod Log is
-- `SELECT ... WHERE server_id = ?`. ON DELETE SET NULL so deleting a server
-- never destroys audit history — it just un-scopes the rows.
ALTER TABLE `audit_log` ADD COLUMN `server_id` text REFERENCES `servers`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `audit_log_server_idx` ON `audit_log` (`server_id`, `created_at`);
