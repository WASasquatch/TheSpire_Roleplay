-- Eidolon Tamer "visiting": let players pat each other's familiars (a small
-- +joy social gesture, 24h cooldown per visitor-user per target familiar).
-- One row per (visitor user, target familiar identity) holding the last pat
-- time. Keyed by the visitor's USER id so a user's multiple identities can't
-- each pat the same target; the route also forbids patting your own familiar.
CREATE TABLE IF NOT EXISTS eidolon_visits (
  visitor_user_id TEXT NOT NULL,
  target_owner_scope TEXT NOT NULL,
  target_owner_id TEXT NOT NULL,
  visited_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (visitor_user_id, target_owner_scope, target_owner_id)
);
