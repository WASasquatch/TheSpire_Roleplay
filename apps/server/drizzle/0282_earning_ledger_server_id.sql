-- Servers Lift, Phase 5.7 (per-server economy) — earning_ledger.
--
-- The earning audit log gains a `server_id` discriminator so every XP /
-- Currency delta is attributable to the server it was earned on. ADDITIVE:
-- earning_ledger is append-only with no PK re-grain, so a single ADD COLUMN
-- (no rebuild) is correct here. Every existing row homes to the default
-- (is_system) server via the DEFAULT, matching the Phase-2 backfill that
-- already homed all current data to 'server_spire_system'. With the servers
-- flag off, every credit derives server_id = room.serverId ?? the default,
-- so new rows land on the same server too — byte-identical ledger behavior.
--
-- The new composite index mirrors the (scope, owner_id, ...) read paths but
-- prefixes server_id so per-server pool reads stay a single index scan once
-- multiple servers exist. The legacy owner_time / reason indexes (0068-era)
-- stay in place for the cross-server / platform-wide audit queries.
ALTER TABLE `earning_ledger` ADD COLUMN `server_id` text NOT NULL DEFAULT 'server_spire_system';
--> statement-breakpoint
CREATE INDEX `earning_ledger_server_owner_time_idx`
  ON `earning_ledger` (`server_id`, `scope`, `owner_id`, `reason`, `created_at`);
