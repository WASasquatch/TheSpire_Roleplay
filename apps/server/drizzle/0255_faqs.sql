-- Public FAQ entries (migration 0255).
--
-- Admin-authored question/answer entries with a globally-unique slug so a mod
-- can link a canonical answer directly (`/faq/<slug>`), including to logged-out
-- visitors. `answer_html` is sanitized server-side on save. `enabled` gates
-- public visibility (draft vs published); `sort_order` is admin-chosen.
--
-- Seeds the two gating permissions to the `admin` role (FAQ is admin-authored
-- site content; public reading needs no permission). masteradmin bypasses.
CREATE TABLE `faqs` (
  `id` TEXT PRIMARY KEY,
  `slug` TEXT NOT NULL,
  `question` TEXT NOT NULL,
  `answer_markdown` TEXT NOT NULL DEFAULT '',
  `answer_html` TEXT NOT NULL,
  `category` TEXT,
  `sort_order` INTEGER NOT NULL DEFAULT 0,
  `enabled` INTEGER NOT NULL DEFAULT 1,
  `created_by_user_id` TEXT REFERENCES `users`(`id`) ON DELETE SET NULL,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `faqs_slug_uq` ON `faqs` (lower(`slug`));
--> statement-breakpoint
CREATE INDEX `faqs_enabled_idx` ON `faqs` (`enabled`, `sort_order`, `created_at`);
--> statement-breakpoint
INSERT OR IGNORE INTO `role_permission_grants` (`role`, `permission_key`) VALUES
  ('admin', 'view_admin_faqs'),
  ('admin', 'manage_faqs');
