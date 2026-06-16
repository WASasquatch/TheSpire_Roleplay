-- Per-room Difficulty Class (DC) for dice mechanics. Owners/mods/admins set
-- it via `/roll dc <n>`. When set, plain `/roll` and `/initiative` report
-- pass/fail against this threshold (a roll must MEET OR BEAT it). Null = no
-- difficulty configured for the room (rolls just report their total).
ALTER TABLE `rooms` ADD COLUMN `difficulty_class` INTEGER;
