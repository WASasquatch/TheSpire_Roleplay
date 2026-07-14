-- Themed "container" embed messages.
--
-- `/container <style> [color]` posts a Discord-embed-style block whose
-- multi-line body is rendered inside a themed card. Two sparse columns carry
-- the presentation, frozen at send time (same posture as scene_image_url):
--   container_style  one of solid | glass | parchment | bokeh | gradient
--   container_color  optional accent KEYWORD (alert | green | purple | ...),
--                    resolved to a hue per VIEWER at render so the block
--                    re-themes when a viewer switches palette; NULL = theme
--                    default accent.
--
-- Sparse by design: only `kind = 'container'` rows populate these; every
-- other kind leaves them NULL (one byte each in SQLite's row header). The
-- `kind` column is an application-level enum with no DB CHECK constraint, so
-- adding the new 'container' value needs no schema change here.
ALTER TABLE messages ADD COLUMN container_style TEXT;
--> statement-breakpoint
ALTER TABLE messages ADD COLUMN container_color TEXT;
