-- Per-identity opt-in to surface the main profile image as the
-- first tile in the profile's portrait gallery.
--
-- Why this exists: the avatar (hero portrait in the modal +
-- userlist icon) used to be a separate "primary" image with no
-- way to also expose it in the gallery row. Some users want
-- visitors to see the avatar as part of the same scrollable
-- gallery as the rest of their artwork, without duplicating the
-- URL into a real character_portraits / user_portraits row
-- (which would dangle a stale copy whenever they later change
-- the avatar).
--
-- Implementation: a boolean flag on each identity's row. When
-- true and the avatar URL is set, the profile-lookup path
-- prepends a synthetic gallery entry (id = "avatar") in front of
-- the real portraits array. The flag costs one column on each
-- table; the synthetic entry costs nothing at rest.
--
-- Default false on existing rows so a deploy doesn't silently
-- start showing avatars in galleries for users who never opted
-- in. Users tick the new "Include in Gallery" checkbox in the
-- profile editor's Avatar section to enable.

ALTER TABLE `users`
  ADD COLUMN `include_avatar_in_gallery` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE `characters`
  ADD COLUMN `include_avatar_in_gallery` INTEGER NOT NULL DEFAULT 0;
