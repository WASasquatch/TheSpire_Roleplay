-- 0309: SEO management settings for the Branding admin.
--
-- Adds the site-settings columns backing the new Branding → SEO tools:
--   * og_image_url             default social-card image (og:image / twitter:image fallback)
--   * homepage_tagline         appended after the site name in the homepage/login/register <title>
--   * seo_keywords             keyword shelf; falls back to the built-in default when empty
--   * google_site_verification google-site-verification content token
--   * bing_site_verification   msvalidate.01 content token
--   * search_indexing_enabled  master noindex switch; false emits Disallow: / + robots noindex
--   * social_profile_urls      newline-separated URLs mapped into Organization.sameAs
--
-- Additive only: every column has a safe default so existing installs keep
-- byte-identical behavior (indexing stays ON, no tagline/keyword override).

ALTER TABLE site_settings ADD COLUMN og_image_url TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE site_settings ADD COLUMN homepage_tagline TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE site_settings ADD COLUMN seo_keywords TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE site_settings ADD COLUMN google_site_verification TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE site_settings ADD COLUMN bing_site_verification TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE site_settings ADD COLUMN search_indexing_enabled INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE site_settings ADD COLUMN social_profile_urls TEXT NOT NULL DEFAULT '';
