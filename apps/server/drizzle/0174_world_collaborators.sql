-- World collaborators: per-world list of additional users the owner
-- has invited to co-edit the wiki. The owner stays the sole admin
-- of the collaborator list itself (only the owner can add or remove
-- collaborators); collaborators get the same edit rights as the
-- owner on the world's pages + metadata, mirroring what a Scriptorium
-- collaborator can do on a story.
--
-- Schema:
--   * Compound PK (world_id, user_id) enforces one row per
--     (world, collaborator) pair so a duplicate invite is a no-op.
--   * `added_at` snapshots when access was granted, for audit and
--     to display "Joined as collaborator on X" in the UI.
--   * `added_by_user_id` records who granted the access. SET NULL on
--     user delete so a removed admin doesn't cascade-delete every
--     collaborator they ever added.
--   * Both world_id and user_id cascade-delete: removing a world or
--     the user themselves cleanly purges their collaborator rows.
--
-- Permission posture (enforced in apps/server/src/routes/worlds.ts):
--   * Owner OR admin OR member-of-this-list can edit the world body,
--     create/edit/delete pages, and update visibility.
--   * Only the owner (or admin) can manage the collaborator list.
--   * Collaborators CANNOT add other collaborators, transfer
--     ownership, or delete the world.
--
-- See migration 0144_scriptorium_collaborators.sql for the matching
-- pattern in the Scriptorium subsystem.

CREATE TABLE `world_collaborators` (
  `world_id` TEXT NOT NULL REFERENCES `worlds`(`id`) ON DELETE CASCADE,
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `added_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `added_by_user_id` TEXT REFERENCES `users`(`id`) ON DELETE SET NULL,
  PRIMARY KEY (`world_id`, `user_id`)
);
--> statement-breakpoint

CREATE INDEX `world_collaborators_user_idx` ON `world_collaborators`(`user_id`);
