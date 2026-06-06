-- Flash sale system, one row per enabled category (name styles,
-- items, cosmetics) goes on sale daily. Random by default; admins
-- can queue a specific row for "tomorrow" via flash_sale_overrides,
-- consumed once on the next UTC-midnight rollover.
--
-- We use string YYYY-MM-DD UTC dates as primary keys instead of
-- unix-ms timestamps because (a) the rollover happens at UTC
-- midnight, so a string date is the natural key, and (b) it makes
-- the admin "queue for tomorrow" form trivial to validate
-- ("tomorrow >= today" is a string comparison once both are
-- ISO-formatted, no timezone math required).

CREATE TABLE IF NOT EXISTS `flash_sales` (
  -- 'YYYY-MM-DD' in UTC. Singleton row per day; written lazily on
  -- the first read of the day (the resolver picks, inserts, and
  -- returns in one transaction so concurrent first-readers don't
  -- race two random picks against each other).
  `for_date`                  TEXT    NOT NULL PRIMARY KEY,
  -- The picks for this day. NULL means "no row was eligible at
  -- pick time" (catalog empty for that category, or category
  -- disabled in settings when the resolver ran). Each FK uses
  -- ON DELETE SET NULL so a later catalog deletion doesn't 404
  -- the historical sale row.
  `name_style_key`            TEXT             REFERENCES `name_styles`(`key`)  ON DELETE SET NULL,
  `item_key`                  TEXT             REFERENCES `items`(`key`)        ON DELETE SET NULL,
  `cosmetic_key`              TEXT             REFERENCES `cosmetics`(`key`)    ON DELETE SET NULL,
  -- Effective discount applied to each pick. NULL = "use the
  -- global default" (site_settings.flash_sale_default_discount_pct).
  -- Non-null = either the admin override's per-pick discount or
  -- the global default snapshotted at pick time. Snapshotting
  -- means an admin tweak to the global default mid-day doesn't
  -- silently re-price an active sale.
  `name_style_discount_pct`   INTEGER,
  `item_discount_pct`         INTEGER,
  `cosmetic_discount_pct`     INTEGER,
  `created_at`                INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

-- Admin "queue for tomorrow" overrides. Inserted/updated via
-- /admin/earning/flash-sale; consumed by the daily resolver when
-- it picks for that date. We DON'T delete the row on consumption
-- so admins can see a historical record of what was scheduled and
-- why a specific row showed up on a specific date, the rolling
-- sweeper only reads `flash_sales` once that day's row exists.
CREATE TABLE IF NOT EXISTS `flash_sale_overrides` (
  -- 'name_style' | 'item' | 'cosmetic'. Keep the set extensible
  -- (no CHECK constraint) so a future "world tier" or "title"
  -- flash-sale category can be added without a schema change.
  `category`        TEXT    NOT NULL,
  `for_date`        TEXT    NOT NULL,   -- 'YYYY-MM-DD' UTC
  `target_key`      TEXT    NOT NULL,   -- catalog row key (validated app-side)
  -- Optional per-pick discount %. NULL = inherit from
  -- site_settings.flash_sale_default_discount_pct. Bounded to
  -- 1..99 by the admin route's zod schema; we don't enforce here
  -- so a future "100% off" giveaway is just a setting change away.
  `discount_pct`    INTEGER,
  `created_at`      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`category`, `for_date`)
);
--> statement-breakpoint

-- Site-level flash-sale settings. One default discount + a per-
-- category enable switch. Default ON for all three so the system
-- starts producing daily sales without further admin action.
ALTER TABLE `site_settings`
  ADD COLUMN `flash_sale_default_discount_pct` INTEGER NOT NULL DEFAULT 25;
--> statement-breakpoint
ALTER TABLE `site_settings`
  ADD COLUMN `flash_sale_styles_enabled` INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `site_settings`
  ADD COLUMN `flash_sale_items_enabled` INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `site_settings`
  ADD COLUMN `flash_sale_cosmetics_enabled` INTEGER NOT NULL DEFAULT 1;
