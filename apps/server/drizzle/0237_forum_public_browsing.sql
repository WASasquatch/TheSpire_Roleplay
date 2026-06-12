-- Forums: owner-controlled PUBLIC BROWSING. When set, anonymous visitors
-- on /f/<slug> can read boards, topics, and replies without an account
-- (read-only); joining and posting still require login. Off by default -
-- owners opt their community into the open web.
ALTER TABLE `forums` ADD COLUMN `public_browsing` INTEGER NOT NULL DEFAULT 0;
