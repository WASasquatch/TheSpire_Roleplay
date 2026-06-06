-- Opt-in splash stat: count of chat messages posted in the rolling
-- last 24 hours, rendered on both the AuthGate splash and the
-- marketing landing page.
--
-- Independent of `activityFeedsEnabled`. Each toggle gates its own
-- section of the splash stats row:
--   * `activityFeedsEnabled` → online/registered/room counters.
--   * `splashMessages24hEnabled` (this column) → 24h message count.
-- Either can be on alone; when both are on the splash renders them
-- in the same "· N stat" row so the cluster still reads as one beat.
-- This independence lets admins surface chat volume on its own (a
-- common "is this place active?" signal) without committing to the
-- broader user/room counter surface.
--
-- Default false so the new column is purely additive on existing
-- installs, admins flip it on once they're sure the count reads
-- as healthy on their community (an empty community surfacing
-- "0 messages in the last 24h" would telegraph dead-site, so the
-- opt-in posture matches the existing activityFeedsEnabled default).

ALTER TABLE `site_settings`
  ADD COLUMN `splash_messages_24h_enabled` INTEGER NOT NULL DEFAULT 0;
