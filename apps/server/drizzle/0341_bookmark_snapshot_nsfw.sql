-- 0341: 18+ stamp for archived bookmark snapshots (age-restriction plan;
-- closes the bookmarks half of the snapshot gap 0332 left open — 0340 did
-- pins).
--
-- Bookmarks freeze a snapshot_* copy of their message at save time and the
-- row outlives the source (message_id FK SET NULL); the retention janitor
-- stamps archived_at so the GET route serves the frozen body once the
-- source row is gone. The route's minor gate reads the LIVE
-- messages.is_nsfw stamp, which an archived snapshot no longer has — so an
-- 18+-era row an ADULT bookmarked kept serving its snapshot body after an
-- admin DOB correction flipped that account to minor. This column carries
-- the stamp on the bookmark row itself; the janitor writes it from the
-- live row at ARCHIVE time (archive-time, not save time, so a forum
-- topic's mutable NSFW re-tag is captured at its final value).
--
-- Backfill: copy is_nsfw from each bookmark's still-live source message so
-- rows that archive later — or that archived while their source somehow
-- survived — are stamped from day one. HONEST RESIDUE: rows already
-- archived with the source retention-expired (message_id NULL) cannot be
-- reconstructed and keep the default 0 — an 18+-era snapshot archived
-- BEFORE this migration stays readable to a later-downgraded account.
-- A minor's own bookmarks were create-path age-gated, so the residue is
-- limited to adult-created bookmarks on accounts an admin later corrects.

ALTER TABLE bookmarks ADD COLUMN snapshot_is_nsfw INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE bookmarks
SET snapshot_is_nsfw = 1
WHERE message_id IN (SELECT id FROM messages WHERE is_nsfw = 1);
