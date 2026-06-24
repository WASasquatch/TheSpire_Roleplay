-- Room slugs (migration 0260).
--
-- Gives every room a short, URL-safe handle (e.g. "the-tavern") so it can be
-- deep-linked from chat / announcements via the {room:<slug>} UI-route chip,
-- mirroring how worlds already carry a slug. Nullable at the column level;
-- a one-shot boot backfill (lib/roomSlug.ts → backfillRoomSlugs) derives a
-- unique slug from each existing room's name, and new rooms get one at
-- create time. The partial unique index enforces global uniqueness on the
-- non-null values (case-insensitive) without tripping on the transient
-- nulls between the ADD COLUMN and the backfill.
ALTER TABLE rooms ADD COLUMN slug TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS rooms_slug_uq ON rooms (lower(slug)) WHERE slug IS NOT NULL;
