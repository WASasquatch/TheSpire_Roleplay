-- Affiliates v2: structured "Roleplay Communities" cards + self-service + top-sites tracking.
-- Additive over 0027. Existing rows become legacy kind='html' and keep working.

ALTER TABLE `affiliates` ADD `kind` text NOT NULL DEFAULT 'card';           --> statement-breakpoint
ALTER TABLE `affiliates` ADD `status` text NOT NULL DEFAULT 'approved';     --> statement-breakpoint
ALTER TABLE `affiliates` ADD `owner_user_id` text REFERENCES `users`(`id`); --> statement-breakpoint
ALTER TABLE `affiliates` ADD `title` text;                                  --> statement-breakpoint
ALTER TABLE `affiliates` ADD `description` text;                            --> statement-breakpoint
ALTER TABLE `affiliates` ADD `icon_url` text;                              --> statement-breakpoint
ALTER TABLE `affiliates` ADD `banner_url` text;                           --> statement-breakpoint
ALTER TABLE `affiliates` ADD `target_url` text;                          --> statement-breakpoint
ALTER TABLE `affiliates` ADD `hash` text;                                --> statement-breakpoint
ALTER TABLE `affiliates` ADD `review_note` text;                         --> statement-breakpoint
ALTER TABLE `affiliates` ADD `reviewed_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `affiliates` ADD `reviewed_at` integer;                      --> statement-breakpoint
ALTER TABLE `affiliates` ADD `clicks_in` integer NOT NULL DEFAULT 0;     --> statement-breakpoint
ALTER TABLE `affiliates` ADD `clicks_out` integer NOT NULL DEFAULT 0;    --> statement-breakpoint

-- Existing rows are legacy raw-HTML entries. Mark them so the new card section skips them
-- while the admin tab still lists/manages them. Map enabled -> status.
UPDATE `affiliates` SET `kind` = 'html';                                                --> statement-breakpoint
UPDATE `affiliates` SET `status` = CASE WHEN `enabled` = 1 THEN 'approved' ELSE 'disabled' END; --> statement-breakpoint

-- Unique hash for link-back tracking (nullable: legacy html rows have none).
CREATE UNIQUE INDEX `affiliates_hash_uq` ON `affiliates` (`hash`);       --> statement-breakpoint
CREATE INDEX `affiliates_status_idx` ON `affiliates` (`kind`, `status`, `sort_order`, `created_at`); --> statement-breakpoint
CREATE INDEX `affiliates_owner_idx` ON `affiliates` (`owner_user_id`);   --> statement-breakpoint

-- Click log: one row per counted hit, used to throttle inflation (IP + direction window).
CREATE TABLE `affiliate_click_log` (
  `id` text PRIMARY KEY NOT NULL,
  `affiliate_id` text NOT NULL REFERENCES `affiliates`(`id`) ON DELETE CASCADE,
  `direction` text NOT NULL,           -- 'in' | 'out'
  `ip` text NOT NULL,
  `at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);--> statement-breakpoint
CREATE INDEX `affiliate_click_dedup_idx` ON `affiliate_click_log` (`affiliate_id`, `direction`, `ip`, `at`);
