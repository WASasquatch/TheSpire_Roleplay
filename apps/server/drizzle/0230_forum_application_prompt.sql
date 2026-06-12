-- Forums Phase 5: owner-set membership-application prompt. Shown above the
-- one answer field when posting_mode = 'application' ("Why do you want to
-- join?", "Link a writing sample", ...). NULL = a generic prompt.
ALTER TABLE `forums` ADD COLUMN `application_prompt` text;
