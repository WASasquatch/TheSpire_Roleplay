-- Mutual titles: two-party relationship labels (Married to X, X's Partner,
-- Best Friend of X, etc.) requested by one identity and accepted by the
-- other. Each row in `mutual_titles` represents an in-flight or accepted
-- title between two identities (an identity = a userId + nullable
-- characterId, where null means the master account).
--
-- The catalog (`title_kinds`) is admin-managed: admins can add new kinds
-- with custom display formats. format_a applies to the A-side (requester),
-- format_b to the B-side (recipient). For symmetric kinds the two formats
-- match; for asymmetric kinds they differ (e.g. mentor / apprentice).
-- {target} in the format string is replaced with the other party's
-- display name at render time.

CREATE TABLE `title_kinds` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`label` text NOT NULL,
	`symmetric` integer DEFAULT 1 NOT NULL,
	`format_a` text NOT NULL,
	`format_b` text NOT NULL,
	`exclusive` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `title_kinds_slug_uq` ON `title_kinds` (lower(`slug`));
--> statement-breakpoint
CREATE TABLE `mutual_titles` (
	`id` text PRIMARY KEY NOT NULL,
	`kind_id` text NOT NULL,
	`a_user_id` text NOT NULL,
	`a_character_id` text,
	`b_user_id` text NOT NULL,
	`b_character_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`dissolve_initiator` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`responded_at` integer,
	FOREIGN KEY (`kind_id`) REFERENCES `title_kinds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`a_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`a_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`b_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`b_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mutual_titles_a_idx` ON `mutual_titles` (`a_user_id`,`a_character_id`);
--> statement-breakpoint
CREATE INDEX `mutual_titles_b_idx` ON `mutual_titles` (`b_user_id`,`b_character_id`);
--> statement-breakpoint
CREATE INDEX `mutual_titles_kind_idx` ON `mutual_titles` (`kind_id`);
--> statement-breakpoint
-- Seed the built-in catalog. Admins can edit / disable / extend via the
-- admin UI; deleting a kind cascades to any in-flight or accepted titles
-- of that kind.
INSERT INTO `title_kinds` (`id`, `slug`, `label`, `symmetric`, `format_a`, `format_b`, `exclusive`)
VALUES
  ('marriage', 'marriage', 'Marriage', 1, 'Married to {target}', 'Married to {target}', 1),
  ('partner', 'partner', 'Partner', 1, '{target}''s Partner', '{target}''s Partner', 0),
  ('mate', 'mate', 'Mate', 1, 'Mate of {target}', 'Mate of {target}', 0),
  ('bestfriend', 'bestfriend', 'Best Friend', 1, 'Best Friend of {target}', 'Best Friend of {target}', 0),
  ('sibling', 'sibling', 'Sibling', 1, 'Sibling of {target}', 'Sibling of {target}', 0);
