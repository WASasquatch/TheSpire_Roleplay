-- Per-book "Buy a Copy" price. NULL = use the site default
-- (earningConfig.scriptorium.copyPrice). When set, the author chose a custom
-- price within the allowed bracket (STORY_COPY_PRICE_MIN..MAX in
-- packages/shared, enforced in the route layer). Read path everywhere is
-- `stories.copy_price ?? config default`, so existing rows (NULL) keep
-- selling at the current default with no backfill.
ALTER TABLE stories ADD COLUMN copy_price INTEGER;
