-- 0301: Server/forum discovery TAGS + registration-agreement RULES.
-- Additive only (ADD COLUMN) — no table rebuilds, no data backfill, fully
-- flag-off-inert. Off by default everywhere: tags NULL, rules HTML empty.

-- Owner-set genre/category tags for discovery search. JSON string[] (lowercased,
-- normalized via shared normalizeTags); NULL = no tags. Searched alongside name.
ALTER TABLE servers ADD COLUMN tags_json TEXT;
ALTER TABLE forums ADD COLUMN tags_json TEXT;

-- Global-admin-authored rules shown WITH an "I agree" checkbox on the
-- server-registration and forum-creation application forms. Mirrors
-- register_disclaimer_html (splash). Empty string = no agreement gate.
ALTER TABLE site_settings ADD COLUMN server_registration_rules_html TEXT NOT NULL DEFAULT '';
ALTER TABLE site_settings ADD COLUMN forum_registration_rules_html TEXT NOT NULL DEFAULT '';

-- Timestamp (ms) the applicant ticked the agreement at submit. NULL for legacy
-- rows and for submissions made while no rules were in force.
ALTER TABLE server_creation_applications ADD COLUMN agreed_at INTEGER;
ALTER TABLE forum_creation_applications ADD COLUMN agreed_at INTEGER;
