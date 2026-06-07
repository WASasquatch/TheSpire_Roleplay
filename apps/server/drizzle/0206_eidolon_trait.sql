-- Eidolon Tamer personality traits: a per-familiar quirk (Hardy, Gluttonous,
-- Stoic, Vivacious, Pristine, Feral) assigned at hatch that multiplies the
-- species decay knobs, so the daily care routine varies per familiar.
-- Nullable: familiars hatched before this just use their species traits.
ALTER TABLE eidolon_state ADD COLUMN trait TEXT;
