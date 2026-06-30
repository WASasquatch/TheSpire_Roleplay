-- 0302: Persistent server rooms.
--
-- Server CHANNELS were created as ordinary rooms with no archival exemption, so
-- the empty-room "zombie sweep" parked them the moment they emptied — an owner's
-- freshly-made channel vanished within a minute. This adds a `persistent` flag
-- (exempt from that sweep, but granting none of isSystem's other powers), marks
-- existing sub-server channels persistent, and un-archives the ones already
-- wrongly swept. Ad-hoc rooms on the home (is_system) server are left alone, so
-- they still park when empty as designed.

ALTER TABLE rooms ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Mark every channel that belongs to a real (non-system) server persistent.
-- Scoped via the servers table so ad-hoc /go rooms on the home server — which
-- also carry a server_id — keep their ephemeral, park-when-empty behavior.
UPDATE rooms SET persistent = 1
WHERE is_system = 0
  AND server_id IN (SELECT id FROM servers WHERE is_system = 0);
--> statement-breakpoint

-- Restore channels the sweep already archived, EXCEPT where un-archiving would
-- collide with an active room of the same name (the create path reuses such a
-- name to resurrect, so leaving those parked is correct).
UPDATE rooms SET archived_at = NULL
WHERE archived_at IS NOT NULL
  AND is_system = 0
  AND server_id IN (SELECT id FROM servers WHERE is_system = 0)
  AND lower(name) NOT IN (SELECT lower(name) FROM rooms WHERE archived_at IS NULL);
