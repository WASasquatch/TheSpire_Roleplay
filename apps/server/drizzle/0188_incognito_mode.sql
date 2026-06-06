-- Incognito (ghost) mode for moderation observation.
--
-- New surface that lets a mod or admin slip out of the userlist
-- without disconnecting, for the use case of joining a private
-- room mid-argument and observing the situation without their
-- presence biasing what the participants say next.
--
-- Persists across reconnects so a network blip or refresh doesn't
-- pop the moderator back into visibility mid-investigation; the
-- mod has to /incognito (or click the "Leave Incognito" palette
-- button) to come back. The schema lives on `users` because the
-- mode is a per-account property, not per-session.

-- Granular grant for the new `use_ghost_mode` permission key (added
-- to the shared catalog in this same revision). Mods AND admins get
-- it by default; masteradmins already have everything via the
-- hardcoded bypass. The matrix UI can redistribute these grants
-- later.
INSERT INTO `role_permission_grants` (`role`, `permission_key`)
VALUES
  ('mod',   'use_ghost_mode'),
  ('admin', 'use_ghost_mode')
ON CONFLICT (`role`, `permission_key`) DO NOTHING;
--> statement-breakpoint

-- Persistent incognito state on the user row.
--
--   incognito_mode (0/1)        , whether the user is currently
--                                  hidden from userlists and presence.
--                                  Defaults to 0 so existing rows
--                                  are visible by default.
--
--   incognito_alias             , display name to use for any chat
--                                  messages the user sends while
--                                  incognito. Null = use the literal
--                                  fallback "System". The /incognito
--                                  <name> subcommand updates this AND
--                                  flips mode on in one step.
--
--   incognito_exit_message      , admin-customised "X has left the
--                                  chat" line broadcast at the moment
--                                  they go incognito. Null = use the
--                                  default phrasing built from the
--                                  user's display name.
--
--   incognito_return_message    , symmetric "X has joined the chat"
--                                  line broadcast when they /incognito
--                                  off (or click Leave Incognito).
--                                  Null = default phrasing.
ALTER TABLE `users` ADD COLUMN `incognito_mode` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `incognito_alias` text;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `incognito_exit_message` text;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `incognito_return_message` text;
