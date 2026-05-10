-- Profile visibility + NSFW gating.
--
--   is_public:  When true (default), the profile is visible to anonymous
--               (logged-out) viewers via /profiles/:name. When false, only
--               the owner + admins + (for OOC discovery flows) authenticated
--               viewers can see it. Lets users opt out of having their
--               profile in the open web index.
--
--   is_nsfw:    When true, the profile is force-private to anonymous
--               viewers regardless of is_public, AND logged-in viewers see
--               a warning splash with a "View Profile" button before the
--               content renders. A pre-gate to whole-profile NSFW content
--               (which is independent of the per-portrait nsfw flag we
--               already shipped, used for blurring individual gallery
--               images on a SFW profile).
--
-- Default for is_public is 1 (true) so existing profiles stay visible
-- after the migration; users opt out per-profile if they prefer.
-- Default for is_nsfw is 0 (false) so existing profiles aren't suddenly
-- gated.
--
-- Both flags exist on `users` (master profile) and `characters` (per-
-- character profile) - users can mark some characters NSFW while keeping
-- their OOC master profile SFW, or vice versa.

ALTER TABLE `users` ADD COLUMN `is_public` integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `is_nsfw` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `characters` ADD COLUMN `is_public` integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE `characters` ADD COLUMN `is_nsfw` integer NOT NULL DEFAULT 0;
