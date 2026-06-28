-- Forum tag tooltip (migration 0269).
--
-- A short owner-written explanation of what a tag means (e.g. "Long-running
-- story open to new players"). Shown on hover wherever the tag chip renders
-- and in the tag picker. NULL = no tooltip (the label speaks for itself).
ALTER TABLE `forum_prefixes` ADD COLUMN `tooltip` TEXT;
