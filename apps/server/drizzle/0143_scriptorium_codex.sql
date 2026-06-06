-- 0143_scriptorium_codex.sql
--
-- Phase 8: per-story codex. An author's continuity bible, characters,
-- locations, plot points, that lives alongside the story but isn't
-- part of the narrative. Three entity kinds, one table, discriminated
-- by `kind`:
--
--   character, name + portrait + one-line + long bio + stats kv
--   location , name + image + one-line + long description
--   plot     , title + status (planned/setup/payoff/resolved) + notes
--
-- `is_public` opt-in surfaces an entity as part of a "Cast & places"
-- appendix on the story's reader landing page. Authors keep their
-- continuity notes (plot points, draft sketches) private by default.
--
-- When the story is linked to a world (stories.linked_world_id), the
-- editor's codex panel additionally shows that world's pages as
-- read-only references, that's purely a UI fetch, no schema needed.

CREATE TABLE IF NOT EXISTS `story_entities` (
  `id`             TEXT NOT NULL PRIMARY KEY,
  `story_id`       TEXT NOT NULL REFERENCES `stories`(`id`) ON DELETE CASCADE,
  `kind`           TEXT NOT NULL,                       -- character | location | plot
  `slug`           TEXT NOT NULL,
  `name`           TEXT NOT NULL,
  `summary`        TEXT NOT NULL DEFAULT '',
  `body_html`      TEXT NOT NULL DEFAULT '',
  -- Free-form key/values. For `character` rows: age/race/gender/etc.
  -- For `plot` rows: a `status` slot (planned/setup/payoff/resolved).
  -- For `location` rows: optional `region`/`map_coords`/etc. The DB
  -- doesn't enforce shape, the editor + reader render whatever's
  -- there, hidden when empty.
  `stats_json`     TEXT NOT NULL DEFAULT '{}',
  `image_url`      TEXT,
  -- Public entities show up in the story's reader appendix; private
  -- entities are author-only (codex tab in the editor). Default
  -- private, plot notes especially shouldn't surface by default.
  `is_public`      INTEGER NOT NULL DEFAULT 0,
  `sort_order`     INTEGER NOT NULL DEFAULT 0,
  `created_at`     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at`     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

-- Per-story + per-kind slug uniqueness so an author can have a
-- character and a location share a name (Aria the character,
-- Aria the city) without conflict.
CREATE UNIQUE INDEX IF NOT EXISTS `story_entities_story_kind_slug_uq`
  ON `story_entities` (`story_id`, `kind`, lower(`slug`));
--> statement-breakpoint

-- Render-order index for the codex tab + the public appendix.
CREATE INDEX IF NOT EXISTS `story_entities_order_idx`
  ON `story_entities` (`story_id`, `kind`, `sort_order`);
