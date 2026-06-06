-- Per-identity Pet Collection, a 5-slot pinned showcase of pet
-- items the identity wants to display on their profile.
--
-- Twin of identity_collection (0096) with two design differences:
--   - 5 slots instead of 10 (pets are higher-investment / lower-
--     turnover than ordinary items, so the cap is tighter)
--   - Pinned items MUST have category='pet'. The PUT handler
--     (apps/server/src/routes/earning.ts) validates this against
--     the items table at write time; non-pet items get rejected
--     with a 403.
--
-- Same partitioning as the item collection, every identity (OOC
-- master AND each character) carries its own independent Pet
-- Collection. A character's profile shows that character's pets;
-- the OOC profile shows OOC's; they never merge or inherit. Pets
-- physically transfer between identities only via /give.
--
-- Slots are sparse: a user can pin slots 0, 2, 4 and leave 1 and 3
-- empty. The CHECK constraint guards 0..4 at the SQL layer, and
-- the route's zod validator mirrors it.

CREATE TABLE `identity_pet_collection` (
  `owner_scope` TEXT NOT NULL,
  `owner_id`    TEXT NOT NULL,
  `slot`        INTEGER NOT NULL CHECK (`slot` >= 0 AND `slot` < 5),
  `item_key`    TEXT NOT NULL REFERENCES `items`(`key`) ON DELETE CASCADE,
  `updated_at`  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`owner_scope`, `owner_id`, `slot`)
);
--> statement-breakpoint

CREATE INDEX `identity_pet_collection_owner_idx`
  ON `identity_pet_collection`(`owner_scope`, `owner_id`);
