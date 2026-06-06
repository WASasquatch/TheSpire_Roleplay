-- Per-pet nickname on identity_pet_collection. The pet's catalog name
-- (Maine Coon, Phoenix Chick, etc.) stays the species/breed label; the
-- nickname is the owner's personal name for that specific creature,
-- "Whiskers", "Smaug", etc., shown to anyone viewing their profile.
--
-- Privacy: same posture as the rest of the pet collection. The pet's
-- catalog name is already visible to every profile viewer, so a
-- nickname inherits that "public alongside the pet itself" rule. There
-- is no separate "hide nickname" flag; if the owner doesn't want their
-- pet visible at all, they can unpin it.
--
-- Storage: nullable TEXT on the existing identity_pet_collection row.
-- One row per (ownerScope, ownerId, slot) already exists; we just add
-- a column. Re-pin of a different itemKey in the same slot drops the
-- nickname because the nickname belonged to the previous creature, not
-- the slot. Re-pin of the SAME itemKey in a different slot preserves
-- the nickname via the route's pet-aware diff.

ALTER TABLE `identity_pet_collection` ADD COLUMN `nickname` TEXT;
