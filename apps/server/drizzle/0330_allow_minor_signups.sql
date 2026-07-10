-- 0330: The one flag of the age-restriction plan ("the flip").
--
-- Controls ONLY the registration minimum age: OFF (default) keeps the
-- effective 18+ floor (now enforced by date of birth instead of the old
-- discarded checkbox); ON lowers it to 13. Every other age gate ships
-- always-on as unconditional code — they are no-ops until minor accounts
-- exist, so deploying is behavior-neutral while the community pre-tags
-- 18+ spaces. Flipping back OFF stops NEW minor signups only; existing
-- minor accounts keep their gates.

ALTER TABLE site_settings ADD COLUMN allow_minor_signups INTEGER NOT NULL DEFAULT 0;
