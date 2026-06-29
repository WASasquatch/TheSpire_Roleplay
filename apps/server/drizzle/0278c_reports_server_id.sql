-- Servers Lift, Phase 1 (additive): scope discriminator on `reports`.
-- Canonical DDL: plan.md §5.4. §9.3 split — ONE ADD COLUMN per file.
--
-- §9.2: this is the SINGLE home for per-server message reports (there is no
-- server_reports table). Message/room reports route to the room's server; DM/
-- profile reports (no room_id) stay NULL = platform/site staff, since they have
-- no room/server context. ON DELETE SET NULL so deleting a server un-scopes the
-- reports rather than destroying them.
ALTER TABLE `reports` ADD COLUMN `server_id` text REFERENCES `servers`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `reports_server_idx` ON `reports` (`server_id`, `status`, `created_at`);
