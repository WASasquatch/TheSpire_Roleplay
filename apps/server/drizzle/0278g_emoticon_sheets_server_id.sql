-- Servers Lift, Phase 1 (additive): scope discriminator on `emoticon_sheets`.
-- Canonical DDL: plan.md §5.4. §9.3 split — ONE ADD COLUMN per file.
--
-- NOTE: the real table name is `emoticon_sheets` (verified in schema.ts; the
-- emoticons feature's sheet table), not `emoticons`.
--
-- Server flavor/content. NULL = platform-shared sheet. ON DELETE SET NULL so
-- deleting a server un-scopes its sheets rather than destroying them.
ALTER TABLE `emoticon_sheets` ADD COLUMN `server_id` text REFERENCES `servers`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `emoticon_sheets_server_idx` ON `emoticon_sheets` (`server_id`);
