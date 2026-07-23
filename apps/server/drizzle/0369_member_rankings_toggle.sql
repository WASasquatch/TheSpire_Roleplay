-- Homepage member-rankings marquee toggle (Admin → Settings → Homepage).
-- Gates the splash "Our members" section (rotating leaderboards + the
-- featured-member spotlight) and its nav tab. ON by default: it only
-- ever shows public or identity-masked data, and the point of the
-- feature is to show members off without an extra admin visit.
ALTER TABLE site_settings ADD COLUMN member_rankings_enabled integer NOT NULL DEFAULT 1;
