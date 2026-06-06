-- Move active-cosmetic slots (name style + inline avatar) from
-- account-wide to per-identity.
--
-- Before: `user_active_cosmetics.active_name_style_key` and
-- `inline_avatar_enabled` were a single pair per user, so every
-- character of that user inherited whatever the master had equipped
-- (Kaal showed up with Embers because WAS equipped it).
--
-- After: each character carries its own pair via two new columns on
-- `character_earning` (which already partitions per-character XP /
-- currency / rank / border). When a character is the active identity,
-- the renderer reads its slot; when the user is OOC/master, it falls
-- back to `user_active_cosmetics` (which is reinterpreted as the
-- master-only slot, semantic shift, no row movement needed).
--
-- Existing characters start with both columns null/false. Users will
-- equip per-character explicitly via the dashboard going forward;
-- no auto-backfill from the master because that would re-introduce
-- the very bleed we're fixing.

ALTER TABLE `character_earning` ADD COLUMN `active_name_style_key` TEXT;
--> statement-breakpoint

ALTER TABLE `character_earning` ADD COLUMN `inline_avatar_enabled` INTEGER NOT NULL DEFAULT 0;
