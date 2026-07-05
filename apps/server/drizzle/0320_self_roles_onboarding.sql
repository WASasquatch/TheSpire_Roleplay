-- 0320: Self-assignable usergroups + per-server onboarding.
--
-- Two additive changes toward Discord-style member self-service:
--
-- 1) SELF-ROLES. `server_usergroups` gains `member_selectable` (a member may
--    add/remove themselves from the group without a manager) and `description`
--    (member-facing blurb shown next to the toggle). Both nullable/defaulted so
--    every existing group behaves exactly as before (not self-selectable, no
--    blurb) until an owner opts a group in.
--
-- 2) ONBOARDING. `server_settings` gains `onboarding_config_json` (a stored
--    OnboardingConfig: the prompt/question set a new member answers on join,
--    each answer mapping to a self-role) and `onboarding_enabled` (per-server
--    master switch). Both null/0 = no onboarding flow, so nothing changes for
--    servers that don't configure it. These live on the per-server settings row
--    (inherit-null pattern) and are read/merged through getServerSettings.
--
-- Additive; the self-role toggles and onboarding wizard stay dormant until an
-- owner turns them on.

ALTER TABLE server_usergroups ADD COLUMN member_selectable INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE server_usergroups ADD COLUMN description TEXT;
--> statement-breakpoint
ALTER TABLE server_settings ADD COLUMN onboarding_config_json TEXT;
--> statement-breakpoint
ALTER TABLE server_settings ADD COLUMN onboarding_enabled INTEGER;
