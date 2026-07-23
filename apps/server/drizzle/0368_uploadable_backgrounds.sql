-- In-app uploadable background art.
--
-- site_settings.bg_light_json / bg_dark_json: global-admin-uploaded site
-- background art (BackgroundArt JSON: {webpUrl, avifUrl, color}, variants
-- rendered server-side by images.ts). When set, replaces the built-in
-- Spire art on the splash pages and the glass chat shell for light/dark
-- palettes respectively. NULL = built-in art.
--
-- servers.background_json: per-server background override (same JSON
-- shape), uploaded by a server owner/admin with manage_appearance. Shows
-- on that server's glass chat shell (for members currently on the server)
-- and behind its public /s/ landing + invite splash; NSFW servers never
-- expose it on public surfaces.
ALTER TABLE site_settings ADD COLUMN bg_light_json text;
ALTER TABLE site_settings ADD COLUMN bg_dark_json text;
ALTER TABLE servers ADD COLUMN background_json text;
