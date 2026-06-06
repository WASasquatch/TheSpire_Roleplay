-- Two columns on `emoticon_sheets` powering the new community
-- features:
--
--   1. `commerce_enabled`, per-sheet toggle for the 1-Currency-per-use
--      paywall on community sheets. Default 1 (commerce on) so every
--      existing approved submission preserves today's paid-by-default
--      behavior; sheet owners can flip it to 0 after the fact to mark
--      their sheet as free-to-use. System sheets (createdByUserId IS
--      NULL) ignore this flag and are always free.
--
--   2. `use_count`, denormalized total of how many times any of this
--      sheet's emoticons has been used. Bumped at use time alongside
--      the (optional) debit/credit pair. Powers the "Top" sort in the
--      picker's Community tab without forcing a COUNT(*) over the
--      earning ledger on every picker open.
--
-- Both default 0/1 so no follow-up backfill is needed, existing rows
-- read the safe defaults.

ALTER TABLE `emoticon_sheets` ADD COLUMN `commerce_enabled` INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `emoticon_sheets` ADD COLUMN `use_count` INTEGER NOT NULL DEFAULT 0;
