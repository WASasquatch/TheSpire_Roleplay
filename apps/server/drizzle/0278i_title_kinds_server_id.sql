-- Servers Lift, Phase 1 (additive): scope discriminator on `title_kinds`.
-- Canonical DDL: plan.md §5.4. §9.3 split — ONE ADD COLUMN per file (the last,
-- 0278i).
--
-- Mutual-title catalog, server flavor. NULL = platform-shared title kind. ON
-- DELETE SET NULL so deleting a server un-scopes its title kinds rather than
-- destroying them.
ALTER TABLE `title_kinds` ADD COLUMN `server_id` text REFERENCES `servers`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `title_kinds_server_idx` ON `title_kinds` (`server_id`);
