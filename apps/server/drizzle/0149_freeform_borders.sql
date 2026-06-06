-- Free-form avatar borders (Phase 1 of the cosmetic expansion).
--
-- Coexists with the existing rank-tier border system. The two share
-- the BorderedAvatar renderer (which checks the freeform slot first
-- and falls back to the rank-tied slot), but their catalogs and
-- ownership ledgers are independent:
--
--   rank_tiers.border_image_url + rank_tiers.border_cost   ← unchanged
--   user_owned_borders / character_owned_borders            ← unchanged (rank borders)
--   freeform_borders                                        ← NEW catalog
--   user_owned_freeform_borders                             ← NEW ownership
--   character_owned_freeform_borders                        ← NEW ownership
--   user_earning.selected_freeform_border_key               ← NEW equip slot
--   character_earning.selected_freeform_border_key          ← NEW equip slot
--
-- Why parallel instead of unifying into a single borders table:
-- existing rank-tier borders carry their pricing, eligibility, and
-- ownership via the rank ladder. Merging them into a generic
-- catalog would require backfill + FK-constraint rewrites on
-- live ownership tables, material risk for what's mostly
-- presentational change. Parallel tables ship the new content type
-- additively; the BordersTab UI merges the two sources into one
-- visual catalog, which is what the user actually sees.
--
-- Each freeform border ships in EITHER `image_url` mode OR
-- `template`+`style_css` mode. The renderer:
--   - `image_url` set            → overlay <img> on top of the avatar
--   - `template`+`style_css` set → inject the CSS, render the DOM
--                                  template with {avatar} substituted
--                                  (mirrors the name-style template
--                                  system)
-- App-layer validator enforces exactly one path on insert/update.

CREATE TABLE IF NOT EXISTS `freeform_borders` (
  `key`            TEXT NOT NULL PRIMARY KEY,
  `name`           TEXT NOT NULL,
  `description`    TEXT NOT NULL DEFAULT '',
  -- Path A, image-based. PNG / APNG / WebP. Renders as an overlay.
  -- Mutually exclusive with `template`.
  `image_url`      TEXT,
  -- Path B, DOM template with the literal `{avatar}` placeholder.
  -- Wrap structure (e.g. `<div class="av b-X"><div class="pic">{avatar}</div></div>`)
  -- mirrors complete_avatar_borders.html. Mutually exclusive with
  -- `image_url`.
  `template`       TEXT,
  -- Scoped CSS for the `.b-<key>` class chain referenced by template.
  -- Class scoping is the renderer's job, admins author rules under
  -- the catalog key namespace so cross-row leakage isn't possible.
  `style_css`      TEXT,
  -- Rarity tier, drives the chip-strip filter in the user-facing
  -- BordersTab AND the color accent on the card. Open string (no
  -- CHECK constraint) so admins can introduce a new tier without a
  -- schema migration; the client falls back to the 'common' palette
  -- for unknown values.
  `rarity`         TEXT NOT NULL DEFAULT 'common',
  `cost`           INTEGER NOT NULL DEFAULT 0,
  `enabled`        INTEGER NOT NULL DEFAULT 1,
  -- Seed-protected rows can't be deleted from admin; same convention
  -- as `name_styles.is_builtin` / `items.is_builtin`.
  `is_builtin`     INTEGER NOT NULL DEFAULT 0,
  `order`          INTEGER NOT NULL DEFAULT 0,
  `created_at`     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at`     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

-- Per-master ownership. Same shape as user_owned_borders / user_owned_name_styles.
CREATE TABLE IF NOT EXISTS `user_owned_freeform_borders` (
  `user_id`       TEXT NOT NULL REFERENCES `users`(`id`)            ON DELETE CASCADE,
  `border_key`    TEXT NOT NULL REFERENCES `freeform_borders`(`key`) ON DELETE CASCADE,
  `acquired_at`   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`user_id`, `border_key`)
);
--> statement-breakpoint

-- Per-character ownership. Same per-identity partitioning rules the
-- rest of the cosmetic system uses (master who bought a freeform
-- border does NOT make their characters own it).
CREATE TABLE IF NOT EXISTS `character_owned_freeform_borders` (
  `character_id`  TEXT NOT NULL REFERENCES `characters`(`id`)        ON DELETE CASCADE,
  `border_key`    TEXT NOT NULL REFERENCES `freeform_borders`(`key`) ON DELETE CASCADE,
  `acquired_at`   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`character_id`, `border_key`)
);
--> statement-breakpoint

-- Equip slots. ON DELETE SET NULL so admin deletion of a freeform
-- border row clears every active equip rather than cascading away
-- ownership (which lives on the *_owned tables and cascades
-- independently). Mirrors how rank-tier borders behave.
ALTER TABLE `user_earning`
  ADD COLUMN `selected_freeform_border_key` TEXT
  REFERENCES `freeform_borders`(`key`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `character_earning`
  ADD COLUMN `selected_freeform_border_key` TEXT
  REFERENCES `freeform_borders`(`key`) ON DELETE SET NULL;
--> statement-breakpoint

-- Lookup indexes, ownership queries by user/character are the hot
-- path on dashboard open and BordersTab render.
CREATE INDEX IF NOT EXISTS `user_owned_freeform_borders_user_idx`
  ON `user_owned_freeform_borders` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `character_owned_freeform_borders_character_idx`
  ON `character_owned_freeform_borders` (`character_id`);
