-- Per-user toggles for the three in-app sound effects. Audio is on by
-- default — opt out, not opt in — matching the existing user pattern
-- for notifyPref (where the default is "mentions", not "off").
--
--   sound_dm_enabled    — ping.mp3 on inbound DMs
--   sound_chat_enabled  — tap.mp3 on inbound chat messages + actions
--   sound_alert_enabled — alert.mp3 on announcements / system events
ALTER TABLE users ADD COLUMN sound_dm_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN sound_chat_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN sound_alert_enabled INTEGER NOT NULL DEFAULT 1;
