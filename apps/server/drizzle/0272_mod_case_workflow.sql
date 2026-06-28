-- Mod case log: status workflow + notes + update timeline + evidence backup
-- (migration 0272).
--
-- Extends the moderation case log (migration 0254):
--   * `kind` — "case" (an infraction/dispute with a workflow) or "note" (a
--     standing informational note about a user, no resolution needed).
--   * `status` gains "in_progress" alongside "open"/"resolved" (the column is
--     plain TEXT, so no column change is needed — the value set is enforced in
--     the app + drizzle enum).
--   * `mod_case_updates` — an append-only timeline so staff can add progress
--     notes (and status changes) WITHOUT editing the original resolution.
--   * `mod_case_evidence` — snapshots of chat messages (by id, like /reply
--     targets) backed up onto a case, since the janitor purges old messages.
ALTER TABLE `mod_cases` ADD COLUMN `kind` TEXT NOT NULL DEFAULT 'case';
--> statement-breakpoint
CREATE TABLE `mod_case_updates` (
  `id` TEXT PRIMARY KEY,
  `case_id` TEXT NOT NULL REFERENCES `mod_cases`(`id`) ON DELETE CASCADE,
  `body` TEXT NOT NULL,
  -- The status this update moved the case to, when it changed one (else NULL).
  `status_change` TEXT,
  `author_user_id` TEXT REFERENCES `users`(`id`) ON DELETE SET NULL,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX `mod_case_updates_case_idx` ON `mod_case_updates` (`case_id`, `created_at`);
--> statement-breakpoint
-- Snapshotted chat messages preserved as evidence on a case. The original
-- message id is kept for reference but the body/author/room are snapshotted so
-- the record survives the janitor hard-deleting the source.
CREATE TABLE `mod_case_evidence` (
  `id` TEXT PRIMARY KEY,
  `case_id` TEXT NOT NULL REFERENCES `mod_cases`(`id`) ON DELETE CASCADE,
  `message_id` TEXT,
  `author_user_id` TEXT,
  `author_label` TEXT,
  `body` TEXT,
  `kind` TEXT,
  `room_id` TEXT,
  `room_name` TEXT,
  `original_created_at` INTEGER,
  `snapshotted_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
-- One snapshot per (case, message); a re-add is a no-op.
CREATE UNIQUE INDEX `mod_case_evidence_case_msg_idx` ON `mod_case_evidence` (`case_id`, `message_id`);
--> statement-breakpoint
CREATE INDEX `mod_case_evidence_case_idx` ON `mod_case_evidence` (`case_id`, `snapshotted_at`);
