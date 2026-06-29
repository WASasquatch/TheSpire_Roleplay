-- Servers Lift, Phase 1 (additive): scope discriminator on `mod_cases`.
-- Canonical DDL: plan.md §5.4. §9.3 split — ONE ADD COLUMN per file.
--
-- NULL = app-global / platform-owned. mod_case_updates / mod_case_evidence
-- inherit scope through case_id (FK) — no column needed, the case carries the
-- server_id. ON DELETE SET NULL so deleting a server un-scopes (never destroys)
-- case history.
ALTER TABLE `mod_cases` ADD COLUMN `server_id` text REFERENCES `servers`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `mod_cases_server_idx` ON `mod_cases` (`server_id`, `status`, `created_at`);
