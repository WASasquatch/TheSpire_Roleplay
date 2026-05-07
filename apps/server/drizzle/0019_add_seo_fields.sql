-- SEO + analytics surface area on site_settings.
--
-- meta_description is rendered server-side into <meta name="description"> +
-- the OG/Twitter card descriptions on the splash page so non-JS crawlers
-- get a real summary. Capped at the same ~155-char rule of thumb search
-- engines display, but stored as text since admins may exceed it.
--
-- custom_head_html is verbatim raw HTML injected into <head> right before
-- </head> on the server-rendered splash response. The intended use is
-- analytics tags (Plausible, GA4, Cloudflare, Umami, etc.) which the
-- admin pastes from their provider's dashboard. Admin-only, so we do NOT
-- sanitize - sanitizing analytics scripts would defeat the purpose.

ALTER TABLE `site_settings` ADD `meta_description` text NOT NULL DEFAULT 'A roleplay-focused chat sanctuary. Build characters, share scenes, and tell collaborative stories with other writers.';
--> statement-breakpoint
ALTER TABLE `site_settings` ADD `custom_head_html` text NOT NULL DEFAULT '';
