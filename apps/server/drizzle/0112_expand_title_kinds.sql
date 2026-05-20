-- Expand the title-kinds catalog to cover most family roles + a
-- handful of medieval / modern / sci-fi mentorship and rivalry
-- pairs that roleplay routinely reaches for. All inserts use
-- INSERT OR IGNORE keyed on the slug so a re-run on an install
-- that already added one of these by hand doesn't collide.
--
-- Token reminder (see migration 0111 + titles/service.ts):
--   {target}                  — other party's display name
--   {gender:Male|Female|Neutral}  — picks per subject's gender;
--                                   "Neutral" handles nonbinary /
--                                   other / undisclosed
--
-- Symmetric column meaning:
--   1 (true)  — both sides render with the same format string
--               (but {gender:} still picks per-viewer, so a
--               symmetric kind can still ship gendered words)
--   0 (false) — A side (requester) and B side (recipient) render
--               with DIFFERENT format strings. The asymmetric
--               family roles (grandparent/grandchild,
--               aunt-uncle/niece-nephew, master/apprentice, etc.)
--               live here.
--
-- Exclusive column meaning: when 1, an identity can hold at most
-- one accepted title of this kind across all relationships. Used
-- for "marriage" + "fiance" today; everything else is non-
-- exclusive (a character can have multiple grandparents, multiple
-- mentors, multiple rivals, etc.).

INSERT OR IGNORE INTO `title_kinds`
  (`id`, `slug`, `label`, `symmetric`, `format_a`, `format_b`, `exclusive`)
VALUES
  /* ---- Family ---- */
  ('grandparent', 'grandparent', 'Grandparent / Grandchild', 0,
   '{gender:Grandfather|Grandmother|Grandparent} of {target}',
   '{gender:Grandson|Granddaughter|Grandchild} of {target}',
   0),

  ('aunt_uncle', 'auntuncle', 'Aunt-Uncle / Niece-Nephew', 0,
   '{gender:Uncle|Aunt|Aunt or Uncle} of {target}',
   '{gender:Nephew|Niece|Niece or Nephew} of {target}',
   0),

  -- Cousin reads naturally as a single noun across genders, so we
  -- keep it symmetric and ungendered rather than forcing a
  -- {gender:} variant that would just be "Cousin / Cousin / Cousin".
  ('cousin', 'cousin', 'Cousin', 1,
   'Cousin of {target}',
   'Cousin of {target}',
   0),

  ('in_law_parent', 'inlawparent', 'In-Law Parent / Child', 0,
   '{gender:Father-in-Law|Mother-in-Law|Parent-in-Law} of {target}',
   '{gender:Son-in-Law|Daughter-in-Law|Child-in-Law} of {target}',
   0),

  ('in_law_sibling', 'inlawsibling', 'In-Law Sibling', 1,
   '{gender:Brother-in-Law|Sister-in-Law|Sibling-in-Law} of {target}',
   '{gender:Brother-in-Law|Sister-in-Law|Sibling-in-Law} of {target}',
   0),

  ('step_parent', 'stepparent', 'Stepparent / Stepchild', 0,
   '{gender:Stepfather|Stepmother|Stepparent} of {target}',
   '{gender:Stepson|Stepdaughter|Stepchild} of {target}',
   0),

  ('godparent', 'godparent', 'Godparent / Godchild', 0,
   '{gender:Godfather|Godmother|Godparent} of {target}',
   '{gender:Godson|Goddaughter|Godchild} of {target}',
   0),

  -- Twin: symmetric, gendered. Reads naturally as just "Twin" on
  -- the neutral side; the gendered variants ("Twin Brother / Twin
  -- Sister") preserve the existing sibling-style vocabulary.
  ('twin', 'twin', 'Twin', 1,
   '{gender:Twin Brother|Twin Sister|Twin} of {target}',
   '{gender:Twin Brother|Twin Sister|Twin} of {target}',
   0),

  -- Fiancé / Fiancée. Exclusive=1 like marriage — engaged to one
  -- party at a time. Symmetric, the gender token picks the right
  -- spelling per viewer.
  ('fiance', 'fiance', 'Fiancé(e)', 1,
   'Fiancé{gender:|e|} of {target}',
   'Fiancé{gender:|e|} of {target}',
   1),

  /* ---- Mentorship (medieval flavor) ---- */

  -- Master / Apprentice: the master picks Master vs Mistress vs
  -- Master (neutral) based on their own gender; the apprentice
  -- chip is the same word regardless.
  ('master_apprentice', 'apprentice', 'Master / Apprentice', 0,
   '{gender:Master|Mistress|Master} of {target}',
   'Apprentice of {target}',
   0),

  ('master_disciple', 'disciple', 'Master / Disciple', 0,
   '{gender:Master|Mistress|Master} of {target}',
   'Disciple of {target}',
   0),

  ('master_pupil', 'pupil', 'Master / Pupil', 0,
   '{gender:Master|Mistress|Master} of {target}',
   'Pupil of {target}',
   0),

  /* ---- Mentorship (modern flavor) ---- */
  ('mentor', 'mentor', 'Mentor / Mentee', 0,
   'Mentor of {target}',
   'Mentee of {target}',
   0),

  ('teacher', 'teacher', 'Teacher / Student', 0,
   'Teacher of {target}',
   'Student of {target}',
   0),

  ('coach', 'coach', 'Coach / Player', 0,
   'Coach of {target}',
   'Player of {target}',
   0),

  /* ---- Medieval / fealty ---- */
  ('liege', 'liege', 'Liege / Vassal', 0,
   '{gender:Lord|Lady|Liege} of {target}',
   'Vassal of {target}',
   0),

  ('knight_squire', 'squire', 'Knight / Squire', 0,
   '{gender:Knight|Dame|Knight} of {target}',
   'Squire of {target}',
   0),

  ('monarch', 'monarch', 'Monarch / Subject', 0,
   '{gender:King|Queen|Monarch} of {target}',
   'Sworn to {target}',
   0),

  /* ---- Modern / professional ---- */
  ('boss', 'boss', 'Boss / Employee', 0,
   'Boss of {target}',
   'Employee of {target}',
   0),

  /* ---- Sci-fi / military ---- */
  ('captain', 'captain', 'Captain / Crewmate', 0,
   'Captain of {target}',
   'Crewmate of {target}',
   0),

  ('commander', 'commander', 'Commander / Soldier', 0,
   'Commander of {target}',
   'Soldier under {target}',
   0),

  /* ---- Rivalry / casual ---- */
  ('rival', 'rival', 'Rival', 1,
   'Rival of {target}',
   'Rival of {target}',
   0),

  ('nemesis', 'nemesis', 'Nemesis', 1,
   'Nemesis of {target}',
   'Nemesis of {target}',
   0),

  ('friend', 'friend', 'Friend', 1,
   'Friend of {target}',
   'Friend of {target}',
   0),

  ('ally', 'ally', 'Ally', 1,
   'Ally of {target}',
   'Ally of {target}',
   0);
