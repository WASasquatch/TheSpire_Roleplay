-- Spire Arcade, game #1: the Eidolon Tamer (a Tamagotchi-style familiar).
--
-- Per-identity save, same (owner_scope, owner_id) partition as
-- identity_inventory / game_stats, so a master account and each
-- character raise independent familiars feeding from their own currency
-- + inventory. Server-authoritative: decay is recomputed from
-- (now - last_seen_ms) on every read, so we never write per tick. A
-- missing row means "never hatched" -> the client shows egg-select.
CREATE TABLE `eidolon_state` (
  `owner_scope` TEXT NOT NULL,
  `owner_id` TEXT NOT NULL,
  `stage` TEXT NOT NULL DEFAULT 'alive',
  `kind` TEXT NOT NULL DEFAULT 'species',
  `species_id` TEXT,
  `pet_item_key` TEXT REFERENCES `items`(`key`) ON DELETE SET NULL,
  `name` TEXT NOT NULL DEFAULT '',
  `satiety` REAL NOT NULL DEFAULT 80,
  `joy` REAL NOT NULL DEFAULT 75,
  `vigor` REAL NOT NULL DEFAULT 85,
  `hygiene` REAL NOT NULL DEFAULT 80,
  `health` REAL NOT NULL DEFAULT 100,
  `sick` INTEGER NOT NULL DEFAULT 0,
  `asleep` INTEGER NOT NULL DEFAULT 0,
  `age_hours` REAL NOT NULL DEFAULT 0,
  `sim_hour` REAL NOT NULL DEFAULT 8,
  `mess_count` INTEGER NOT NULL DEFAULT 0,
  `last_seen_ms` INTEGER NOT NULL DEFAULT 0,
  `hatched_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`owner_scope`, `owner_id`)
);
--> statement-breakpoint
-- The one-time unlock, sold as a Flair in the Earning shop. Bought via
-- the standard /earning/me/cosmetics/:key/purchase flow (the key is also
-- added to PURCHASABLE_COSMETIC_KEYS); ownership = a
-- purchase_flair_eidolon_tamer ledger row, per identity. Cost is a
-- starting point; admins can retune it from the Flair admin panel.
INSERT OR IGNORE INTO `cosmetics` (`key`, `name`, `description`, `cost`, `enabled`)
VALUES (
  'flair_eidolon_tamer',
  'Eidolon Tamer',
  'Unlock the Eidolon Tamer in the Spire Arcade - raise a gothic familiar that lives in a window above your chat.',
  2500,
  1
);
