-- Forums Phase 0: optional custom icon per thread category. Uploaded by
-- the forum owner (content-hashed, small square, same validation pipeline
-- as emoticons) for boards inside a forum; NULL = default glyph.
-- Standalone nested rooms keep NULL (no upload surface for them).
ALTER TABLE `room_thread_categories` ADD COLUMN `icon_url` text;
