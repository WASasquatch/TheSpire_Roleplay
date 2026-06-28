-- One default usergroup per forum (migration 0271).
--
-- ensureDefaultUsergroup does a check-then-insert; two concurrent first opens
-- (or a tab open racing a forum:post-triggered seed) could both insert a
-- default row, leaving the permission baseline nondeterministic and a
-- duplicate that can't be deleted. A partial UNIQUE index makes the second
-- insert a no-op (the seeder uses ON CONFLICT DO NOTHING + re-select).
CREATE UNIQUE INDEX `forum_usergroups_one_default`
  ON `forum_usergroups` (`forum_id`)
  WHERE `is_default` = 1;
