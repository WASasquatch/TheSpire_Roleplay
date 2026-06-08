-- Scriptorium writing rewards: tie publishing into the Earning economy.
-- `reward_paid_at` is the pay-once latch on a chapter (stamped on first
-- publish); edits / re-publish never re-pay. The backfill stamps every
-- already-published chapter as paid so existing books don't retro-pay when the
-- new bracketed reward path goes live.
ALTER TABLE story_chapters ADD COLUMN reward_paid_at INTEGER;
--> statement-breakpoint
UPDATE story_chapters SET reward_paid_at = published_at WHERE status = 'published' AND reward_paid_at IS NULL;
--> statement-breakpoint
-- Per-authoring-identity weekly publishing streak (ISO week key), the writing
-- analog of the eidolon daily care-streak. Drives the payout multiplier.
CREATE TABLE IF NOT EXISTS scriptorium_write_streaks (
  owner_scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  streak_count INTEGER NOT NULL DEFAULT 0,
  last_publish_week_key TEXT,
  best_streak INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (owner_scope, owner_id)
);
