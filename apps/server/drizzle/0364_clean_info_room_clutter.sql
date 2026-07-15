-- Retroactively purge clutter from info rooms.
--
-- Info rooms (post_mode = 'staff', no forum) are staff-post announcement
-- channels: only the staff-posted content belongs there. Before the emit
-- paths were gated, non-post rows accumulated in them — join/leave and
-- topic/moderation system lines, sitewide announcements, and per-user
-- TARGETED notifications (the "X is online" watcher line, friend requests,
-- the room description / newcomer greeter). These are persisted with
-- kind IN ('system','announce'), so this one-time delete clears whatever is
-- already sitting in an info room's history.
--
-- Whispers (kind = 'whisper') are deliberately NOT touched: they're private,
-- participant-only, and never public room clutter — deleting them would drop
-- real 1:1 messages.
--
-- Going forward these never land in an info room again: addMessage /
-- addSystemMessage / addMessageDirect and the targeted-message persisters all
-- skip info rooms, and the client no longer synthesizes the live "X is online"
-- line there.
DELETE FROM messages
WHERE kind IN ('system', 'announce')
  AND room_id IN (SELECT id FROM rooms WHERE post_mode = 'staff' AND forum_id IS NULL);
