-- Profile-banner Flair cosmetic (Phase 2 of the cosmetic expansion).
--
-- Model: gated by a per-identity purchase of `flair_profile_banner`
-- through the existing cosmetic-purchase path. Once owned, the user
-- pastes a banner image URL into a slot stored on their active-
-- cosmetics row (master/OOC) or character_earning row (per-character).
-- ProfileModal renders the URL as a 3:1 hero strip when set.
--
-- Why URL-only at this stage: no upload pipeline, no image hosting,
-- no admin moderation queue. Validation is "looks like http(s) + HEAD
-- sniff says image/*" — soft, but enough for a v1. Admin keeps a
-- "clear this user's banner" lever for abuse reports.

-- Per-identity URL slot. Nullable so unsetting clears cleanly. The
-- application-layer check guarantees the column is only writable when
-- the matching identity owns `flair_profile_banner` (the existing
-- earning_ledger ownership check), so a DB-only update can't smuggle
-- a banner past the purchase gate.
ALTER TABLE `user_active_cosmetics`
  ADD COLUMN `profile_banner_url` TEXT;
--> statement-breakpoint
ALTER TABLE `character_earning`
  ADD COLUMN `profile_banner_url` TEXT;
--> statement-breakpoint

-- Seed the new Flair catalog row. Idempotent: re-running the migration
-- (e.g. after a baseline-skip on an older install) doesn't double-
-- insert. Cost is a placeholder — admins tune via the Flair admin tab.
INSERT OR IGNORE INTO `cosmetics`
  (`key`, `name`, `description`, `cost`, `enabled`, `config_json`)
VALUES
  ('flair_profile_banner',
   'Custom Profile Banner',
   'Unlock a banner strip at the top of your profile. Paste any public image URL after purchase.',
   2500,
   1,
   NULL);
