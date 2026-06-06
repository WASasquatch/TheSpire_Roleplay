-- Per-identity inventory rows. Every identity (OOC master OR an
-- individual character) holds its own inventory; nothing is shared
-- across identities. A user with the OOC master + three characters
-- has FOUR fully independent inventories, currency pools, and (once
-- Phase 3 lands) Collection showcases. Same partitioning pattern as
-- `character_owned_name_styles` / `character_owned_borders`.
--
-- One row per (identity, item_key). Rows are deleted entirely when
-- quantity drops to 0, empty stacks don't linger.

CREATE TABLE `identity_inventory` (
  `owner_scope`  TEXT NOT NULL,
  `owner_id`     TEXT NOT NULL,
  `item_key`     TEXT NOT NULL REFERENCES `items`(`key`) ON DELETE CASCADE,
  `quantity`     INTEGER NOT NULL DEFAULT 0,
  `acquired_at`  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at`   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`owner_scope`, `owner_id`, `item_key`)
);
--> statement-breakpoint

CREATE INDEX `identity_inventory_owner_idx`
  ON `identity_inventory`(`owner_scope`, `owner_id`);
--> statement-breakpoint

CREATE INDEX `identity_inventory_item_idx`
  ON `identity_inventory`(`item_key`);
