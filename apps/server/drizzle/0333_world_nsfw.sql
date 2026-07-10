-- 0333: Owner-set "18+ world" flag (age-restriction plan, Phase 4).
--
-- Worlds have a visibility tier (private/public/open) but no content
-- rating; this adds one. Orthogonal to `visibility` — an 18+ world can
-- still be private, public, or open AMONG ADULTS. When 1: hidden from the
-- catalog/browse listings for viewers who can't see NSFW, and the world
-- viewer + /w/:slug public page HARD-block minors and anonymous visitors.
-- Only adult owners may set it. Default 0 keeps every existing world
-- exactly as it is today.

ALTER TABLE worlds ADD COLUMN is_nsfw INTEGER NOT NULL DEFAULT 0;
