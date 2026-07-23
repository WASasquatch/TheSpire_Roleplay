-- Referrer host + PATH on raw page views, so the analytics admin can
-- expand a suspicious referrer DOMAIN down to the exact referring URLs
-- (phishing lures often sit at a telltale path). Query string + fragment
-- are always stripped before storage (that's where tokens / capability
-- URLs / PII live — plan_ext.md §7), so this holds the path only. Lives
-- ONLY on the raw, short-retention table (swept after
-- analyticsRawRetentionDays); never rolled into analytics_daily.
ALTER TABLE analytics_page_view ADD COLUMN ref_path text;
