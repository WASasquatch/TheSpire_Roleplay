-- 0336: Whole-forum 18+ flag + public-safe banner (age plan, Phase 3).
--
-- A forum marked 18+ disappears from the forums catalog and discover
-- search for viewers who can't see NSFW; its /f/:slug public page behaves
-- like a non-public forum for minors/anonymous (teaser only, generic OG
-- meta); and every board inside inherits the gate. Board-level 18+ needs
-- no column here — boards ARE rooms, so 0331's `rooms.is_nsfw` covers
-- them. `sfw_banner_url` mirrors the server variant (0335): the optional
-- safe banner for public surfaces, NULL = art-less name/colors fallback.
-- Default 0 keeps every existing forum exactly as it is today.

ALTER TABLE forums ADD COLUMN is_nsfw INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE forums ADD COLUMN sfw_banner_url TEXT;
