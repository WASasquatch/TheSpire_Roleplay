-- Servers Lift — per-server earning CATALOGS, part 5 of 5: COSMETICS + FLASH SALES.
--
-- Final three catalog tables go per-server. Same house rebuild idiom as
-- 0283/0284/0285; one file = one transaction. Every existing row homes to
-- 'server_spire_system', so The Spire's cosmetics catalog and its scheduled
-- flash sales are unchanged.
--
--   cosmetics            -> PK (server_id, key). FK-free as a parent EXCEPT for
--                           flash_sales.cosmetic_key (handled below). Simple
--                           single-table rebuild like the pools.
--   flash_sales          -> add server_id, PK (server_id, for_date). Its four
--                           catalog FKs (name_style_key/item_key/cosmetic_key/
--                           freeform_border_key, all ON DELETE SET NULL) are
--                           DROPPED: each pointed at a now-composite-PK catalog,
--                           and SET NULL can't be composed (it would null the
--                           NOT NULL server_id). The columns stay as plain text;
--                           the resolver validates the picked SKU against the
--                           live catalog when it materializes a day's sale.
--   flash_sale_overrides -> add server_id. NOTE: the live PK is (category,
--                           for_date) — NOT (for_date) — so the per-day-per-
--                           category invariant is preserved by widening to
--                           (server_id, category, for_date). targetKey has no
--                           FK, so nothing else changes.
--
-- The runner runs with foreign_keys = OFF so the interim DROP of cosmetics
-- (referenced by flash_sales until that table is rebuilt) is safe.

-- ============================================================
-- cosmetics -> PK (server_id, key)
-- ============================================================
CREATE TABLE `cosmetics_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `key` text NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `cost` integer NOT NULL DEFAULT 0,
  `enabled` integer NOT NULL DEFAULT 1,
  `config_json` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `key`)
);
--> statement-breakpoint
INSERT INTO `cosmetics_new` (
  `server_id`, `key`, `name`, `description`, `cost`, `enabled`, `config_json`,
  `created_at`, `updated_at`
)
SELECT
  'server_spire_system', `key`, `name`, `description`, `cost`, `enabled`, `config_json`,
  `created_at`, `updated_at`
FROM `cosmetics`;
--> statement-breakpoint
DROP TABLE `cosmetics`;
--> statement-breakpoint
ALTER TABLE `cosmetics_new` RENAME TO `cosmetics`;
--> statement-breakpoint

-- ============================================================
-- flash_sales -> add server_id, PK (server_id, for_date); drop 4 catalog FKs
-- ============================================================
CREATE TABLE `flash_sales_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `for_date` text NOT NULL,
  `name_style_key` text,
  `item_key` text,
  `cosmetic_key` text,
  `freeform_border_key` text,
  `name_style_discount_pct` integer,
  `item_discount_pct` integer,
  `cosmetic_discount_pct` integer,
  `freeform_border_discount_pct` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `for_date`)
);
--> statement-breakpoint
INSERT INTO `flash_sales_new` (
  `server_id`, `for_date`, `name_style_key`, `item_key`, `cosmetic_key`,
  `freeform_border_key`, `name_style_discount_pct`, `item_discount_pct`,
  `cosmetic_discount_pct`, `freeform_border_discount_pct`, `created_at`
)
SELECT
  'server_spire_system', `for_date`, `name_style_key`, `item_key`, `cosmetic_key`,
  `freeform_border_key`, `name_style_discount_pct`, `item_discount_pct`,
  `cosmetic_discount_pct`, `freeform_border_discount_pct`, `created_at`
FROM `flash_sales`;
--> statement-breakpoint
DROP TABLE `flash_sales`;
--> statement-breakpoint
ALTER TABLE `flash_sales_new` RENAME TO `flash_sales`;
--> statement-breakpoint

-- ============================================================
-- flash_sale_overrides -> add server_id, PK (server_id, category, for_date)
-- ============================================================
CREATE TABLE `flash_sale_overrides_new` (
  `server_id` text NOT NULL DEFAULT 'server_spire_system',
  `category` text NOT NULL,
  `for_date` text NOT NULL,
  `target_key` text NOT NULL,
  `discount_pct` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `category`, `for_date`)
);
--> statement-breakpoint
INSERT INTO `flash_sale_overrides_new` (
  `server_id`, `category`, `for_date`, `target_key`, `discount_pct`, `created_at`
)
SELECT
  'server_spire_system', `category`, `for_date`, `target_key`, `discount_pct`, `created_at`
FROM `flash_sale_overrides`;
--> statement-breakpoint
DROP TABLE `flash_sale_overrides`;
--> statement-breakpoint
ALTER TABLE `flash_sale_overrides_new` RENAME TO `flash_sale_overrides`;
