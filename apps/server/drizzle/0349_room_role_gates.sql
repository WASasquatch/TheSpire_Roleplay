-- Per-role room permissions (usergroup-gated rooms).
-- One row per (room, usergroup, kind):
--   kind = 'access' — any row of this kind makes the room ROLE-LOCKED:
--                     non-holders don't receive it in GET /rooms, can't join,
--                     and its slug 404s (same no-leak shape as private rooms).
--                     Site staff, server staff and the room owner always pass.
--   kind = 'post'   — with rooms.post_mode = 'roles', holders of any row of
--                     this kind may post; everyone else gets the read-only
--                     composer (post_mode = 'staff' ignores these rows).
-- Cascades: deleting a room or a usergroup removes its gate rows — a room
-- whose LAST access row vanishes becomes public again by design.
CREATE TABLE `room_role_gates` (
  `room_id` text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  `usergroup_id` text NOT NULL REFERENCES server_usergroups(id) ON DELETE CASCADE,
  `kind` text NOT NULL,
  PRIMARY KEY (`room_id`, `usergroup_id`, `kind`)
);
--> statement-breakpoint
CREATE INDEX `room_role_gates_room_idx` ON `room_role_gates` (`room_id`);
--> statement-breakpoint
CREATE INDEX `room_role_gates_group_idx` ON `room_role_gates` (`usergroup_id`);
