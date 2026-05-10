-- Per-room message lifetime + reply rendering mode.
--
-- message_expiry_minutes:
--   When non-null, the janitor deletes messages in this room older than the
--   configured window. Null = honor the global retention setting only. Use
--   case: "Looking for RP" rooms where requests should auto-clear so the
--   room never fills with stale postings. Owners/mods set via /expiry.
--
-- reply_mode:
--   "flat" (default) - replies render at the chronological end of chat,
--                      same as today.
--   "nested"         - replies render under their parent in a thread
--                      container; the latest 5 are visible by default with
--                      a "View More" toggle for the rest. Useful for LFG /
--                      bulletin-style rooms.

ALTER TABLE `rooms` ADD COLUMN `message_expiry_minutes` integer;--> statement-breakpoint
ALTER TABLE `rooms` ADD COLUMN `reply_mode` text NOT NULL DEFAULT 'flat';
