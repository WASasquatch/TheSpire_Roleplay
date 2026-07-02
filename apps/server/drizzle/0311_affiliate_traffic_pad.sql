-- Top Communities "traffic padding": optional synthetic in/out traffic a global
-- admin can add to a community card so a quiet listing still shows some life.
-- Kept SEPARATE from the real clicks_in/clicks_out counters (never mixed) and
-- computed lazily at read time from a per-day random target (0..max) spread
-- across the day. Additive over 0307.

-- Per-direction config (global-admin only) + accumulated synthetic totals.
ALTER TABLE `affiliates` ADD `pad_in_enabled` integer NOT NULL DEFAULT 0;   --> statement-breakpoint
ALTER TABLE `affiliates` ADD `pad_in_max` integer NOT NULL DEFAULT 0;       --> statement-breakpoint
ALTER TABLE `affiliates` ADD `pad_in_banked` integer NOT NULL DEFAULT 0;    --> statement-breakpoint
ALTER TABLE `affiliates` ADD `pad_in_target` integer NOT NULL DEFAULT 0;    --> statement-breakpoint
ALTER TABLE `affiliates` ADD `pad_out_enabled` integer NOT NULL DEFAULT 0;  --> statement-breakpoint
ALTER TABLE `affiliates` ADD `pad_out_max` integer NOT NULL DEFAULT 0;      --> statement-breakpoint
ALTER TABLE `affiliates` ADD `pad_out_banked` integer NOT NULL DEFAULT 0;   --> statement-breakpoint
ALTER TABLE `affiliates` ADD `pad_out_target` integer NOT NULL DEFAULT 0;   --> statement-breakpoint
-- Shared YYYY-MM-DD the current targets belong to; NULL until first initialized.
ALTER TABLE `affiliates` ADD `pad_day` text;
