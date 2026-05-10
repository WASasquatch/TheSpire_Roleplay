-- Affiliate / partner / sponsor entries shown on the splash. Each row
-- stores raw HTML (admin-trusted, NOT sanitized) so topsite networks like
-- toprpsites can include their tracking pixels alongside the badge image.
-- The label column is admin-only; it never renders publicly.

CREATE TABLE `affiliates` (
  `id` text PRIMARY KEY NOT NULL,
  `label` text NOT NULL,
  `html` text NOT NULL,
  `enabled` integer NOT NULL DEFAULT 1,
  `sort_order` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);--> statement-breakpoint

CREATE INDEX `affiliates_sort_idx` ON `affiliates` (`enabled`, `sort_order`, `created_at`);
