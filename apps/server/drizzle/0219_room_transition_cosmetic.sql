-- Room-transition cosmetic (migration 0219): the equipped transition key per
-- identity, mirroring active_name_style_key. The catalog (which transitions
-- exist, their cost/rarity) lives in shared code (ROOM_TRANSITIONS), so these
-- columns carry no FK. NULL = instant switch (no animation). Ownership is
-- tracked in earning_ledger (reason 'purchase_transition_<key>'), like other
-- cosmetics — no owned table needed.
ALTER TABLE user_active_cosmetics ADD COLUMN active_room_transition_key TEXT;
--> statement-breakpoint
ALTER TABLE character_earning ADD COLUMN active_room_transition_key TEXT;
