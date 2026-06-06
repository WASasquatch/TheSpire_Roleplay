-- Forum-pagination page-size setting.
--
-- The forum view used to be cursor-paginated ("Load older" with a
-- `before=<lastActivityAt>` cursor). That worked but gave readers no
-- sense of "where am I in this category", every click was just
-- another opaque batch of older threads. Discrete numbered pagination
-- (Prev / 1 2 3 … / Next) needs a stable per-category page size that
-- admins can tune to match their community's posting cadence.
--
-- 20 is the default, mirroring the previous server-side `limit ?? 20`
-- fallback so deploying this migration changes nothing about page
-- shape until an admin actively raises or lowers it. The route enforces
-- the bounds (5..100) at the handler layer; the column itself is just
-- the stored value.

ALTER TABLE `site_settings`
  ADD COLUMN `forum_topics_per_page` INTEGER NOT NULL DEFAULT 20;
