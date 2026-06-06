-- Per-identity Collection, a 10-slot pinned showcase of inventory
-- items the identity wants to display on their profile. Same
-- partitioning model as identity_inventory: every identity (OOC
-- master AND each character) carries its own independent Collection.
-- A character's profile shows that character's pins, the OOC
-- profile shows the OOC's pins, and the two never merge or inherit.
--
-- Slots are sparse: a user can pin to slots 0, 3, and 7 and leave
-- the rest empty. The 10-slot cap is enforced by the (owner_scope,
-- owner_id, slot) PK plus the CHECK constraint below, the server
-- additionally validates the pinned item is still owned in the
-- same identity's inventory before writing.

CREATE TABLE `identity_collection` (
  `owner_scope` TEXT NOT NULL,
  `owner_id`    TEXT NOT NULL,
  `slot`        INTEGER NOT NULL CHECK (`slot` >= 0 AND `slot` < 10),
  `item_key`    TEXT NOT NULL REFERENCES `items`(`key`) ON DELETE CASCADE,
  `updated_at`  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`owner_scope`, `owner_id`, `slot`)
);
--> statement-breakpoint

CREATE INDEX `identity_collection_owner_idx`
  ON `identity_collection`(`owner_scope`, `owner_id`);
