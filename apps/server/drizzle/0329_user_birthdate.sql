-- 0329: Age foundation (age-restriction plan, Phase 0).
--
-- `birthdate` is the ONLY stored age signal: ISO YYYY-MM-DD, collected at
-- both signup paths from now on. NULL = legacy account registered before
-- this feature; every one of those attested "I am 18 or older" at signup,
-- so the derivation helper (auth/ageGate.ts) treats NULL as adult. Adult /
-- minor is always COMPUTED from this column at read time (UTC, date-only) —
-- no stored boolean, so a 17-year-old graduates automatically on their 18th
-- birthday with nothing to flip.
--
-- `hide_nsfw` is the adult soft preference ("Hide 18+ content"): it feeds
-- canSeeNsfw() for the SOFT listing/search/discovery filters only. Default
-- 0 (show) because every existing account attested 18+ and today's behavior
-- must not change on deploy. For minors the value is irrelevant — canSeeNsfw
-- is false for them regardless.

ALTER TABLE users ADD COLUMN birthdate TEXT;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN hide_nsfw INTEGER NOT NULL DEFAULT 0;
