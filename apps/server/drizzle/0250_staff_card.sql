-- Staff-card copy for the public Staff page. Editable by each staff
-- member for their own card. staff_bio = short tagline (<=120 chars),
-- staff_intro = longer blurb (<=256 chars). Plain text, null until set.
-- Only surfaced for mod/admin/masteradmin accounts.
ALTER TABLE `users` ADD COLUMN `staff_bio` TEXT;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `staff_intro` TEXT;
