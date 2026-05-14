-- World catalog metadata. Adds the fields needed to make the worlds
-- list filterable and decision-supporting (genre/tags/content warnings),
-- featured curation (status), and visual identity (cover image).
--
-- All columns are additive with defaults so existing rows survive
-- without backfill. Genre + status validate as enums-by-convention at
-- the Zod layer (mirrors how `rooms.replyMode` is enforced).
--
-- Tags and content_warnings are flat comma-separated strings. A
-- junction table would be overkill at this scale, and seeding 25
-- default worlds with 3-5 tags each is much cleaner as inline data
-- than as 100+ extra INSERTs across migrations.
ALTER TABLE worlds ADD COLUMN genre TEXT NOT NULL DEFAULT 'other';
ALTER TABLE worlds ADD COLUMN tags TEXT NOT NULL DEFAULT '';
ALTER TABLE worlds ADD COLUMN content_warnings TEXT NOT NULL DEFAULT '';
ALTER TABLE worlds ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE worlds ADD COLUMN cover_image_url TEXT;
ALTER TABLE worlds ADD COLUMN pacing TEXT;
CREATE INDEX worlds_genre_idx ON worlds (genre);
CREATE INDEX worlds_status_idx ON worlds (status);
