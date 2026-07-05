-- 0327: An optional icon on a server event. A manager picks one from a small
-- curated set of Lucide icons and it shows before the event title on the
-- calendar. Stored as a plain lowercase slug (e.g. 'sword', 'book'); the client
-- maps the slug to a Lucide component and ignores any slug it doesn't know.
-- Additive + nullable — absent/NULL means "no icon" (today's look), so every
-- existing event is untouched.
ALTER TABLE server_events ADD COLUMN icon TEXT;
