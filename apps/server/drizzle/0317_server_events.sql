-- 0317: Server events — scheduled community events (calendar) per server, with
-- RSVPs.
--
-- `server_events`      one row per scheduled event, scoped to a server (FK
--                      cascade — a deleted server takes its events). Created by
--                      a member (created_by_user_id) optionally voicing a
--                      character (host_character_id); `starts_at`/`ends_at` are
--                      ms epoch (ends nullable = open-ended). Optional deep
--                      links to a room or forum board. `status` moves
--                      scheduled -> live -> ended / cancelled. `reminder_*`
--                      drive an opt-in "starting soon" ping (lead ms + a fired
--                      stamp so it only fires once). `recurrence_json` is
--                      RESERVED for future repeating events (unused today).
--
-- `server_event_rsvps` one row per (event, user, character) — a member may RSVP
--                      as different characters. Both FKs cascade. UNIQUE keeps
--                      an identity's answer single; the (event, status) index
--                      drives the "who's going" roll-up.
--
-- Additive; nothing references these until the events feature ships. The
-- `manage_events` SERVER permission (shared) gates create/edit/cancel; RSVPing
-- is a plain member action.

CREATE TABLE IF NOT EXISTS server_events (
  id TEXT PRIMARY KEY NOT NULL,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  host_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description_html TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  linked_room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  linked_forum_id TEXT REFERENCES forums(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  reminder_lead_ms INTEGER,
  reminder_fired_at INTEGER,
  recurrence_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS server_events_server_time_idx ON server_events (server_id, starts_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS server_event_rsvps (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES server_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS server_event_rsvps_event_user_char_uq ON server_event_rsvps (event_id, user_id, character_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS server_event_rsvps_event_status_idx ON server_event_rsvps (event_id, status);
