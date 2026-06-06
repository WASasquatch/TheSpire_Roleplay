-- Avatar zoom / pan / crop on users + characters.
--
-- The avatar URL points at a (typically third-party hosted) source
-- image. Until now the displayed avatar was just `object-fit: cover`
-- centered, so the owner had no control over which part of a larger
-- source becomes the visible circle. These three columns let the
-- owner pick a focal point + zoom level via the profile editor's
-- new crop picker:
--
--   * avatar_zoom    , 1.0 = no zoom (source fits the circle the
--                       same way it always did); higher zooms in
--                       past the natural cover-fit. Clamped client +
--                       server side to [1.0, 4.0].
--   * avatar_offset_x, 0–100, percent. Maps to CSS object-position
--                       horizontal axis. 0 = far left of source
--                       visible, 100 = far right, 50 = centered.
--   * avatar_offset_y, same but vertical.
--
-- Defaults (zoom=1, x=50, y=50) reproduce the pre-feature behavior
-- exactly, every existing user keeps the centered-cover render they
-- had before the migration. No backfill needed.
--
-- Stored as floats so the picker can use sub-percent fidelity for
-- dragging; the rendering math doesn't care.

ALTER TABLE `users` ADD COLUMN `avatar_zoom` REAL NOT NULL DEFAULT 1.0;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `avatar_offset_x` REAL NOT NULL DEFAULT 50.0;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `avatar_offset_y` REAL NOT NULL DEFAULT 50.0;
--> statement-breakpoint

ALTER TABLE `characters` ADD COLUMN `avatar_zoom` REAL NOT NULL DEFAULT 1.0;
--> statement-breakpoint
ALTER TABLE `characters` ADD COLUMN `avatar_offset_x` REAL NOT NULL DEFAULT 50.0;
--> statement-breakpoint
ALTER TABLE `characters` ADD COLUMN `avatar_offset_y` REAL NOT NULL DEFAULT 50.0;
