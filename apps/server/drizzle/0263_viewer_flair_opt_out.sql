-- Viewer-side flair opt-outs (migration 0263).
--
-- Account-wide, global toggles that let a user turn OFF rendering of OTHER
-- people's cosmetic flair FOR THEMSELVES — a performance escape hatch for
-- older hardware (animated name styles, ornate avatar borders, and inline
-- avatar thumbnails are the expensive bits when a busy chat feed or a long
-- userlist paints them all at once). These are purely client-render gates:
-- the data still exists and everyone else still sees the flair; only this
-- viewer's own UI renders the plain fallback.
--
-- All default 0 (= flair shown) so existing accounts are unchanged.
ALTER TABLE `users` ADD COLUMN `disable_name_styles` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `disable_border_styles` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `disable_inline_avatars` INTEGER NOT NULL DEFAULT 0;
