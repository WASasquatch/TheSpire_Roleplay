-- Let Lore pages belong to an arc too (entities already got arc_id in 0211).
-- Nullable, no FK; routes validate the arc belongs to the same world. The
-- applier baselines "duplicate column name" so re-runs are safe.
ALTER TABLE world_pages ADD COLUMN arc_id TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS world_pages_arc_idx ON world_pages (world_id, arc_id);
