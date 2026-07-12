-- Server-stamped role-picker marker on messages.
-- A /roleselect panel used to be recognized by its BODY ({role:<id>} token
-- lines), but the body is user-controlled: any member could type the tokens
-- into a plain say and mint an interactive picker without the command's
-- manage_usergroups gate. This column is written ONLY by the /roleselect
-- command path (the same gated-write posture as poll_data_json on kind =
-- 'poll'); every hydration point keys on it, so a forged body renders as
-- plain text — never clickable.
ALTER TABLE `messages` ADD COLUMN `is_role_select` integer NOT NULL DEFAULT 0;
