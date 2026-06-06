-- Author-edit / author-delete grace window for chat messages, in ms.
-- Previously hardcoded to 60_000 (60s) in routes/messages.ts +
-- routes/directMessages.ts. Surfacing it as a setting lets admins tune
-- the window per deployment, RP rooms typically want longer so authors
-- can fix typos / rewrite a beat without locking history; high-traffic
-- public rooms can keep it tight to keep moderation reviews coherent.
--
-- 300_000 = 5 minutes is the new shipped default, a deliberate bump
-- from the original 60s after admin feedback that "fix the line you
-- just wrote" got cut off too aggressively. Mods and admins still
-- bypass the gate entirely (see routes/messages.ts).
ALTER TABLE site_settings
  ADD COLUMN edit_grace_ms INTEGER NOT NULL DEFAULT 300000;
