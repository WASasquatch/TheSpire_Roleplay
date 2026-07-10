-- 0340: 18+ snapshot stamp for pinned messages (age-restriction plan; closes
-- the pins half of the snapshot gap 0332 left open).
--
-- Pins freeze a display SNAPSHOT of their source message (body, author,
-- styling) into pinned_messages, and the pin OUTLIVES the source row
-- (message_id FK is SET NULL on hard-delete/retention). The read gates
-- (GET /rooms/:id/pins + the room:pins emit) filter 18+ content for minors
-- by joining the LIVE messages.is_nsfw stamp — which a snapshot-only pin
-- (message_id NULL) no longer has, so a pin made during a room's 18+ era
-- kept serving its snapshot body to minors once retention expired the
-- source. This column freezes the source message's is_nsfw at pin time so
-- snapshot-only pins filter too.
--
-- Backfill: copy is_nsfw from each pin's still-live source message.
-- HONEST RESIDUE: pins whose source is already gone (message_id NULL)
-- cannot be reconstructed and keep the default 0 — any such pin made from
-- an 18+-era message BEFORE this migration stays minor-visible until a
-- mod unpins it. Live pins stay filtered by the live-row join either way,
-- so the residue is exactly the already-expired snapshot-only set.

ALTER TABLE pinned_messages ADD COLUMN is_nsfw INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE pinned_messages
SET is_nsfw = 1
WHERE message_id IN (SELECT id FROM messages WHERE is_nsfw = 1);
