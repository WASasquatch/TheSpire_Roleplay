-- Per-identity social-game win + points tracking.
--
-- One row per (identity, game_kind). The mint pipeline records a
-- win whenever `formatWinningsLine` runs at game end, so adding
-- a new game kind in code Just Works for rankings without a
-- schema change.
--
-- owner_scope mirrors the rest of the per-identity model: 'user'
-- means an OOC win attributed to the master account, 'character'
-- means the win goes on a specific character. Both are tracked
-- separately so a master and their character don't share a row.
--
-- `points` is game-specific. For binary-win games (RPS, trivia,
-- duel, raffle) it's the same as `wins` (1 per win). For
-- accumulating-score games (scramble) it's the winner's actual
-- point total when they won. Rankings sort by either depending
-- on which leaderboard the UI is rendering.

CREATE TABLE `game_stats` (
  `owner_scope` TEXT NOT NULL CHECK (`owner_scope` IN ('user', 'character')),
  `owner_id` TEXT NOT NULL,
  `game_kind` TEXT NOT NULL,
  `wins` INTEGER NOT NULL DEFAULT 0,
  `points` INTEGER NOT NULL DEFAULT 0,
  `last_won_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`owner_scope`, `owner_id`, `game_kind`)
);
--> statement-breakpoint
CREATE INDEX `idx_game_stats_kind_wins` ON `game_stats` (`game_kind`, `wins` DESC);
--> statement-breakpoint
CREATE INDEX `idx_game_stats_kind_points` ON `game_stats` (`game_kind`, `points` DESC);
