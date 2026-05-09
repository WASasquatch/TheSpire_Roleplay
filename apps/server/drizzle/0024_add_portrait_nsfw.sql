-- Per-portrait NSFW flag. When set, viewers see the tile blurred with a
-- "Reveal" overlay; click reveals just that tile. Owner-set, public-render.
ALTER TABLE `character_portraits` ADD `nsfw` integer NOT NULL DEFAULT 0;
