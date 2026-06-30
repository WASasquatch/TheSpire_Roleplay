-- Recreate the game_stats leaderboard indexes dropped by the 0284 per-server
-- table rebuild (original idx in 0195_game_stats.sql). They are recreated
-- server-scoped (server_id leading) so they also serve the rankings query's
-- `WHERE server_id = ?` filter (earning/gameRankings.ts), not just per-kind
-- ordering. Idempotent.
CREATE INDEX IF NOT EXISTS idx_game_stats_kind_wins
  ON game_stats (server_id, game_kind, wins);

CREATE INDEX IF NOT EXISTS idx_game_stats_kind_points
  ON game_stats (server_id, game_kind, points);
