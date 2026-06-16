-- Spire Arcade, game #3: the Grimhold cabinet (six small arcade games) —
-- unlock + permission seed. Mirrors 0245 (Urugal's Descent).
--
-- One-time unlock sold as a Flair via /earning/me/cosmetics/:key/purchase
-- (key also in PURCHASABLE_COSMETIC_KEYS). Ownership = a
-- `purchase_flair_grimhold` ledger row, per identity; the grimhold routes
-- gate on it. Cost mirrors GRIMHOLD_UNLOCK_COST in
-- packages/shared/src/grimhold.ts; admins can retune from the Flair panel.
INSERT OR IGNORE INTO `cosmetics` (`key`, `name`, `description`, `cost`, `enabled`)
VALUES (
  'flair_grimhold',
  'Grimhold Cabinet',
  'Unlock the Grimhold cabinet in the Spire Arcade - six cursed amusements: Runefall, Loong, Arrowstorm, The Spire, Graveward, and Voidwake.',
  3000,
  1
);
--> statement-breakpoint
-- Grant the per-game permission to every role by default, mirroring 0245.
-- The Arcade is purchase-gated, so this is the admin kill-switch, not the
-- real gate. Admins can revoke `use_grimhold` per-role/user; masteradmins
-- bypass.
INSERT INTO `role_permission_grants` (`role`, `permission_key`)
VALUES
  ('user',    'use_grimhold'),
  ('trusted', 'use_grimhold'),
  ('mod',     'use_grimhold'),
  ('admin',   'use_grimhold')
ON CONFLICT (`role`, `permission_key`) DO NOTHING;
