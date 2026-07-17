-- Per-user display timezone.
--
-- An optional IANA timezone name (e.g. "America/New_York") the user picks in
-- Settings; NULL means "use the browser's own timezone" (the prior behavior,
-- and the default for every existing account). It controls only how dates and
-- times are RENDERED for that user across the app — stored timestamps stay
-- absolute ms epochs. Mirrors the per-user `locale` column (migration 0338).
ALTER TABLE users ADD COLUMN timezone text;
