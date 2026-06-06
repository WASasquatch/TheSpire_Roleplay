-- Per-identity world memberships and applications.
--
-- Replaces the master-only world model with a per-identity one. A
-- user's OOC face AND each of their characters can independently
-- join worlds, Avery joins Halcyon City, Sigrid joins Eldermarsh,
-- the master's OOC voice joins The Spire community world. Approval
-- binds to the applying identity only; other identities of the same
-- master are NOT auto-joined.
--
-- This also drops the "primary world" concept entirely. With each
-- identity carrying its own memberships, the cross-identity "which
-- world badges you in the userlist" signal becomes meaningless,
-- and the userlist's world-bucket grouping was the surface that
-- leaked "this character is a member of X" by way of grouping them
-- under their master's primary. We retire it; the world's own
-- member list is the source of truth for affiliation.
--
-- Strategy:
--   1. world_members: recreate the table (SQLite can't drop a PK
--      in place). The new shape has no PK and no is_primary column;
--      a nullable character_id distinguishes per-character rows
--      from OOC rows (NULL). Existing rows migrate as OOC rows.
--   2. world_applications: ADD COLUMN works in place; the partial
--      unique index that gated "one pending per (world, applicant)"
--      gets rebuilt to be "one pending per (world, applicant,
--      identity)" using COALESCE on character_id so NULL slots
--      collapse to a single sentinel value the unique index
--      recognizes (default SQLite NULL-distinct-in-UNIQUE behavior
--      would otherwise let the same OOC re-apply repeatedly).

-- ============================================================
-- world_members: recreate
-- ============================================================
CREATE TABLE `world_members_new` (
  `world_id` text NOT NULL REFERENCES `worlds`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `character_id` text REFERENCES `characters`(`id`) ON DELETE CASCADE,
  `joined_at` integer NOT NULL
);
--> statement-breakpoint

-- Migrate existing rows: every legacy membership becomes an OOC
-- membership (character_id = NULL). The is_primary column is
-- intentionally dropped, we retire primary-world entirely.
INSERT INTO `world_members_new` (`world_id`, `user_id`, `character_id`, `joined_at`)
  SELECT `world_id`, `user_id`, NULL, `joined_at` FROM `world_members`;
--> statement-breakpoint

DROP TABLE `world_members`;
--> statement-breakpoint
ALTER TABLE `world_members_new` RENAME TO `world_members`;
--> statement-breakpoint

-- "One membership per (world, user, identity)", COALESCE collapses
-- NULL (the OOC slot) into the empty string so SQLite's
-- NULL-distinct-in-UNIQUE-index quirk doesn't let one user re-join
-- the same world as OOC twice.
CREATE UNIQUE INDEX `world_members_identity_uq`
  ON `world_members` (`world_id`, `user_id`, COALESCE(`character_id`, ''));
--> statement-breakpoint
CREATE INDEX `world_members_user_idx`
  ON `world_members` (`user_id`);
--> statement-breakpoint
CREATE INDEX `world_members_world_idx`
  ON `world_members` (`world_id`);
--> statement-breakpoint
CREATE INDEX `world_members_character_idx`
  ON `world_members` (`character_id`);
--> statement-breakpoint

-- ============================================================
-- world_applications: add character_id + rebuild pending-uniqueness
-- ============================================================
ALTER TABLE `world_applications` ADD COLUMN `character_id` text
  REFERENCES `characters`(`id`) ON DELETE CASCADE;
--> statement-breakpoint

-- Replace the old partial unique with the identity-aware one. Same
-- COALESCE trick as world_members so an OOC applicant's NULL
-- character_id participates correctly in the uniqueness check.
DROP INDEX `world_applications_one_pending_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `world_applications_one_pending_uq`
  ON `world_applications` (`world_id`, `applicant_user_id`, COALESCE(`character_id`, ''))
  WHERE `status` = 'pending';
