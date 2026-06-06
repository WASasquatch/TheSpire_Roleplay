-- Announcements: rotating banner marquee + scheduled `/announce` cronjobs.
--
-- Two independent tables for two distinct surfaces:
--
--   `announcement_banners`, admin-curated rows that render in the
--     chat-top marquee. The client fetches the enabled set on mount,
--     listens for a `announcements:banners-changed` socket push, and
--     rotates through them one at a time with a fade transition.
--     Body is sanitized HTML (Markdown is converted client-side
--     before save and stored as HTML so the read path is one shape).
--     Closed-state persistence lives in the viewer's localStorage,
--     no server-side per-user mute.
--
--   `scheduled_announcements`, cron-like rows that fire via the same
--     code path the in-chat `/announce` builtin uses. Each row carries
--     either a one-shot `run_at` (epoch ms) or a recurring
--     `interval_ms` (parsed from a human-readable spec like "1d8h" or
--     "30m" at save time). The scheduler tick reads enabled rows whose
--     `next_run_at <= now`, fires `addMessage(kind: "announce", ...)`
--     against the row's `target_room_id` (NULL = sitewide, every
--     room), then advances `last_run_at` + `next_run_at` for recurring
--     rows or disables the row entirely for one-shots.
--
-- Color column on scheduled rows mirrors the custom-command pattern:
-- either NULL (no override), a `#rrggbb` hex literal, or a
-- `theme:<slot>` token. Snapshotted onto the emitted message so a
-- later edit to the schedule doesn't restyle history.
--
-- The optional `body_html` column on `messages` is what lets the
-- announce renderer paint trusted HTML (admin-authored, sanitized at
-- save time) without rewriting the chat markdown pipeline. NULL on
-- every existing row and on user-authored `/announce` lines; populated
-- only by the scheduler when the source row's body carried markup the
-- inline-markdown renderer wouldn't pick up.
CREATE TABLE IF NOT EXISTS announcement_banners (
  id TEXT PRIMARY KEY,
  -- Sanitized HTML rendered into the marquee via dangerouslySetInnerHTML.
  -- Markdown is converted upstream; the storage shape is always HTML so
  -- the read path doesn't need a content-type discriminator.
  body_html TEXT NOT NULL,
  -- Visible-to-viewers toggle. Drafts sit at enabled=0 so an admin can
  -- compose without surfacing the banner mid-edit.
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Display order in the rotation. Lower = earlier. Ties broken by
  -- created_at ASC so two banners with the same sort_order render in
  -- the order they were added.
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS announcement_banners_enabled_idx
  ON announcement_banners(enabled, sort_order, created_at);

CREATE TABLE IF NOT EXISTS scheduled_announcements (
  id TEXT PRIMARY KEY,
  -- The raw human-readable spec the admin typed ("1d8h", "3h", an
  -- ISO datetime, etc.). Kept verbatim so the editor can re-show
  -- exactly what the admin saved without round-tripping through the
  -- parser. The parsed result lives in `kind` + `interval_ms` /
  -- `run_at`.
  schedule_spec TEXT NOT NULL,
  -- "interval" → fires every interval_ms forever (until disabled).
  -- "oneShot"  → fires once at run_at, then auto-disables.
  kind TEXT NOT NULL CHECK (kind IN ('interval', 'oneShot')),
  interval_ms INTEGER,
  run_at INTEGER,
  last_run_at INTEGER,
  -- Cached "when does this fire next?" so the tick loop only has to
  -- read enabled rows where next_run_at <= now. Recomputed at insert,
  -- on every fire (for recurring), and when the admin edits the
  -- schedule. NULL for completed one-shots and disabled rows.
  next_run_at INTEGER,
  body_html TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  -- Color override applied to the emitted `kind = 'announce'`
  -- message. NULL = no override; `#rrggbb` or `theme:<slot>` snapshot.
  color TEXT,
  -- NULL = sitewide (every room). Otherwise the specific room id.
  target_room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS scheduled_announcements_next_run_idx
  ON scheduled_announcements(enabled, next_run_at);

-- Trusted-HTML body shape on the `messages` row. The chat markdown
-- pipeline still owns regular chat lines; this column is only ever
-- populated by the announce-scheduler firing path so the renderer
-- can paint marquee-quality formatting (links, lists, bold spans)
-- on the scheduled-`/announce` lines without forking the kind enum.
-- Manual in-chat `/announce` keeps body_html NULL and renders
-- through the existing inline-markdown path.
ALTER TABLE messages ADD COLUMN body_html TEXT;
