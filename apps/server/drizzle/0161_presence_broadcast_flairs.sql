-- Custom room-presence + session-presence broadcast templates.
--
-- Two new Flair cosmetics, each unlocking a paired set of templates
-- so the user composes the matching enter/exit pair together (a
-- "strolls into" entrance with a "vanishes from" exit reads as one
-- voice; charging twice for the pair would be pedantic).
--
--   flair_room_presence    — overrides the per-room "X has entered
--                            the room." / "X has left the room."
--                            system lines. Per-identity (the chat
--                            shell already knows which voice is in
--                            the room; the master / character split
--                            mirrors typing_phrase).
--
--   flair_session_presence — overrides the site-level "X has
--                            connected." / "X has disconnected."
--                            lines. Master-only because the session
--                            is a property of the master account, not
--                            of an active character.
--
-- Template grammar matches the help-modal voice: short, plain text,
-- two placeholder tokens — `{name}` (the broadcasting identity's
-- display name) and `{room}` (the room name, room-presence only).
-- Server clamps length per row and strips control characters /
-- angle-bracket-bearing payloads at write time, mirroring the
-- typing-phrase validator. Admin retains clear levers per slot for
-- moderation, same shape as the existing banner / typing-phrase
-- clears.

-- Room-presence templates — per-identity. Nullable so clearing
-- returns the slot to the default phrasing without an extra "is
-- using custom" flag (the renderer treats NULL as "use the default").
ALTER TABLE `user_earning`
  ADD COLUMN `room_join_template` TEXT;
--> statement-breakpoint
ALTER TABLE `user_earning`
  ADD COLUMN `room_leave_template` TEXT;
--> statement-breakpoint
ALTER TABLE `character_earning`
  ADD COLUMN `room_join_template` TEXT;
--> statement-breakpoint
ALTER TABLE `character_earning`
  ADD COLUMN `room_leave_template` TEXT;
--> statement-breakpoint

-- Session-presence templates — master only. There's no "character
-- has logged in" notion; characters are sub-identities of the active
-- master session.
ALTER TABLE `user_earning`
  ADD COLUMN `session_connect_template` TEXT;
--> statement-breakpoint
ALTER TABLE `user_earning`
  ADD COLUMN `session_exit_template` TEXT;
--> statement-breakpoint

-- Catalog rows. Costs are placeholders — admins tune via the Flair
-- admin tab. Sit at the same tier as the typing-phrase / banner
-- flairs (the work to ship them is similar; the visual presence is
-- a fraction of a name-style or border).
INSERT OR IGNORE INTO `cosmetics`
  (`key`, `name`, `description`, `cost`, `enabled`, `config_json`)
VALUES
  ('flair_room_presence',
   'Custom Room Entrance',
   'Replace the standard "has entered the room." / "has left the room." lines with your own short phrasings. Use {name} for your name and {room} for the room name. Up to 100 characters each; admins can clear abusive content.',
   2000,
   1,
   NULL),
  ('flair_session_presence',
   'Custom Session Greeting',
   'Replace the "has connected." / "has disconnected." lines that announce you logging in and out. Use {name} for your name. Up to 100 characters each; admins can clear abusive content.',
   3000,
   1,
   NULL);
