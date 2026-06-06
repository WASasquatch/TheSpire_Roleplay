-- Site logo URL. When set, the banner + splash render an <img> in
-- place of the raw `siteName` text. Default points at the SPA-bundled
-- /thespire-logo.png (1580x446 PNG with alpha, sized for retina);
-- admins can swap it for a custom URL via /admin/settings, or upload
-- their own image via POST /admin/upload/logo which stores the file
-- under /uploads and persists the returned path here.
--
-- Empty string = no logo, fall back to the text title. Useful for
-- white-label installs that don't want an image header at all.
ALTER TABLE site_settings
  ADD COLUMN logo_url TEXT NOT NULL DEFAULT '/thespire-logo.png';
