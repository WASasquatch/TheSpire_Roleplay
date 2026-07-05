-- 0323: Google sign-in (OAuth) plumbing.
--
-- `oauth_accounts` links a local `users` row to an external identity provider
-- (currently just Google). One row per (provider, provider_user_id) so the same
-- Google account can't attach to two locals, and one row per (user_id, provider)
-- so a local account holds at most one identity per provider. `provider_email`
-- is the email the provider reported at link time (informational; the local
-- account's own email stays authoritative). Cascade on user delete so unlinking
-- follows account deletion. `has_password` on `users` records whether the
-- account has a usable local password: rows created the normal way default to 1;
-- an account provisioned purely through Google sign-in sets it to 0 so the login
-- UI + password-change flow can adapt. Additive + env-gated: nothing reads any
-- of this until the Google feature is configured and turned on.
CREATE TABLE oauth_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_email TEXT,
  linked_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX oauth_accounts_provider_uid_uq ON oauth_accounts(provider, provider_user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX oauth_accounts_user_provider_uq ON oauth_accounts(user_id, provider);
--> statement-breakpoint
ALTER TABLE users ADD has_password integer NOT NULL DEFAULT 1;
