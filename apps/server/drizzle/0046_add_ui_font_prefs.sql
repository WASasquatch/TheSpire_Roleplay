-- Per-user accessibility / readability preferences.
--
-- `ui_font_family`: free-form CSS font-family stack the client sets as the
--   `--keep-font-family` CSS variable when the user is signed in. NULL =
--   use the default chat font stack (ui-sans-serif, system-ui, ...).
--   Examples a user might enter: `"Georgia", serif`, `"Verdana",
--   sans-serif`, `"Atkinson Hyperlegible", sans-serif`. We don't validate
--   beyond a length cap at the application layer, anything CSS rejects
--   silently falls back to the next font in the stack.
--
-- `ui_font_scale`: one of 'small' | 'medium' | 'large' | 'xl', stored as
--   text for forward compatibility with new tiers. NULL = 'medium'
--   (default), which leaves the document at its built-in 16px base.
--   The client maps the enum to a px value and sets it as the document
--   font-size, scaling every rem-based Tailwind utility uniformly.
--
-- These are user-level, not character-level: they're accessibility
-- preferences, not aesthetic per-persona overrides.
ALTER TABLE `users` ADD COLUMN `ui_font_family` text;
ALTER TABLE `users` ADD COLUMN `ui_font_scale` text;
