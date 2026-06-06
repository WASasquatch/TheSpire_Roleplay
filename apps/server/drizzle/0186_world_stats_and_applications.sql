-- World vibe stats + application-gated joining.
--
-- Adds two orthogonal feature groups to the worlds system:
--
--   1. Vibe stats, eight integer axes (0..100) that authors tune to
--      describe the feel of their setting (Combat / Magic / Tech /
--      Romance / Politics / Mystery / Horror / Exploration). Nullable
--      because "unset" reads differently from "0" in the catalog
--      bars; an empty column is rendered as a muted "-" rather than
--      a zero-width bar. The catalog uses range filters (min/max per
--      axis) so a user can find e.g. combat-heavy + low-romance
--      worlds.
--
--   2. joinMode + applications, gates membership behind an
--      author-reviewed application instead of forcing the binary
--      "open" / "owner-can-add-only" choice the visibility enum
--      currently implies. Orthogonal to visibility: a private world
--      can still ask for applications from people who got the link,
--      and a public world can stay open-join. The join route checks
--      both gates before inserting a world_members row.
--
-- Defaults:
--   * stats: NULL (author hasn't tuned). Existing rows keep null.
--   * join_mode: 'open' to preserve current behavior for legacy
--     worlds, anything that used to be `visibility = 'open'`
--     remains open-join after this migration.
--   * application_questions_json: '[]' so the JSON-parse path
--     never sees null and existing app-mode toggles work without
--     a separate "set questions first" wizard.

ALTER TABLE `worlds` ADD COLUMN `stat_combat` integer;
--> statement-breakpoint
ALTER TABLE `worlds` ADD COLUMN `stat_magic` integer;
--> statement-breakpoint
ALTER TABLE `worlds` ADD COLUMN `stat_technology` integer;
--> statement-breakpoint
ALTER TABLE `worlds` ADD COLUMN `stat_romance` integer;
--> statement-breakpoint
ALTER TABLE `worlds` ADD COLUMN `stat_politics` integer;
--> statement-breakpoint
ALTER TABLE `worlds` ADD COLUMN `stat_mystery` integer;
--> statement-breakpoint
ALTER TABLE `worlds` ADD COLUMN `stat_horror` integer;
--> statement-breakpoint
ALTER TABLE `worlds` ADD COLUMN `stat_exploration` integer;
--> statement-breakpoint

ALTER TABLE `worlds` ADD COLUMN `join_mode` text NOT NULL DEFAULT 'open';
--> statement-breakpoint
ALTER TABLE `worlds` ADD COLUMN `application_questions_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint

-- Per-applicant application rows. One row per (world, applicant)
-- in 'pending' status, once reviewed (approved / rejected) or
-- withdrawn, the row stays as an audit trail and a fresh re-apply
-- creates a new row. The partial unique index below enforces the
-- "one pending per (world, applicant)" rule without blocking
-- re-applications after a reject/withdraw.
CREATE TABLE `world_applications` (
  `id` text PRIMARY KEY NOT NULL,
  `world_id` text NOT NULL REFERENCES `worlds`(`id`) ON DELETE CASCADE,
  `applicant_user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  -- JSON array of strings, same length as the world's question list
  -- at the time of submission. Server validates length match on
  -- insert; later edits to the world's questions don't retroactively
  -- shorten / lengthen existing answers.
  `answers_json` text NOT NULL DEFAULT '[]',
  `status` text NOT NULL DEFAULT 'pending',
  `submitted_at` integer NOT NULL,
  `reviewed_at` integer,
  `reviewed_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  -- Optional free-text feedback the author can show the applicant
  -- on reject (or even on approve). Null when no note.
  `review_note` text
);
--> statement-breakpoint

CREATE INDEX `world_applications_world_status_idx`
  ON `world_applications` (`world_id`, `status`);
--> statement-breakpoint
CREATE INDEX `world_applications_applicant_idx`
  ON `world_applications` (`applicant_user_id`, `status`);
--> statement-breakpoint

-- Enforce one PENDING application per (world, applicant). Old
-- terminal-state rows (approved / rejected / withdrawn) stay for
-- audit; a fresh re-apply creates a new pending row that doesn't
-- collide with them.
CREATE UNIQUE INDEX `world_applications_one_pending_uq`
  ON `world_applications` (`world_id`, `applicant_user_id`)
  WHERE `status` = 'pending';
