-- Raise the historical-XP backfill rate from the original seed value
-- (1 XP / message) to 5 XP / message. The system gets dropped onto
-- installs that already have months / years of message history, and
-- 1 XP/message was too thin to put longtime regulars anywhere near
-- the (now-raised) rank thresholds, a 5000-post regular landed in
-- the bottom of New Arrival, which under-reads their actual activity.
-- At 5/msg the same regular lands roughly at the bottom of
-- Recognized, proportional to the time they've put in.
--
-- Gated so we only touch installs that:
--   1. Still hold the 1.0 seed value (admin hasn't tuned it).
--   2. Haven't yet RUN the backfill (`completedAt` is null), once a
--      backfill has executed, the historical XP is already booked
--      and changing the rate retroactively would either double-credit
--      on a re-run or leave the rate cosmetically inconsistent with
--      what was actually awarded. The boot-time backfill checker
--      sees the new rate on the next start and proceeds with 5/msg.
--
-- Uses SQLite's json_set / json_extract (json1 extension, available
-- in every better-sqlite3 build we ship).
UPDATE site_settings
SET earning_config_json = json_set(
      earning_config_json,
      '$.backfill.xpPerHistoricalMessage',
      5
    )
WHERE id = 'singleton'
  AND earning_config_json IS NOT NULL
  AND json_extract(earning_config_json, '$.backfill.completedAt') IS NULL
  AND json_extract(earning_config_json, '$.backfill.xpPerHistoricalMessage') = 1;
