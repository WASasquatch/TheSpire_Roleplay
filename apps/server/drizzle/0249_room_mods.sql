-- Per-IDENTITY room-moderator attribution for the userlist crown.
-- Moderation AUTHORITY stays per-account on room_members.role (unchanged);
-- this table records WHICH identity each /promote targeted so the mod
-- crown shows on that identity alone, not on every character the account
-- voices. character_id '' = the OOC/master identity. Room OWNER is not
-- stored here (derived from rooms.owner_id, shown on the owner's OOC row).
CREATE TABLE `room_mods` (
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`character_id` text DEFAULT '' NOT NULL,
	`granted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`room_id`, `user_id`, `character_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `room_mods_room_idx` ON `room_mods` (`room_id`);
--> statement-breakpoint
-- Backfill: existing per-account mods keep their crown, attributed to OOC
-- (character_id ''). Owners are excluded (their crown comes from
-- rooms.owner_id).
INSERT OR IGNORE INTO `room_mods` (`room_id`, `user_id`, `character_id`, `granted_at`)
SELECT `room_id`, `user_id`, '', (unixepoch() * 1000)
FROM `room_members`
WHERE `role` = 'mod';
