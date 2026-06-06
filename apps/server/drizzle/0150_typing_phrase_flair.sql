-- Custom typing-phrase Flair cosmetic (Phase 5 of the cosmetic
-- expansion). Rides on the Phase 4 global typing indicator wire.
--
-- Model: gated by a per-identity purchase of `flair_typing_phrase`
-- through the existing cosmetic-purchase path. Once owned, the user
-- supplies their own short text string ("Embers smolder…", "is
-- scheming…", etc.) which the indicator renders in place of the
-- default "is typing…" suffix. Length-capped server-side; admin
-- retains a clear lever for moderation.
--
-- Why per-identity (not per-account): the typing phrase is part of
-- the speaker's voice. A character roleplaying as a stoic dwarf
-- should be able to say "grunts thoughtfully…" while their master
-- account uses the default suffix. Same partition rules as every
-- other earning cosmetic, purchase + slot scoped to (user|character).
--
-- Why only when exactly one user is typing: joint forms ("Alice and
-- Bob are typing…") read poorly if we splice "Embers smolder…" in
-- there. The renderer falls back to the default phrasing for any
-- typer set of 2+. The wire still carries the phrase per-entry so
-- a future renderer change is possible without a migration.

-- Per-identity phrase column. Nullable so clearing it returns to
-- the default "is typing…" without an extra "is using custom" flag.
-- App-layer validator gates writes on `flair_typing_phrase`
-- ownership (earning_ledger lookup), matching how the banner slot
-- works in migration 0148.
ALTER TABLE `user_earning`
  ADD COLUMN `typing_phrase` TEXT;
--> statement-breakpoint
ALTER TABLE `character_earning`
  ADD COLUMN `typing_phrase` TEXT;
--> statement-breakpoint

-- Seed the new Flair catalog row. Idempotent re-run protection via
-- INSERT OR IGNORE on the primary key. Cost is a placeholder,
-- admins tune via the Flair admin tab. Sat at the same tier as the
-- profile-banner purchase since both follow the same "buy unlock,
-- then supply your own content" pattern.
INSERT OR IGNORE INTO `cosmetics`
  (`key`, `name`, `description`, `cost`, `enabled`, `config_json`)
VALUES
  ('flair_typing_phrase',
   'Custom Typing Phrase',
   'Replace "is typing…" with your own short phrase. Up to 60 characters; admins can clear abusive content.',
   2000,
   1,
   NULL);
