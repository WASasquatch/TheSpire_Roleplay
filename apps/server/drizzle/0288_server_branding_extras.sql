-- Servers Lift: richer per-server branding (additive, all nullable — flag-off
-- and every existing server are byte-identical until an owner sets these).
--
--   border_color         — owner-set accent ring around the server's rail icon,
--                          visible even on logo tiles (where icon_color, the
--                          lettered-tile fill, never shows).
--   horizontal_logo_url   — a WIDE wordmark logo that replaces the app's
--                          "The Spire" logo in the top bar while inside this
--                          server, so people always know which server they're on
--                          (distinct from logo_url, the square rail icon).
--   icon_crop / banner_crop — pan/zoom focus for the icon + banner images, the
--                          same AvatarCrop JSON shape user avatars use
--                          ({"zoom":n,"offsetX":n,"offsetY":n}). NULL = the
--                          identity crop (centered, no zoom). Supersedes the
--                          single-axis banner_focus_y for new positioning; the
--                          column stays for back-compat.
ALTER TABLE `servers` ADD COLUMN `border_color` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD COLUMN `horizontal_logo_url` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD COLUMN `icon_crop` text;
--> statement-breakpoint
ALTER TABLE `servers` ADD COLUMN `banner_crop` text;
