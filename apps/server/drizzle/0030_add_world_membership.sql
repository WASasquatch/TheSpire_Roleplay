-- World membership. Users can join open worlds to declare an affiliation
-- ("my character is from this world"). Memberships are independent of room
-- access: anyone can play in a world-linked room without being a member, and
-- members of a world don't get any extra room privileges.
--
-- A user can belong to many worlds. Of those, at most one is `is_primary`,
-- which drives userlist grouping (members of the same primary world are
-- visually banded together in the chat userlist). All memberships, primary
-- or not, surface on the user's profile.
--
-- Joining is gated by world.visibility = 'open' in the route layer; the
-- table itself doesn't enforce that so admins/scripts can still poke it.
--
-- Also adds a `theme` column to worlds for per-world modal theming. The
-- theme JSON is the same shape as user/character themes; it's applied only
-- when rendering the world's editor and viewer modals - never bleeds into
-- chat or the userlist - so authors can give their wiki a custom look
-- without imposing it on everyone in chat.

CREATE TABLE `world_members` (
  `world_id` text NOT NULL,
  `user_id` text NOT NULL,
  `joined_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `is_primary` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`world_id`, `user_id`),
  FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);--> statement-breakpoint

-- Reverse lookup: "what worlds is this user a member of?" - the WorldsList
-- modal and userlist grouping both hit this path.
CREATE INDEX `world_members_user_idx` ON `world_members` (`user_id`);--> statement-breakpoint

-- Partial unique index enforces "at most one primary per user". Matches the
-- character system's at-most-one-active-character constraint.
CREATE UNIQUE INDEX `world_members_user_primary_uq`
  ON `world_members` (`user_id`)
  WHERE `is_primary` = 1;--> statement-breakpoint

-- Per-world theme JSON. Null = use the chat theme palette as a fallback so
-- existing worlds render correctly. Capped at the same byte length as user
-- themes via app-level validation.
ALTER TABLE `worlds` ADD COLUMN `theme` text;
