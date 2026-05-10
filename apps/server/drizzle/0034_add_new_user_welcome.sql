-- Admin-configurable "Welcome Message" shown once to logged-in users until
-- they dismiss it. Distinct from the splash-page `welcome_html` (which
-- everyone sees on the login page) - this surface is for messaging the
-- already-logged-in user: announcements, deployment news, "we just
-- shipped X", etc.
--
-- Re-show semantics: every user has a `welcome_seen_hash` storing the
-- SHA hash of the message they last acknowledged. When the admin edits
-- the welcome message, its hash changes; users whose stored hash no longer
-- matches the current one see the modal again on their next /me/profile
-- fetch. Users who acknowledged the current text won't see it twice.
--
-- Empty `new_user_welcome_html` ("") means "no welcome to show" - server
-- sends `null` in the API response and the client renders nothing.

ALTER TABLE `site_settings`
  ADD COLUMN `new_user_welcome_html` text NOT NULL DEFAULT '';--> statement-breakpoint

ALTER TABLE `users`
  ADD COLUMN `welcome_seen_hash` text;
