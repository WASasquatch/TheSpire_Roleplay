-- Per-identity color customization for free-form borders.
--
-- Mirrors `user_owned_name_styles.config_json` (migration 0086 era).
-- Each ownership row may carry a JSON map of CSS custom-property
-- values keyed by variable name (e.g. `{"ring-main":"#ff10f0"}`).
--
-- The convention: any `--c-<name>` reference in a border's
-- `style_css` is a customizable color slot. Authors write
-- `var(--c-ring-main, #00e5ff)` with a hex fallback; the client's
-- variable extractor scans the CSS for these names and surfaces
-- pickers in the user-facing Borders tab. The renderer inlines
-- the per-identity values as CSS custom properties on the
-- BorderedAvatar's anchor — those cascade into the `.av`
-- template's `var()` references and override the fallbacks.
--
-- Why JSON rather than a structured table: the var SET varies per
-- border. Aurora exposes maybe 3 colors, Crown jewels 6, a custom
-- admin-authored border could have any number. JSON keeps the
-- ownership row generic; the catalog row's CSS is the source of
-- truth for what's customizable.

ALTER TABLE `user_owned_freeform_borders`
  ADD COLUMN `config_json` TEXT;
--> statement-breakpoint

ALTER TABLE `character_owned_freeform_borders`
  ADD COLUMN `config_json` TEXT;
