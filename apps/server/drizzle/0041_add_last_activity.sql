-- Per-topic "last activity" timestamp, used by the forum view to order
-- topics within a category by most-recent-active first. Updated by the
-- server whenever a reply is inserted under a topic; backfilled here
-- from the existing reply rows so old topics get the right ordering
-- on first page load.
--
-- Only meaningful for top-level topics in nested-mode rooms, the
-- topics endpoint filters on `reply_to_id IS NULL` and orders by this
-- column. Replies and flat-room messages carry the column too but the
-- value is unused.
ALTER TABLE `messages` ADD COLUMN `last_activity_at` integer;
--> statement-breakpoint
-- Backfill: for every top-level row, set last_activity_at to the
-- max(child.created_at) over its replies, falling back to its own
-- created_at when there are no replies. This gives the forum view a
-- correct initial ordering on first paint.
UPDATE `messages`
SET `last_activity_at` = COALESCE(
  (SELECT MAX(r.created_at)
   FROM `messages` r
   WHERE r.reply_to_id = `messages`.id),
  created_at
)
WHERE reply_to_id IS NULL;
