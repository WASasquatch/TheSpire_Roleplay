-- Add gender-aware title kinds + retrofit the existing "sibling"
-- kind to use the new {gender:M|F|N} template token.
--
-- The token resolves to whichever pipe-separated alternative matches
-- the subject's gender (the person whose profile the chip is being
-- rendered on). "M" = male, "F" = female, "N" = nonbinary/other/
-- undisclosed. Implemented in `apps/server/src/titles/service.ts`
-- alongside the existing {target} substitution.
--
-- Two changes here:
--
--   1. Insert a brand-new "parent" kind. Asymmetric: the A side
--      (requester) is the parent, the B side (recipient) is the
--      child. Each side's chip picks the right word from
--      Father/Mother/Parent or Son/Daughter/Child based on whose
--      profile the chip is rendering on. So /request parent <child>
--      lands "Father of Kaal" (or "Mother of Kaal") on the
--      requester's profile and "Son of WAS" (or "Daughter of WAS")
--      on the recipient's. Exclusive flag is OFF — a character can
--      legitimately have multiple parents and multiple children.
--
--   2. Retrofit "sibling" to be gender-aware. Pre-0111 it shipped
--      a static "Sibling of {target}" on both sides; the same
--      catalog row now reads "Brother of {target}" / "Sister of
--      {target}" / "Sibling of {target}" depending on the viewer's
--      gender. Symmetric flag stays ON — both sides render with
--      the same template, but the substitution picks per-side
--      automatically.
--
-- Existing accepted/pending sibling rows continue to render
-- correctly without any data-row migration — only the format
-- string changed; the per-relationship rows are unaffected.

INSERT OR IGNORE INTO `title_kinds`
  (`id`, `slug`, `label`, `symmetric`, `format_a`, `format_b`, `exclusive`)
VALUES
  ('parent', 'parent', 'Parent / Child', 0,
   '{gender:Father|Mother|Parent} of {target}',
   '{gender:Son|Daughter|Child} of {target}',
   0);
--> statement-breakpoint

-- Gated on the OLD seed values so a site whose admin already
-- customized the sibling format (via the admin Title Kinds tab)
-- keeps their edit. The new gender-aware default only lands when
-- both formats still match what migration 0018 originally seeded.
-- Same defensive pattern migration 0075 uses for rank thresholds.
UPDATE `title_kinds`
   SET `format_a` = '{gender:Brother|Sister|Sibling} of {target}',
       `format_b` = '{gender:Brother|Sister|Sibling} of {target}',
       `updated_at` = (unixepoch() * 1000)
 WHERE `slug` = 'sibling'
   AND `format_a` = 'Sibling of {target}'
   AND `format_b` = 'Sibling of {target}';
