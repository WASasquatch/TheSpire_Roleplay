-- Servers Lift, Phase 1 (additive): scope discriminator on `custom_commands`.
-- Canonical DDL: plan.md §5.4. §9.3 split — ONE ADD COLUMN per file.
--
-- Server flavor. NULL = platform-shared command. ON DELETE SET NULL so deleting
-- a server un-scopes its commands rather than destroying them.
ALTER TABLE `custom_commands` ADD COLUMN `server_id` text REFERENCES `servers`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `custom_commands_server_idx` ON `custom_commands` (`server_id`);
