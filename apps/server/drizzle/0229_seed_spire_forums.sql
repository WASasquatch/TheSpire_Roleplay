-- Forums Phase 0: seed "The Spire Forums" (the site-owned system forum)
-- and adopt existing PUBLIC nested rooms into it as boards.
--
-- Owner resolution: prefer the oldest masteradmin, then the oldest admin.
-- On a brand-new install where migrations run before ANY user exists the
-- INSERT…SELECT inserts zero rows — seed.ts re-ensures the system forum
-- idempotently at boot once a masteradmin exists, so fresh installs are
-- covered there (and they have no nested rooms to adopt anyway).
--
-- Adoption is deliberately PUBLIC-only: a private nested room is someone's
-- personal space — silently moving it into a public catalog would be
-- wrong. Archived rooms are skipped for the same reason. The fixed id
-- keeps the adoption UPDATE and seed.ts in agreement forever.
INSERT OR IGNORE INTO forums
  (id, slug, name, tagline, owner_user_id, is_system, status, visibility, posting_mode)
SELECT
  'forum_spire_system',
  'spire',
  'The Spire Forums',
  'The Spire''s town square — announcements, roleplay boards, and community talk.',
  u.id, 1, 'active', 'public', 'open'
FROM users u
WHERE u.role IN ('masteradmin', 'admin')
ORDER BY CASE u.role WHEN 'masteradmin' THEN 0 ELSE 1 END, u.created_at
LIMIT 1;
--> statement-breakpoint
UPDATE rooms SET forum_id = 'forum_spire_system'
WHERE reply_mode = 'nested'
  AND type = 'public'
  AND archived_at IS NULL
  AND forum_id IS NULL
  AND EXISTS (SELECT 1 FROM forums WHERE id = 'forum_spire_system');
