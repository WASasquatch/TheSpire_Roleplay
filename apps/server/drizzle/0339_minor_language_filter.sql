-- 0339: Minor language filter (age-restriction plan Phase 7, plan_ext.md §J).
--
-- Masks strong language for under-18 viewers at READ time. Three columns on
-- site_settings, mirroring the anti-spam/automod master-switch shape:
--
--   1) minor_filter_enabled — master switch. Default ON, deliberately: the
--      filter only ever affects under-18 viewers (adults ALWAYS see the
--      original message), so a fresh install is protective-by-default the
--      moment minor accounts exist. Flipping it off is a console action.
--   2) minor_filter_terms_json — admin-editable ADDED words (JSON string
--      array). Folded into the matcher on top of obscenity's English preset
--      for community-specific or non-English terms.
--   3) minor_filter_allow_json — admin-editable NEVER-CENSOR words (JSON
--      string array). Fixes Scunthorpe-class false positives.
--
-- The matcher lives in apps/server/src/realtime/minorLanguageFilter.ts and is
-- rebuilt whenever the settings cache reseeds. Stored messages are NEVER
-- modified — masking happens where payloads are built, per viewer age.

ALTER TABLE site_settings ADD COLUMN minor_filter_enabled INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE site_settings ADD COLUMN minor_filter_terms_json TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE site_settings ADD COLUMN minor_filter_allow_json TEXT NOT NULL DEFAULT '[]';
