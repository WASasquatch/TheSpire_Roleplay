-- Servers Lift, Phase 5.7 (per-server economy) — per-server backfill latch.
--
-- A one-row-per-server idempotency latch for the economy backfill / provisioning
-- pass (Team H runtime, next stage). `completed_at` is NULL until the per-server
-- economy initialization for that server has run to completion; a non-null
-- timestamp makes a re-run a no-op (mirrors the _migrations skip semantics, but
-- per server rather than per migration file).
--
-- The default (is_system) server is seeded as ALREADY complete: the Phase-2
-- backfill (0281-era) plus migrations 0282-0286 already homed every existing
-- balance/holding/cosmetic to 'server_spire_system', so there is nothing left
-- to backfill for it. Newly-created servers insert their own row (completed_at
-- NULL) at provisioning and stamp it once initialized.
CREATE TABLE `server_backfill_state` (
  `server_id` text PRIMARY KEY NOT NULL,
  `completed_at` integer
);
--> statement-breakpoint
INSERT INTO `server_backfill_state` (`server_id`, `completed_at`)
  VALUES ('server_spire_system', unixepoch() * 1000);
