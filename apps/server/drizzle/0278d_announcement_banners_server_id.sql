-- Servers Lift, Phase 1 (additive): scope discriminator on
-- `announcement_banners`. Canonical DDL: plan.md §5.4. §9.3 split — ONE ADD
-- COLUMN per file.
--
-- NULL = a platform-wide broadcast (master-admin); a server_id scopes the
-- banner to that server's rooms. ON DELETE SET NULL so deleting a server
-- un-scopes the banner rather than destroying it.
ALTER TABLE `announcement_banners` ADD COLUMN `server_id` text REFERENCES `servers`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `announcement_banners_server_idx`
  ON `announcement_banners` (`server_id`, `enabled`, `sort_order`);
