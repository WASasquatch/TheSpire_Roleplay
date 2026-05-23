-- 0137_remove_games.sql
--
-- Drops every table the games migrations created. The adventure-game
-- feature was removed before merge; this brings any local DB that
-- already applied 0121-0136 back in line with the schema. IF EXISTS
-- guards make it a no-op on fresh installs (where 0121-0136 are
-- empty stubs and the tables never existed).
--
-- The `games_enabled` column on `site_settings` is intentionally
-- left in place. SQLite's ALTER TABLE ... DROP COLUMN has no IF
-- EXISTS guard, so attempting it would abort on fresh installs that
-- never added the column. The column is unread by any code path
-- after this removal; carrying a dead boolean is cheaper than
-- maintaining two divergent migration paths.

DROP TABLE IF EXISTS `pending_game_reward_grants`;
--> statement-breakpoint

DROP TABLE IF EXISTS `game_ratings`;
--> statement-breakpoint

DROP TABLE IF EXISTS `game_reward_grants`;
--> statement-breakpoint

DROP TABLE IF EXISTS `game_sessions`;
--> statement-breakpoint

DROP TABLE IF EXISTS `games`;
