-- 0334: Minor isolation mode — "opt out of adults" (age plan, Phase 5).
--
-- Per-minor OPT-IN. When 1 AND the account is still under 18, the account
-- and every adult non-staff account behave as if MUTUALLY blocked (chat,
-- presence, whispers, DMs, friends, profiles, search, forums,
-- notifications) — enforced by auth/ageIsolation.ts alongside the existing
-- block predicates. Site staff (mod/admin/masteradmin) are exempt in both
-- directions so moderation and help stay reachable. The predicate also
-- requires isMinor, so the mode goes INERT automatically on the 18th
-- birthday without any write. Rejected server-side for adult accounts;
-- default 0 (off) for everyone.

ALTER TABLE users ADD COLUMN isolate_from_adults INTEGER NOT NULL DEFAULT 0;
