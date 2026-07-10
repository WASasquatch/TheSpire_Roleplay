-- 0338: Persisted UI language preference (i18n plan, Phase 0).
--
-- BCP-47-ish locale code from the SUPPORTED_LOCALES whitelist ("en", "es";
-- validated in PUT /me/profile, not at the DB layer so adding a locale is a
-- code change, not a schema change). NULL = "System default": the client
-- auto-detects from localStorage / navigator.language and the server falls
-- back to en (or Accept-Language for logged-out flows). Written by the
-- language switcher; read back on /me/profile so the choice follows the
-- account across devices. Phase 0 ships the plumbing only — no user-facing
-- string changes ride this migration.

ALTER TABLE users ADD COLUMN locale TEXT;
