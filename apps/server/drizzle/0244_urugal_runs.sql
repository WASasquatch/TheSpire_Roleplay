-- Urugal's Descent (Spire Arcade game #2) run sessions. One row per descent.
-- The server issues the id at /arcade/urugal/start and validates every
-- milestone event against it: floors must advance monotonically (capped jump)
-- and be paced plausibly (min wall-clock per floor), and each floor / boss
-- pays at most once per run. `max_floor` is the highest PAID floor;
-- `bosses_json` the JSON list of PAID boss floors. Reward crediting + the
-- per-UTC-day cap live in the route (apps/server/src/routes/arcadeUrugal.ts +
-- packages/shared/src/urugal.ts). The game bundle is untrusted client code, so
-- this table is the server's authoritative record of what's actually earned.
CREATE TABLE `urugal_run` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `owner_scope` TEXT NOT NULL,
  `owner_id` TEXT NOT NULL,
  `user_id` TEXT NOT NULL,
  `started_at` INTEGER NOT NULL,
  `last_event_at` INTEGER NOT NULL,
  `max_floor` INTEGER NOT NULL DEFAULT 1,
  `bosses_json` TEXT NOT NULL DEFAULT '[]',
  `status` TEXT NOT NULL DEFAULT 'active',
  `ended_at` INTEGER
);
--> statement-breakpoint
CREATE INDEX `urugal_run_owner_idx` ON `urugal_run` (`owner_scope`, `owner_id`, `status`);
