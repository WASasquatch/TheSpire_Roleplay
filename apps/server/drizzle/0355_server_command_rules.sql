-- Per-server command availability (the room_role_gates idiom, lifted to
-- commands). One rule row per (server, command):
--   mode = 'disabled' — the command is refused for everyone in that server's
--                       rooms (server staff and site staff bypass).
--   mode = 'roles'    — only holders of a usergroup with a matching row in
--                       server_command_role_gates may run it; a 'roles' rule
--                       whose LAST role row vanishes (group delete cascade)
--                       falls back to available-to-everyone by design.
-- `command` stores the registry's canonical lowercase name (aliases resolve
-- to it before the check). Zero rows = every command available, exactly as
-- before this migration. Cascades: deleting a server removes its rules;
-- deleting a usergroup removes its role rows.
CREATE TABLE `server_command_rules` (
  `server_id` text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  `command` text NOT NULL,
  `mode` text NOT NULL,
  PRIMARY KEY (`server_id`, `command`)
);
--> statement-breakpoint
CREATE TABLE `server_command_role_gates` (
  `server_id` text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  `command` text NOT NULL,
  `usergroup_id` text NOT NULL REFERENCES server_usergroups(id) ON DELETE CASCADE,
  PRIMARY KEY (`server_id`, `command`, `usergroup_id`)
);
--> statement-breakpoint
CREATE INDEX `server_command_role_gates_group_idx` ON `server_command_role_gates` (`usergroup_id`);
