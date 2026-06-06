-- Per-builtin-command admin overrides for game tuning.
--
-- A small number of built-in commands (the social games, RPS,
-- raffles, trivia, story dice, duel) expose tunable knobs the admin
-- can adjust without a code change:
--
--   - reward_xp / reward_currency  → mint to winner(s) on a win
--   - reward_item_key + reward_item_count → optional shop item the
--     winner receives in addition (null key = no item reward)
--   - duration_ms → game window length (null = use the code default
--     baked into each game module)
--
-- Defaults all zero / null so existing installs behave exactly as
-- before this migration (no rewards minted, code-default durations
-- in effect). The admin Commands tab's new "Built-ins" panel writes
-- to this table; the game modules read it via `getBuiltinCommandConfig`
-- at game-start (duration) and game-end (rewards).
--
-- One row per command name. The PK is the command name itself
-- (lowercase, no slash) so a JOIN with the registry is trivial. Rows
-- are created lazily, a command with no row uses zero rewards + the
-- code-default duration, which is the same as "admin has not yet
-- tuned this game."

CREATE TABLE `builtin_command_config` (
  `command_name` TEXT PRIMARY KEY,
  `reward_xp` INTEGER NOT NULL DEFAULT 0,
  `reward_currency` INTEGER NOT NULL DEFAULT 0,
  `reward_item_key` TEXT REFERENCES `items`(`key`) ON DELETE SET NULL,
  `reward_item_count` INTEGER NOT NULL DEFAULT 0,
  `duration_ms` INTEGER,
  `updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_by_user_id` TEXT REFERENCES `users`(`id`) ON DELETE SET NULL
);
