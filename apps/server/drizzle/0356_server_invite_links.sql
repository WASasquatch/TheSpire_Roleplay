-- Server invite links (public /i/<code> pages + member-created invites).
--
-- servers.invite_create_mode — who may mint invite links for this server:
--   'staff' (default; the pre-existing manage_invites behavior),
--   'roles'  (members of the usergroups listed in invite_create_group_ids),
--   'all'    (any member).
-- servers.invite_create_group_ids — JSON string[] of server_usergroups ids for
-- the 'roles' mode; NULL = none selected (so 'roles' with no groups is
-- effectively staff-only). No FK: group deletions just leave a harmless
-- dangling id that the policy check skips.
--
-- users.invited_server_id — one-shot signup carry-through: the community whose
-- invite this account registered through. The first socket landing consumes it
-- (placing the newcomer in that server's landing room, ahead of the
-- liveliest-room tier) and clears it. SET NULL on server delete so a vanished
-- community degrades to the normal landing walk.
ALTER TABLE `servers` ADD COLUMN `invite_create_mode` text NOT NULL DEFAULT 'staff';
--> statement-breakpoint
ALTER TABLE `servers` ADD COLUMN `invite_create_group_ids` text;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `invited_server_id` text REFERENCES servers(id) ON DELETE SET NULL;
