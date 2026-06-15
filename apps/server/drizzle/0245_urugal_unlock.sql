-- Spire Arcade, game #2: Urugal's Descent — unlock + permission seed.
--
-- The one-time unlock is sold as a Flair in the Earning shop, bought via the
-- standard /earning/me/cosmetics/:key/purchase flow (the key is also in
-- PURCHASABLE_COSMETIC_KEYS). Ownership = a `purchase_flair_urugal_descent`
-- ledger row, per identity; the urugal routes gate on it. Cost mirrors
-- URUGAL_UNLOCK_COST in packages/shared/src/urugal.ts; admins can retune it
-- from the Flair admin panel.
INSERT OR IGNORE INTO `cosmetics` (`key`, `name`, `description`, `cost`, `enabled`)
VALUES (
  'flair_urugal_descent',
  'Urugal''s Descent',
  'Unlock Urugal''s Descent in the Spire Arcade - a gothic roguelike. Pick a class and delve a procedurally-built dungeon as deep as you dare.',
  2000,
  1
);
--> statement-breakpoint
-- Grant the new per-game permission to every role by default, mirroring the
-- Eidolon Tamer grant in 0202. The Arcade is purchase-gated, so the
-- permission is the admin kill-switch, not the real gate: a player still has
-- to buy the unlock to play. Admins can revoke `use_urugal_descent` per-role
-- or per-user via the Roles & Permissions matrix. Masteradmins bypass.
INSERT INTO `role_permission_grants` (`role`, `permission_key`)
VALUES
  ('user',    'use_urugal_descent'),
  ('trusted', 'use_urugal_descent'),
  ('mod',     'use_urugal_descent'),
  ('admin',   'use_urugal_descent')
ON CONFLICT (`role`, `permission_key`) DO NOTHING;
