-- Per-identity public-profile background. When set, the profile
-- modal renders the given image on its backdrop (the area outside
-- the modal card) so a visitor landing on /p/<name> sees the
-- owner's chosen image instead of the default spire splash. The
-- modal card itself stays untouched — text remains readable; the
-- BG only paints in the "around the card" space.
--
-- Mirrored on both `users` (master profile) and `characters`
-- (per-character profile), since /p/<username> and /p/<character>
-- are separate viewer surfaces and admins/owners likely want
-- distinct moods per identity (a character's BG vs. the master
-- account's BG can be totally different).
--
-- `bg_url` is a free-form URL string — same shape as `avatar_url`
-- and other URL columns in this schema. Validation lives at the
-- API layer (PUT /me/profile + PUT /me/characters/:id). Empty
-- string is normalized to NULL there so "cleared" reads as a true
-- absence.
--
-- `bg_mode` selects the CSS background-size strategy:
--   "cover"    — image fills viewport, cropped to fit (default)
--   "contain"  — image fits inside viewport, letterboxed
--   "tile"     — image repeats to fill viewport
--   "stretch"  — image stretched to exact viewport dimensions
-- Default "cover" because it's the most forgiving for typical
-- landscape illustrations / photos and matches the existing splash
-- treatment.
--
-- Both columns NULLable so the click-to-close backdrop falls back
-- to its default `bg-black/40` overlay when the owner hasn't
-- opted in — additive, no client-visible change until the owner
-- saves a value.

ALTER TABLE `users`
  ADD COLUMN `public_profile_bg_url` TEXT;
--> statement-breakpoint

ALTER TABLE `users`
  ADD COLUMN `public_profile_bg_mode` TEXT NOT NULL DEFAULT 'cover';
--> statement-breakpoint

ALTER TABLE `characters`
  ADD COLUMN `public_profile_bg_url` TEXT;
--> statement-breakpoint

ALTER TABLE `characters`
  ADD COLUMN `public_profile_bg_mode` TEXT NOT NULL DEFAULT 'cover';
