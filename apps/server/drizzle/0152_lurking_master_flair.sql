-- Lurking Master Flair cosmetic (Phase 6 of the cosmetic expansion).
--
-- Hide-my-typing-status toggle. Gated by per-identity purchase of
-- `flair_lurking_master`. When equipped, the server omits this
-- user from the room's typer set for every non-admin receiver —
-- admins still see the typing pulse so moderators retain
-- visibility for harassment/abuse investigation.
--
-- Per-identity (master + per-character) because someone roleplaying
-- a stealthy assassin wants to lurk silently on that character but
-- their OOC master account might still announce typing in OOC
-- chat. Same partition rules as inline_avatar.

-- Master-pool toggle. Lives on `user_active_cosmetics` alongside the
-- existing inline_avatar flag (which uses the same pattern).
ALTER TABLE `user_active_cosmetics`
  ADD COLUMN `lurking_master_enabled` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Per-character toggle. Mirrors `character_earning.inline_avatar_enabled`.
ALTER TABLE `character_earning`
  ADD COLUMN `lurking_master_enabled` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Seed the catalog row. INSERT OR IGNORE for idempotent re-runs.
-- Cost is a placeholder — admins tune via the Flair admin tab.
INSERT OR IGNORE INTO `cosmetics`
  (`key`, `name`, `description`, `cost`, `enabled`, `config_json`)
VALUES
  ('flair_lurking_master',
   'Lurking Master',
   'Hide your "is typing..." status from peers. You appear silent while composing; admins still see your typing for moderation oversight.',
   3000,
   1,
   NULL);
