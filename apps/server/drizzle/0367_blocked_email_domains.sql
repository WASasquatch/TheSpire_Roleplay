-- Admin-editable extra disposable/temporary email domains to block at signup.
--
-- The register route blocks a vendored list of well-known throwaway providers
-- (temp-mail, 10minutemail, mailinator, …); this column lets an admin add more
-- as they appear WITHOUT a deploy. Newline/comma separated; merged with the
-- vendored list. Empty = just the vendored list.
ALTER TABLE site_settings ADD COLUMN blocked_email_domains text NOT NULL DEFAULT '';
