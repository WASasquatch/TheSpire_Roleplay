-- Marker label display modes. `label_mode` controls how a marker renders
-- its label on the map stage: 'icon' (glyph pin only — the pre-existing
-- behavior, kept by every old row via the default), 'text' (label text
-- only, no glyph), or 'both' (glyph pin with the label text under it).
-- Entry images need no schema change: `world_entities.image_url` has
-- existed since migration 0211.
ALTER TABLE `world_map_markers` ADD COLUMN `label_mode` text NOT NULL DEFAULT 'icon';
