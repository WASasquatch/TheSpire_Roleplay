-- 0335: Server-level 18+ flag + public-safe banner (age plan, Phase 2).
--
-- Dark behind `serversEnabled` like every server feature. When a server is
-- 18+, minors cannot see or join it ANYWHERE (folded into
-- serverAuthority.canParticipate beside the moderation gate), and every
-- room inside it is effectively 18+ (`servers.is_nsfw OR rooms.is_nsfw`)
-- for join gates, listings, and message stamping. The system/default
-- server is locked SFW by invariant (route rejection + seed assertion) —
-- the official adult partition is a SIBLING "Spire NSFW" server stood up
-- by staff at the servers launch.
--
-- `sfw_banner_url` is the optional public-safe banner variant (policy
-- decision #10): surfaces visible to minors/anonymous/hide-pref viewers
-- (discovery cards, the /s/:slug share page, OG meta) render it instead of
-- the real banner art; NULL falls back to an art-less name/colors card.

ALTER TABLE servers ADD COLUMN is_nsfw INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE servers ADD COLUMN sfw_banner_url TEXT;
