-- 0321: Per-surface contextual tour tracking.
--
-- The site tour (migration 0312) is a single account-wide `tour_seen_version`
-- on `users`. Contextual tours are many, each gated independently: one row per
-- (user, tour) with its own monotonic `seen_version`. The server compares each
-- catalog version (shared TOURS[id].version) against the stored seen_version
-- and reports the ids that are still behind as `toursToShow` on /me/profile;
-- POST /me/tours/:tourId/dismiss upserts the current version + dismissed_at so
-- that tour stops re-showing until it is bumped. Absent row => seen_version 0
-- (never seen). Additive; nothing reads it until the tours feature ships.
CREATE TABLE tour_seen (
  user_id TEXT NOT NULL,
  tour_id TEXT NOT NULL,
  seen_version INTEGER NOT NULL DEFAULT 0,
  dismissed_at INTEGER,
  PRIMARY KEY (user_id, tour_id)
);
