-- Per-user toggle: render the Earning rank sigil in place of the
-- gender glyph in userlist rows. Off by default so installs without
-- ranked content behave exactly as before. When the user flips it on
-- AND has a resolved rank, the userlist swaps the gender glyph for
-- the rank sigil — saves a column of horizontal space in the rail
-- and makes the rank itself the profile click target.
ALTER TABLE users ADD COLUMN use_rank_as_userlist_icon INTEGER NOT NULL DEFAULT 0;
