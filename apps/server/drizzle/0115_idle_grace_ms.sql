-- How long a user lingers in the userlist as "idle" after their last
-- socket disconnects (tab close, refresh, network drop). Default 30
-- minutes. Within this window:
--   * The user keeps a ghost row in the userlist tagged `idle: true`
--     (rendered faded with an "(idle)" suffix), so chat onlookers
--     don't see them flicker in and out for transient disconnects.
--   * No "X has disconnected." chat broadcast fires.
--   * A reconnect inside the window suppresses the "X has connected."
--     announcement too, the rejoin is silent end-to-end.
--   * The room they were in is held open against expireIfEmpty so a
--     single-occupant private room doesn't archive while the ghost
--     is still holding it.
--
-- The 30-minute default overrides the long sliding sessionTtlMs (30
-- days by default) for *visible-presence* purposes only. Session
-- validity itself is untouched, a user who returns inside the
-- session TTL still resumes without re-login regardless of how long
-- the ghost has been gone.
--
-- Capped at 24h on the admin route; raise here too if that ever
-- changes.

ALTER TABLE `site_settings`
  ADD COLUMN `idle_grace_ms` INTEGER NOT NULL DEFAULT 1800000;
