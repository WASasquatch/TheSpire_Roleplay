-- Eidolon Tamer daily-engagement loop: a care-streak (consecutive days the
-- familiar is tended, with a one-day grace before reset) that grants a passive
-- XP multiplier + milestone currency, plus opt-in "needs you" push nudges.
-- Additive columns on eidolon_state; existing familiars start at streak 0 (no
-- retroactive credit). nudge_optin defaults ON (1) — still requires a browser
-- push subscription and is toggleable off in-game.
ALTER TABLE eidolon_state ADD COLUMN streak_count INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE eidolon_state ADD COLUMN last_checkin_day_key TEXT;
--> statement-breakpoint
ALTER TABLE eidolon_state ADD COLUMN best_streak INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE eidolon_state ADD COLUMN nudge_optin INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE eidolon_state ADD COLUMN last_nudge_day_key TEXT;
