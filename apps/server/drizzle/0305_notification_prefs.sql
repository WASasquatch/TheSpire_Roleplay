-- 0305: Notification Center per-user preferences.
--
-- JSON { mutedCategories: NotificationCategory[] } — categories the user has
-- silenced get no inbox row, badge, or push. NULL = nothing muted. Additive,
-- flag-off-inert (the engine treats NULL as "all categories on").

ALTER TABLE users ADD COLUMN notification_prefs_json TEXT;
