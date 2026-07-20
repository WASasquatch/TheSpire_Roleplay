-- Per-server "welcome on first join" in-chat message.
--
-- Replaces the first-words NOTIFICATION (which pinged everyone the first time a
-- newcomer spoke) with a single in-chat SYSTEM line the first time a person
-- appears in a server: the main Spire on registration, a community server when
-- they join. Posted once per (user, server).
--
--   join_welcome_enabled  NULL = ON (the default); 0 turns it off per server.
--   join_welcome_template NULL = the built-in copy; supports {user} + {server}.
--   server_welcomes       the once-ever claim per (server, user).
ALTER TABLE server_settings ADD COLUMN join_welcome_enabled integer;
--> statement-breakpoint
ALTER TABLE server_settings ADD COLUMN join_welcome_template text;
--> statement-breakpoint
CREATE TABLE `server_welcomes` (
	`server_id` text NOT NULL,
	`user_id` text NOT NULL,
	`welcomed_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `user_id`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- BACKFILL — mark every EXISTING (server, user) pair as already welcomed, so
-- shipping this (feature ON by default, hook fires for everyone) does NOT
-- falsely announce the entire current population as first-time joiners on their
-- next connect. Mirrors how the replaced welcome-wagon backfilled first_spoke_at
-- to created_at. On a fresh install these selects return nothing.
--   1. Community-server members.
INSERT OR IGNORE INTO server_welcomes (server_id, user_id, welcomed_at)
  SELECT server_id, user_id, unixepoch() * 1000 FROM server_members;
--> statement-breakpoint
--   2. Anyone who's been placed in a room in a community server (open-server
--      visitors who aren't members but have already appeared there).
INSERT OR IGNORE INTO server_welcomes (server_id, user_id, welcomed_at)
  SELECT server_id, user_id, unixepoch() * 1000 FROM user_server_last_room;
--> statement-breakpoint
--   3. The default/home server: its rooms carry a NULL server_id, so its people
--      appear in neither table above; every existing human is present there.
INSERT OR IGNORE INTO server_welcomes (server_id, user_id, welcomed_at)
  SELECT 'server_spire_system', id, unixepoch() * 1000 FROM users
  WHERE username != 'system' AND EXISTS (SELECT 1 FROM servers WHERE id = 'server_spire_system');
