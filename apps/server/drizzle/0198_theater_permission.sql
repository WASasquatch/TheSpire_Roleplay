-- Granular grant for the new `use_theater_mode` permission key (added
-- to the shared catalog in this same revision).
--
-- Enabling theater (watch-party) mode on a room is now gated: in
-- addition to being the room's owner/mod (or holding the site-wide
-- edit_any_room_metadata grant), the caller must hold this key to run
-- `/theater on`. Managing the playlist and driving playback once the
-- room is already in theater mode stays on the existing owner/mod gate
-- and is NOT affected by this key.
--
-- Mods AND admins get it by default (mirrors use_ghost_mode in 0188);
-- masteradmins already have everything via the hardcoded bypass. The
-- Roles & Permissions matrix can redistribute it afterwards, e.g. grant
-- it to the `trusted` role or to a single user override so a regular
-- member can host theaters in rooms they own.

INSERT INTO `role_permission_grants` (`role`, `permission_key`)
VALUES
  ('mod',   'use_theater_mode'),
  ('admin', 'use_theater_mode')
ON CONFLICT (`role`, `permission_key`) DO NOTHING;
