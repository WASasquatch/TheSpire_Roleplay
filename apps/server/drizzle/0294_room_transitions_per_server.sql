-- Per-server room-transition catalog (price / enabled / order). The animations
-- themselves are a fixed client-side set keyed by `key`; this table only lets a
-- server owner re-price / disable / reorder them. label + description stay
-- sourced from the shared ROOM_TRANSITIONS const. Seeded for the system server
-- from the const (flat ROOM_TRANSITION_PRICE = 1500). Part of the
-- "everything per-server" earning build.
CREATE TABLE IF NOT EXISTS room_transitions (
  server_id   TEXT    NOT NULL DEFAULT 'server_spire_system',
  key         TEXT    NOT NULL,
  cost        INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER,
  updated_at  INTEGER,
  PRIMARY KEY (server_id, key)
);

INSERT OR IGNORE INTO room_transitions (server_id, key, cost, enabled, sort_order) VALUES
  ('server_spire_system', 'slide',       1500, 1, 0),
  ('server_spire_system', 'page',        1500, 1, 1),
  ('server_spire_system', 'candle',      1500, 1, 2),
  ('server_spire_system', 'tv',          1500, 1, 3),
  ('server_spire_system', 'hologram',    1500, 1, 4),
  ('server_spire_system', 'glitch',      1500, 1, 5),
  ('server_spire_system', 'stone',       1500, 1, 6),
  ('server_spire_system', 'transporter', 1500, 1, 7),
  ('server_spire_system', 'veil',        1500, 1, 8),
  ('server_spire_system', 'fog',         1500, 1, 9),
  ('server_spire_system', 'sigil',       1500, 1, 10),
  ('server_spire_system', 'warp',        1500, 1, 11),
  ('server_spire_system', 'arcane',      1500, 1, 12),
  ('server_spire_system', 'ripple',      1500, 1, 13),
  ('server_spire_system', 'eclipse',     1500, 1, 14),
  ('server_spire_system', 'wormhole',    1500, 1, 15),
  ('server_spire_system', 'ink',         1500, 1, 16),
  ('server_spire_system', 'burn',        1500, 1, 17);
