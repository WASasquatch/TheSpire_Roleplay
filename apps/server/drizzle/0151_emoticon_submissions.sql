-- User-uploaded reaction sheets + moderation queue (Phase 3 of the
-- cosmetic expansion).
--
-- Model: users pay Currency from the active identity's pool to submit
-- a custom 4×4 emoticon sheet. The row lands in `emoticon_sheets`
-- with `status='pending'`, filtered out of every user-facing picker
-- query, until an admin approves or rejects it. Rejection refunds
-- the submission cost and deletes the asset file.
--
-- Why extend the existing table instead of a parallel submissions
-- table: the approved row IS the live sheet. A separate table would
-- duplicate every column and require a copy step on approval; doing
-- it inline lets approval be a single UPDATE and keeps reactions
-- pointing at one stable id across the submission → live lifecycle.
-- Existing rows are backfilled to `status='approved'` so the
-- emoticon picker doesn't blank out on the first deploy.
--
-- Pricing lives on the `cosmetics` row `flair_reaction_sheet` seeded
-- below. The submission endpoint reads `.cost` from this row at
-- submission time so admins can tune the price via the Flair admin
-- tab without a code change.

-- Lifecycle column. NOT NULL with a default so the backfill on
-- existing rows is trivial. Open string (no CHECK) so a future
-- moderation state (e.g. 'flagged') can be added without a
-- schema migration; the application layer enforces the valid set.
ALTER TABLE `emoticon_sheets`
  ADD COLUMN `status` TEXT NOT NULL DEFAULT 'approved';
--> statement-breakpoint

-- Per-identity submission scope. `submitter_scope` is 'user' (master
-- paid) or 'character' (that character paid); `submitter_pool_id` is
-- the matching ownerId for the ledger refund on rejection. Both are
-- nullable because admin-created rows have no submission record,
-- the `created_by_user_id` column already covers them.
ALTER TABLE `emoticon_sheets`
  ADD COLUMN `submitter_scope` TEXT;
--> statement-breakpoint
ALTER TABLE `emoticon_sheets`
  ADD COLUMN `submitter_pool_id` TEXT;
--> statement-breakpoint

-- Snapshot of the cost paid at submission time. Used by the reject
-- path to refund the exact amount even if the admin has tuned the
-- catalog price between submission and review.
ALTER TABLE `emoticon_sheets`
  ADD COLUMN `cost_paid` INTEGER;
--> statement-breakpoint

-- Moderation outcome columns. `reviewed_at` doubles as the
-- "was this row touched by moderation?" signal, null on admin-
-- created rows that never went through the queue.
ALTER TABLE `emoticon_sheets`
  ADD COLUMN `reviewed_at` INTEGER;
--> statement-breakpoint
ALTER TABLE `emoticon_sheets`
  ADD COLUMN `reviewed_by_user_id` TEXT
  REFERENCES `users`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `emoticon_sheets`
  ADD COLUMN `rejection_reason` TEXT;
--> statement-breakpoint

-- Lookup index for the moderation queue admin view. The pending
-- list is the hot path; approved/rejected rows still benefit from
-- the index when filtering "this user's submissions" by status.
CREATE INDEX IF NOT EXISTS `emoticon_sheets_status_idx`
  ON `emoticon_sheets` (`status`);
--> statement-breakpoint

-- Pricing cosmetic row. The submission endpoint reads `.cost` from
-- this row at submission time (NOT a one-time purchase, each upload
-- re-pays). Cost can be tuned by admins via the Flair admin tab.
-- Idempotent: INSERT OR IGNORE protects re-runs after a baseline
-- skip on an older install.
INSERT OR IGNORE INTO `cosmetics`
  (`key`, `name`, `description`, `cost`, `enabled`, `config_json`)
VALUES
  ('flair_reaction_sheet',
   'Custom Reaction Sheet',
   'Upload your own 4×4 reaction sprite sheet. Each submission is reviewed by a moderator; rejected submissions refund the cost.',
   5000,
   1,
   NULL);
