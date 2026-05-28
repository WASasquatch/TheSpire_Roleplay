-- Extend the flash sale system to cover free-form borders. Mirrors
-- the existing name_style / item / cosmetic columns: one extra
-- target-key column on `flash_sales`, one extra discount column,
-- and one site-settings enable toggle.
--
-- The `flash_sale_overrides.category` column is already
-- unconstrained TEXT (no CHECK), so the admin route can accept
-- 'freeform_border' as a new category without a schema change to
-- that table.

ALTER TABLE `flash_sales`
  ADD COLUMN `freeform_border_key` TEXT
    REFERENCES `freeform_borders`(`key`) ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE `flash_sales`
  ADD COLUMN `freeform_border_discount_pct` INTEGER;
--> statement-breakpoint

-- Default ON so the system starts featuring a daily border without
-- further admin action; admins can disable per-category any time.
ALTER TABLE `site_settings`
  ADD COLUMN `flash_sale_freeform_borders_enabled` INTEGER NOT NULL DEFAULT 1;
