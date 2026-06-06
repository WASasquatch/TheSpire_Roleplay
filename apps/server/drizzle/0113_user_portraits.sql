-- OOC profile gallery, same shape as character_portraits but
-- attached to the master account. Lets a user maintain a portrait
-- gallery on their OOC profile (avatar styles, art tags, OOC photos
--, whatever they want others to see on the master profile they
-- DON'T attach to any character).
--
-- Same column shape + index pattern as character_portraits for
-- consistency: id PK, url + optional label + sort_order + nsfw
-- flag. FK cascades on user delete so a wiped account doesn't
-- leave dangling gallery rows.

CREATE TABLE `user_portraits` (
  `id`         TEXT PRIMARY KEY,
  `user_id`    TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `url`        TEXT NOT NULL,
  `label`      TEXT,
  `sort_order` INTEGER NOT NULL DEFAULT 0,
  `nsfw`       INTEGER NOT NULL DEFAULT 0,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

CREATE INDEX `user_portraits_user_idx`
  ON `user_portraits`(`user_id`, `sort_order`);
