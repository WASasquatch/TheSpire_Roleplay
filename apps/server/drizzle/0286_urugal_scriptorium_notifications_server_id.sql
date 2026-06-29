-- Servers Lift, Phase 5.7 (per-server economy) — arcade run / write-streak /
-- rank-up notification scoping.
--
-- urugal_run and earning_notifications are surrogate-keyed (id PK) so they take
-- an ADDITIVE ADD COLUMN; scriptorium_write_streaks is identity-grained
-- (PK = owner_scope, owner_id) so it takes the house rebuild idiom to widen the
-- PK with server_id. One transaction.
--
-- Every existing row homes to 'server_spire_system' (the Phase-2 backfill
-- target + only server until the flag flips). Off-flag behavior is unchanged:
-- a run's rewards, a writer's weekly streak, and a queued rank-up ribbon all
-- stay where they are today.

-- ============================================================
-- urugal_run: ADD server_id (additive — surrogate id PK kept)
-- ============================================================
-- A descent's rewards credit a per-server pool, so the run records which server
-- it belongs to. The owner-status index is re-pointed to lead with server_id so
-- "this identity's active run in THIS server" stays a single index probe.
ALTER TABLE `urugal_run` ADD COLUMN `server_id` text NOT NULL DEFAULT 'server_spire_system';
--> statement-breakpoint
DROP INDEX IF EXISTS `urugal_run_owner_idx`;
--> statement-breakpoint
CREATE INDEX `urugal_run_owner_idx`
  ON `urugal_run` (`server_id`, `owner_scope`, `owner_id`, `status`);
--> statement-breakpoint

-- ============================================================
-- earning_notifications: ADD server_id (additive — surrogate id PK kept)
-- ============================================================
-- A rank-up happens in a specific server's economy. The unread index is left
-- as-is (the ribbon query is per-user across servers); add a dedicated
-- server-scoped index for the future per-server ribbon filter.
ALTER TABLE `earning_notifications` ADD COLUMN `server_id` text NOT NULL DEFAULT 'server_spire_system';
--> statement-breakpoint
CREATE INDEX `earning_notifications_server_user_idx`
  ON `earning_notifications` (`server_id`, `user_id`, `acknowledged_at`);
--> statement-breakpoint

-- ============================================================
-- scriptorium_write_streaks -> PK (server_id, owner_scope, owner_id)
-- ============================================================
-- The weekly writing streak feeds per-server Currency rewards, so the streak is
-- tracked per server. House rebuild idiom; row homes to the default server.
CREATE TABLE `scriptorium_write_streaks_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `owner_scope` text NOT NULL,
  `owner_id` text NOT NULL,
  `streak_count` integer NOT NULL DEFAULT 0,
  `last_publish_week_key` text,
  `best_streak` integer NOT NULL DEFAULT 0,
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `owner_scope`, `owner_id`)
);
--> statement-breakpoint
INSERT INTO `scriptorium_write_streaks_new` (
  `server_id`, `owner_scope`, `owner_id`, `streak_count`,
  `last_publish_week_key`, `best_streak`, `updated_at`
)
SELECT
  'server_spire_system', `owner_scope`, `owner_id`, `streak_count`,
  `last_publish_week_key`, `best_streak`, `updated_at`
FROM `scriptorium_write_streaks`;
--> statement-breakpoint
DROP TABLE `scriptorium_write_streaks`;
--> statement-breakpoint
ALTER TABLE `scriptorium_write_streaks_new` RENAME TO `scriptorium_write_streaks`;
