-- Per-room rich-text toggle. `rooms.rich_text_disabled` reduces the room's
-- composer to the simple pre-rich formatting set: the rich-only controls
-- (headings, alignment) hide client-side and messages ride the historic
-- markdown wire. Enforced server-side at the chat ingest + message edit
-- chokepoints: an incoming rich-HTML body for a disabled room is degraded
-- (h1-h3 unwrap to paragraphs, text-align strips) rather than rejected, so
-- headings/alignment can never PERSIST into such a room regardless of the
-- client. Default 0 keeps every existing room byte-identical.
ALTER TABLE `rooms` ADD COLUMN `rich_text_disabled` integer NOT NULL DEFAULT 0;
