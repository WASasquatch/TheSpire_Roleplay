-- Site coach tour: per-user "seen version" for the first-run screen tour.
--
-- Mirrors the new-user welcome's re-show mechanism (users.welcome_seen_hash),
-- but the tour copy is client-hard-coded rather than admin-authored, so a
-- monotonic integer version is the natural lever. The server compares this
-- column against the shared SITE_TOUR_VERSION constant on /me/profile: when it
-- is lower, /me/profile reports showSiteTour:true and the client auto-opens the
-- tour once, then POST /me/tour/dismiss writes SITE_TOUR_VERSION back here.
--
-- Default 0 = "has never seen any tour" for every existing row, so all current
-- users see version 1 once on their next load. Bumping SITE_TOUR_VERSION later
-- re-shows the (revised) tour to everyone whose stored value is below the bump.

ALTER TABLE users ADD COLUMN tour_seen_version INTEGER NOT NULL DEFAULT 0;
