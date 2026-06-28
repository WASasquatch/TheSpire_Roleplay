-- Forum usergroups (migration 0270).
--
-- Owner/admin-defined groups that grant a set of forum permissions (the
-- unified registry: moderation AND member-feature gates). A member's effective
-- permissions = the union of the default group + every group they're in + any
-- direct mod grant (forum_members.permissions_json). The DEFAULT group is the
-- baseline every participant implicitly belongs to (no member rows); editing it
-- changes what ungrouped members can do. Non-default groups use explicit member
-- rows, added manually by a manager OR automatically when a member meets the
-- group's auto-join rules (post count, topic count, posted-in-category, age).
CREATE TABLE `forum_usergroups` (
  `id` TEXT PRIMARY KEY,
  `forum_id` TEXT NOT NULL REFERENCES `forums`(`id`) ON DELETE CASCADE,
  `name` TEXT NOT NULL,
  `color` TEXT,
  -- JSON array of ForumPermission keys this group grants.
  `permissions_json` TEXT NOT NULL DEFAULT '[]',
  -- Exactly one per forum: the implicit baseline for every participant.
  `is_default` INTEGER NOT NULL DEFAULT 0,
  `sort_order` INTEGER NOT NULL DEFAULT 0,
  -- JSON array of auto-join rules (ForumAutoRule[]); ALL must match to join.
  `auto_rules_json` TEXT NOT NULL DEFAULT '[]',
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX `forum_usergroups_forum_idx` ON `forum_usergroups` (`forum_id`, `sort_order`);
--> statement-breakpoint
-- Explicit (non-default) group memberships. `added_by` NULL + `is_auto` = 1
-- marks an automatic membership; a manual add records the actor and is_auto 0.
CREATE TABLE `forum_usergroup_members` (
  `group_id` TEXT NOT NULL REFERENCES `forum_usergroups`(`id`) ON DELETE CASCADE,
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `added_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `added_by` TEXT,
  `is_auto` INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (`group_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `forum_usergroup_members_user_idx` ON `forum_usergroup_members` (`user_id`);
