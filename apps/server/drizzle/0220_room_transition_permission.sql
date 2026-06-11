-- Grant the room-transition cosmetic permission to every role by default.
-- Like `use_arcade` (0202), room transitions are an opt-in, PURCHASE-gated
-- cosmetic, so the permission is the admin kill-switch rather than the real
-- gate: a player still buys each transition with currency. Admins can revoke
-- `use_room_transitions` per-role or per-user via the Roles & Permissions
-- matrix (hides the shop section + disables the effect). Masteradmins have it
-- via the hardcoded bypass.
INSERT INTO `role_permission_grants` (`role`, `permission_key`)
VALUES
  ('user',    'use_room_transitions'),
  ('trusted', 'use_room_transitions'),
  ('mod',     'use_room_transitions'),
  ('admin',   'use_room_transitions')
ON CONFLICT (`role`, `permission_key`) DO NOTHING;
