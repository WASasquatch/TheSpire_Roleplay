-- Eidolon Tamer progression: lifetime XP earned passively for keeping a
-- familiar well + happy. Drives its level and the currency it fetches when
-- sold. Existing familiars start at 0 (level 1) no retroactive XP.
ALTER TABLE eidolon_state ADD COLUMN xp REAL NOT NULL DEFAULT 0;
