-- Room Info bar: persistent room metadata (migration 0258).
--
-- Adds the columns behind the new clickable Room Info bar:
--   icon                    - URL or emoji glyph shown left of the room name
--   message_count           - cumulative "messages ever" counter (only ever
--                             incremented; survives retention/expiry sweeps)
--   current_scene_title/_image_url - the live open scene (set by /scene,
--                             cleared by /scene end)
--   npc_list                - JSON array of distinct NPC names ever voiced
--
-- All are plain columns, so they ride through archive (archived_at) and
-- resurrection (which only resets members/bans/invites) unchanged — the
-- room's history "caches with the archive and persists."
ALTER TABLE rooms ADD COLUMN icon TEXT;
--> statement-breakpoint
ALTER TABLE rooms ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE rooms ADD COLUMN current_scene_title TEXT;
--> statement-breakpoint
ALTER TABLE rooms ADD COLUMN current_scene_image_url TEXT;
--> statement-breakpoint
ALTER TABLE rooms ADD COLUMN npc_list TEXT;
--> statement-breakpoint
-- Backfill message_count from the messages still on hand. This is a best-
-- effort BASELINE — rows already purged by retention are unrecoverable — but
-- it seeds a sensible starting number and the counter grows correctly from
-- here. The qualifying set mirrors classifyMessageForLifetime: in flat rooms,
-- non-reply chat kinds; in nested (forum) rooms, topics + replies.
UPDATE rooms SET message_count = (
  SELECT COUNT(*) FROM messages m
  WHERE m.room_id = rooms.id
    AND (
      (rooms.reply_mode = 'flat'
        AND m.reply_to_id IS NULL
        AND m.kind IN ('say','me','ooc','roll','scene','npc'))
      OR
      (rooms.reply_mode = 'nested'
        AND (m.reply_to_id IS NOT NULL OR m.title IS NOT NULL))
    )
);
--> statement-breakpoint
-- Backfill the NPC cast list (distinct NPC display names, alphabetical) for
-- rooms that have any npc-kind messages still on hand.
UPDATE rooms SET npc_list = (
  SELECT json_group_array(name) FROM (
    SELECT DISTINCT m.display_name AS name
    FROM messages m
    WHERE m.room_id = rooms.id AND m.kind = 'npc' AND m.display_name IS NOT NULL
    ORDER BY m.display_name
  )
)
WHERE EXISTS (
  SELECT 1 FROM messages m2 WHERE m2.room_id = rooms.id AND m2.kind = 'npc'
);
