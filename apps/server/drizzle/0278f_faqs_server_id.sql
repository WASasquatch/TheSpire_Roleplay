-- Servers Lift, Phase 1 (additive): scope discriminator on `faqs`. Canonical
-- DDL: plan.md §5.4. §9.3 split — ONE ADD COLUMN per file.
--
-- Per-community help content. NULL = platform FAQ. ON DELETE SET NULL so
-- deleting a server un-scopes its FAQs rather than destroying them.
ALTER TABLE `faqs` ADD COLUMN `server_id` text REFERENCES `servers`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `faqs_server_idx` ON `faqs` (`server_id`);
