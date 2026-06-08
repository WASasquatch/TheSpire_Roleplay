-- World knowledge base: Arcs (storyline groupings entries/pages/sessions can
-- belong to) and Sessions (chronological session-log entries). `arc_id` on
-- world_sessions is a soft reference (no FK; routes validate same-world).
CREATE TABLE IF NOT EXISTS world_arcs (
  id TEXT PRIMARY KEY NOT NULL,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS world_arcs_world_slug_uq ON world_arcs (world_id, lower(slug));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS world_arcs_order_idx ON world_arcs (world_id, sort_order);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS world_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  arc_id TEXT,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  session_date INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS world_sessions_world_slug_uq ON world_sessions (world_id, lower(slug));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS world_sessions_chrono_idx ON world_sessions (world_id, session_date, sort_order);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS world_sessions_arc_idx ON world_sessions (world_id, arc_id);
