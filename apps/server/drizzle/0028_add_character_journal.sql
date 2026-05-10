-- Per-character journal entries. Solo writing the owner attaches to a
-- character: backstory fragments, in-world diary entries, world notes,
-- scenes-too-quiet-for-chat. Public entries surface on the character's
-- profile in chronological order; private entries are owner-only.
--
-- bodyHtml uses the same sanitization allow-list as bios (strip on save,
-- render via React, never via dangerouslySetInnerHTML for body content).

CREATE TABLE `character_journal_entries` (
  `id` text PRIMARY KEY NOT NULL,
  `character_id` text NOT NULL,
  `title` text,
  `body_html` text NOT NULL,
  `privacy` text NOT NULL DEFAULT 'public',
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);--> statement-breakpoint

CREATE INDEX `character_journal_char_idx` ON `character_journal_entries` (`character_id`, `created_at`);
