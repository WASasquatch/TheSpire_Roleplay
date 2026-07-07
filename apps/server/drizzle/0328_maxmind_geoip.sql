-- 0328: Optional MaxMind GeoLite2-City credentials for the analytics geo
-- accuracy upgrade. When an admin supplies both, the server downloads a
-- GeoLite2-City.mmdb to the persistent /data volume and prefers it over the
-- bundled geoip-lite snapshot. Additive + nullable — absent/NULL means "use the
-- bundled data" (today's behavior), so nothing changes until an admin opts in.
-- The license key is a SECRET column (like vapid_private_key): never serialized
-- to clients; only a `maxmindConfigured` boolean is exposed.
ALTER TABLE site_settings ADD COLUMN maxmind_account_id TEXT;
--> statement-breakpoint
ALTER TABLE site_settings ADD COLUMN maxmind_license_key TEXT;
