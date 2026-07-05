-- 0316: Pinned messages — mods/admins pin a chat message to the top of a room.
--
-- `pinned_messages` holds one row per pin. The message FK is SET NULL (not
-- CASCADE) so a pin can OUTLIVE the underlying message — the row snapshots the
-- author + body + styling at pin time (same convention as bookmarks/replies),
-- so a soft-/hard-deleted message still reads as a pinned card. The room FK
-- cascades (a deleted room takes its pins with it). `sort_order` drives the
-- pinned strip's manual ordering; `server_id` is null on the default server and
-- carried for future per-server scoping/queries.
--
-- unique(room_id, message_id) blocks double-pinning the same message; the
-- (room_id, sort_order) index drives the ordered read.
--
-- The `pin_message` global permission is seeded to mod + admin (masteradmin
-- bypasses every key in code, so no row for them), mirroring 0313's grant seed.

CREATE TABLE IF NOT EXISTS pinned_messages (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
  pinned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  pinned_by_display_name TEXT,
  pinned_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- snapshot of the pinned message at pin time (survives its deletion)
  author_user_id TEXT,
  author_character_id TEXT,
  display_name TEXT,
  kind TEXT,
  body TEXT,
  color TEXT,
  cmd_css TEXT,
  scene_image_url TEXT,
  body_html TEXT,
  orig_created_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS pinned_messages_room_msg_uq ON pinned_messages (room_id, message_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pinned_messages_room_sort_idx ON pinned_messages (room_id, sort_order);
--> statement-breakpoint
INSERT OR IGNORE INTO role_permission_grants (role, permission_key) VALUES
  ('mod', 'pin_message'),
  ('admin', 'pin_message');
