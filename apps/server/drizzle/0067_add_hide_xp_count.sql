-- Per-user XP privacy toggle on user_standing.
--
-- Mirrors `hide_currency_count` (added in 0063). When set, the
-- /standing/users/:id public-slice endpoint returns null for `xp`
-- so other users see "private" instead of the number. Self always
-- sees own. Rank/tier/sigil stay public regardless — rank is the
-- public identity tag.
ALTER TABLE user_standing
  ADD COLUMN hide_xp_count INTEGER NOT NULL DEFAULT 0;
