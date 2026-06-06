-- Track who soft-deleted each message. The admin-audit render in
-- chat needs to surface (a) the original author and (b) the actor
-- who performed the delete (self-delete vs admin/mod action), and
-- neither was stored on the row, `messages.deleted_at` only carried
-- the timestamp.
--
-- Both new columns are nullable (existing pre-migration deletes have
-- no recorded actor; the render falls back to "deleted by someone"
-- copy when the snapshot is missing). The display name is snapshotted
-- the same way `messages.display_name` is for the author, so the
-- audit stays coherent even if the actor later renames or deletes
-- their account.

ALTER TABLE `messages` ADD COLUMN `deleted_by_user_id` TEXT;
--> statement-breakpoint

ALTER TABLE `messages` ADD COLUMN `deleted_by_display_name` TEXT;
