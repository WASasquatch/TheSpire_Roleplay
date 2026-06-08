-- World knowledge base: typed entries (Locations, NPCs, Items/Codex, Factions,
-- and owner-defined custom kinds), mirroring the Scriptorium codex. The "Lore"
-- type stays the existing world_pages tree. `arc_id` is added now (nullable, no
-- FK) so the later arcs migration doesn't have to ALTER this table; route
-- handlers validate that an arc belongs to the same world.
CREATE TABLE IF NOT EXISTS world_entities (
  id TEXT PRIMARY KEY NOT NULL,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  stats_json TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  arc_id TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS world_entities_world_kind_slug_uq ON world_entities (world_id, kind, lower(slug));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS world_entities_order_idx ON world_entities (world_id, kind, sort_order);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS world_entities_arc_idx ON world_entities (world_id, arc_id);
--> statement-breakpoint
-- Per-world registry of custom entry kinds. Built-in kinds live in shared code.
CREATE TABLE IF NOT EXISTS world_entity_kinds (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS world_entity_kinds_world_key_uq ON world_entity_kinds (world_id, lower(key));
