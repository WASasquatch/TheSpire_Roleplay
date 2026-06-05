-- Two new Flair cosmetics for profile customization:
--
--   `flair_profile_visitors` — purchase to unlock a visitors-count
--     widget that shows on YOUR profile a tally of distinct viewers
--     split by members vs. anonymous external traffic. View logging
--     is always-on (so the counter has data the moment the owner
--     equips the flair); the widget itself only renders when the
--     owner has bought the flair AND toggled it visible.
--
--   `flair_profile_marquee` — purchase to unlock a rotating-quote
--     marquee strip on YOUR profile, between the header and the
--     bio. Owner can configure up to 10 quotes (Markdown / basic
--     HTML); the strip rotates one-at-a-time with a fade transition
--     and a dot selector below the text. Mirrors the sitewide
--     announcement marquee's visual language but renders in the
--     profile owner's theme.
--
-- Schema additions:
--
--   `profile_views` (new) — append-only log of one row per UNIQUE
--     (viewer, profile, day) tuple. Members fingerprint as their
--     userId; anonymous viewers as a hash of (ip || userAgent), so
--     the same logged-out viewer hitting the same profile twice in
--     one day counts as one. The day_bucket is a UNIX-day integer
--     (floor(ms / 86_400_000)) so dedupe + aggregate queries are
--     plain integer comparisons.
--
--   `profile_marquee_quotes_json` (added on `user_earning` AND
--     `character_earning`) — JSON array of strings, one per quote.
--     Hard cap of 10 rows enforced application-side; per-quote
--     length cap also enforced application-side. NULL = no quotes
--     configured yet; empty array also valid.
--
--   `show_profile_visitors_count` (added on `user_earning` AND
--     `character_earning`) — owner's "display this counter on my
--     profile" toggle. Independent of ownership: a flair owner who
--     hasn't toggled it on doesn't surface the counter publicly.
--
-- Per-identity partition: same posture as `flair_profile_banner` and
-- friends. A character can own + configure these independently from
-- the master, and OOC/master profiles read the user_earning row
-- while character profiles read character_earning.

-- Visitors log ---------------------------------------------------

CREATE TABLE IF NOT EXISTS profile_views (
  id TEXT PRIMARY KEY,
  -- The profile being viewed. ALWAYS the master userId — the actual
  -- identity is the (user, character) pair below. Cascading delete
  -- so a hard-delete clears the user's view history with them.
  profile_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NULL = the master/OOC profile was viewed. Non-null = a specific
  -- character profile. SET NULL on character delete so a viewed
  -- character's deletion preserves the count under the master row.
  profile_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  -- Signed-in viewer (NULL = anonymous). SET NULL on viewer delete
  -- so historical counts don't dangle if the viewer's account is
  -- hard-deleted later — the row still contributes to the total.
  viewer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- Dedupe key: `userId#m` for members on a master profile,
  -- `userId#c:<charId>` for members on a character profile, and
  -- the parallel `anon:<hash>#…` for anonymous viewers. Embedding
  -- the profile-character distinction in the viewer_key sidesteps
  -- SQLite's NULL-distinct-from-NULL uniqueness semantics on
  -- profile_character_id — a single column carrying everything the
  -- UNIQUE constraint needs to read.
  viewer_key TEXT NOT NULL,
  -- floor(created_at / 86_400_000) — UNIX day index. Dedupes
  -- to one view per (viewer, profile) per day so a viewer
  -- F5-ing a profile doesn't inflate the count.
  day_bucket INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  -- All three columns NOT NULL → `INSERT OR IGNORE` cleanly
  -- collapses a same-day re-view without an application-side
  -- existence check. `profile_character_id` is intentionally NOT
  -- in the unique key (the distinction is baked into viewer_key)
  -- because nullable columns in a SQLite UNIQUE silently break
  -- dedupe — NULL is treated as distinct from every other NULL.
  UNIQUE(profile_user_id, viewer_key, day_bucket)
);
CREATE INDEX IF NOT EXISTS profile_views_profile_idx
  ON profile_views(profile_user_id, profile_character_id);
CREATE INDEX IF NOT EXISTS profile_views_day_idx
  ON profile_views(day_bucket);

-- Marquee + visitors columns on the per-identity earning rows -----

ALTER TABLE `user_earning`
  ADD COLUMN `profile_marquee_quotes_json` TEXT;
ALTER TABLE `user_earning`
  ADD COLUMN `show_profile_visitors_count` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `character_earning`
  ADD COLUMN `profile_marquee_quotes_json` TEXT;
ALTER TABLE `character_earning`
  ADD COLUMN `show_profile_visitors_count` INTEGER NOT NULL DEFAULT 0;

-- Seed the two new Flair catalog rows. Costs are placeholders the
-- admin can tune via the Flair admin tab — set above the existing
-- typing-phrase (1500) but below the freeform-border tier, so the
-- relative pricing reads as a meaningful upgrade rather than impulse
-- purchase.
INSERT OR IGNORE INTO `cosmetics`
  (`key`, `name`, `description`, `cost`, `enabled`, `config_json`)
VALUES
  ('flair_profile_visitors',
   'Profile Visitor Counter',
   'Unlock a "Profile Visitors" widget that shows distinct daily viewers split into members vs. external traffic.',
   2000,
   1,
   NULL);

INSERT OR IGNORE INTO `cosmetics`
  (`key`, `name`, `description`, `cost`, `enabled`, `config_json`)
VALUES
  ('flair_profile_marquee',
   'Profile Quote Marquee',
   'Adds a rotating quote strip to your profile under the header. Configure up to 10 short quotes (Markdown supported).',
   3000,
   1,
   NULL);
