-- Servers Lift, Phase 1 (additive): the `servers` container + its relational
-- satellite tables (mirror of forums Phase 0 / 0222). A SERVER is the new
-- top-level tenant ABOVE rooms — the existing single chat ("The Spire") becomes
-- the DEFAULT server every new registrant auto-joins; users may apply to
-- register their own. Canonical DDL: plan.md §5.1.
--
-- This is a near-verbatim clone of `forums` (0222) with the same posture:
--   * slug is globally unique (share URLs `/s/<slug>`), immutable in v1;
--     reserved names rejected at the route layer (shared SERVER_SLUG_RE +
--     RESERVED_SERVER_SLUGS).
--   * is_system = 1 marks the undeletable, catalog-pinned default server;
--     is_default = 1 marks the auto-join target for new registrants (exactly
--     one row, enforced by a partial unique index).
--   * visibility is public-only in practice for now; the column exists so a
--     future "unlisted"/"invite_only" tier is a flip, not a migration.
--   * Branding columns (logo/banner/theme) RE-HOME the per-server slice of the
--     site_settings singleton (siteName->name, logoUrl, bannerCoverCss, theme).
--     Platform identity (SEO meta, custom head HTML, VAPID, registration) stays
--     on the singleton — see 0276 for the per-server settings split.
--
-- §9.2: there is NO `server_reports` table. Per-server message reports use a
-- `reports.server_id` discriminator (added in 0278c) so DM/profile reports stay
-- cleanly NULL=platform and the backfill has a single home to feed.
CREATE TABLE `servers` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `tagline` text,
  `description_html` text,
  `owner_user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  -- The Spire = 1: site-owned, undeletable, catalog-pinned, implicit-member.
  `is_system` integer NOT NULL DEFAULT 0,
  -- Exactly one per install: the auto-join target for new registrants.
  `is_default` integer NOT NULL DEFAULT 0,
  -- featured = admin-curated (pins catalog top); owners flip active/archived.
  `status` text NOT NULL DEFAULT 'active',
  -- public | unlisted | invite_only; v1 is public-only in practice.
  `visibility` text NOT NULL DEFAULT 'public',
  -- open = any signed-in non-banned user may join+chat; application = join
  -- gated by an owner/mod-reviewed membership application; invite = code-gated.
  `join_mode` text NOT NULL DEFAULT 'open',
  -- Anonymous visitors on /s/<slug> may READ the server's public rooms
  -- without an account (mirrors forums.public_browsing). Off by default.
  `public_browsing` integer NOT NULL DEFAULT 0,
  -- Owner-set prompt above the membership application's answer field.
  `application_prompt` text,
  -- Stable per-server landing room (mirror rooms.is_default but server-scoped;
  -- the install-global single-default invariant moves to rooms in 0277).
  -- Nullable until provisioning sets it / the Phase-2 backfill points it at the
  -- canonical landing room.
  `default_room_id` text,
  -- Per-server branding (re-homed from site_settings). Scoped to this server's
  -- chat shell + /s/ page; never bleeds into another server (forums/worlds
  -- theme-scoping pattern; runtime <style> still needs the CSP nonce injector).
  `theme_json` text,
  `theme_style_key` text,
  `logo_url` text,
  `banner_image_url` text,
  `banner_focus_y` integer NOT NULL DEFAULT 50,
  `banner_cover_css` text,
  -- Monogram tint when the server has no logo image.
  `icon_color` text,
  -- JSON array of roomIds giving the owner's explicit room ordering in the rail.
  `room_order_json` text NOT NULL DEFAULT '[]',
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `servers_slug_uq` ON `servers` (lower(`slug`));
--> statement-breakpoint
-- Exactly one auto-join default server per install (mirror rooms_is_default_uq
-- 0036; the per-server room default is enforced separately in 0277).
CREATE UNIQUE INDEX `servers_one_default` ON `servers` (`is_default`) WHERE `is_default` = 1;
--> statement-breakpoint
CREATE INDEX `servers_owner_idx` ON `servers` (`owner_user_id`);
--> statement-breakpoint
CREATE INDEX `servers_status_idx` ON `servers` (`status`);
--> statement-breakpoint

-- Relational membership + role per (server_id, user_id). PER-ACCOUNT (mirrors
-- forum_members / room_members, the lower-risk path; identity-level scoping
-- stays on presence/room_mods which already key per (userId,characterId)).
--   owner  - exactly one per server (the approved applicant).
--   admin  - a mod implicitly holding the full SERVER_MOD_PERMISSIONS set.
--   mod    - owner-appointed; granular powers via permissions_json.
--   member - approved applicant on join_mode='application' servers, or any user
--            who joined an open server (lazily upserted, like room_members) so
--            an owner can manage/ban their roster.
-- The DEFAULT (is_system) server treats every signed-in user as an implicit
-- member with NO row (serverAuthority short-circuits on is_system, exactly as
-- forumAuthority does); explicit member rows are written for management
-- enumeration in Phase 2, not as the access source of truth.
CREATE TABLE `server_members` (
  `server_id` text NOT NULL REFERENCES `servers`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `role` text NOT NULL DEFAULT 'member',
  -- Granular SERVER_MOD_PERMISSIONS keys this mod was granted, as
  -- serializeServerModPermissions output (JSON array). Empty for owners (hold
  -- all implicitly) and members (hold none directly). A SEPARATE per-server
  -- registry, NOT the global PERMISSION_KEYS matrix, so a Server-A mod is not a
  -- Server-B mod and never mints a global mod/admin tier.
  `permissions_json` text NOT NULL DEFAULT '[]',
  `joined_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `server_members_user_idx` ON `server_members` (`user_id`);
--> statement-breakpoint

-- Server-CREATION applications ("Register your own Server"). Reviewed by SITE
-- staff (`review_server_applications`), NOT server owners — mirrors
-- forum_creation_applications (0224). Terminal rows stay as an audit trail; a
-- partial unique index enforces at most one PENDING application per applicant
-- (the route also enforces a re-apply cooldown).
CREATE TABLE `server_creation_applications` (
  `id` text PRIMARY KEY NOT NULL,
  `applicant_user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `requested_name` text NOT NULL,
  `requested_slug` text NOT NULL,
  `purpose` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `submitted_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `reviewed_at` integer,
  `reviewed_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `review_note` text
);
--> statement-breakpoint
CREATE INDEX `server_creation_apps_status_idx`
  ON `server_creation_applications` (`status`, `submitted_at`);
--> statement-breakpoint
CREATE INDEX `server_creation_apps_applicant_idx`
  ON `server_creation_applications` (`applicant_user_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `server_creation_apps_one_pending_uq`
  ON `server_creation_applications` (`applicant_user_id`)
  WHERE `status` = 'pending';
--> statement-breakpoint

-- Per-server membership applications (join_mode='application' servers).
-- Reviewed by the server owner + mods in the Server Settings surface. Mirrors
-- forum_membership_applications (0225); one PENDING per (server, applicant).
CREATE TABLE `server_membership_applications` (
  `id` text PRIMARY KEY NOT NULL,
  `server_id` text NOT NULL REFERENCES `servers`(`id`) ON DELETE CASCADE,
  `applicant_user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `answer` text,
  `status` text NOT NULL DEFAULT 'pending',
  `submitted_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `reviewed_at` integer,
  `reviewed_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `review_note` text
);
--> statement-breakpoint
CREATE INDEX `server_membership_apps_server_idx`
  ON `server_membership_applications` (`server_id`, `status`);
--> statement-breakpoint
CREATE INDEX `server_membership_apps_applicant_idx`
  ON `server_membership_applications` (`applicant_user_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `server_membership_apps_one_pending_uq`
  ON `server_membership_applications` (`server_id`, `applicant_user_id`)
  WHERE `status` = 'pending';
--> statement-breakpoint

-- Per-server usergroups (mirror forum_usergroups 0270). Owner-defined groups
-- granting a set of SERVER_PERMISSIONS (moderation + member-feature gates), as
-- serializeServerPermissions output in permissions_json. Effective perms for a
-- member = union of the default group + every group they're in + any direct mod
-- grant (server_members.permissions_json). The DEFAULT group is the implicit
-- baseline for every participant (no member rows); editing it changes what
-- ungrouped members may do.
CREATE TABLE `server_usergroups` (
  `id` text PRIMARY KEY NOT NULL,
  `server_id` text NOT NULL REFERENCES `servers`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `color` text,
  `permissions_json` text NOT NULL DEFAULT '[]',
  `is_default` integer NOT NULL DEFAULT 0,
  `sort_order` integer NOT NULL DEFAULT 0,
  `auto_rules_json` text NOT NULL DEFAULT '[]',
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX `server_usergroups_server_idx`
  ON `server_usergroups` (`server_id`, `sort_order`);
--> statement-breakpoint
-- One default usergroup per server (mirror 0271). ensureDefaultUsergroup does a
-- check-then-insert; the partial UNIQUE makes a concurrent second insert a
-- no-op (seeder uses ON CONFLICT DO NOTHING + re-select).
CREATE UNIQUE INDEX `server_usergroups_one_default`
  ON `server_usergroups` (`server_id`)
  WHERE `is_default` = 1;
--> statement-breakpoint

CREATE TABLE `server_usergroup_members` (
  `group_id` text NOT NULL REFERENCES `server_usergroups`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `added_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `added_by` text,
  `is_auto` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`group_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `server_usergroup_members_user_idx`
  ON `server_usergroup_members` (`user_id`);
--> statement-breakpoint

-- Per-server bans (mirror forum_bans 0226). Scoped STRICTLY to this server's
-- rooms — gates join/chat/apply only, NEVER the platform login (that stays the
-- global account ban on users.banned_at). Expired rows kept (lazy-ignored) for
-- history. The owner can't be self-banned; site staff can't be server-banned
-- (both enforced in the route, as forums does).
CREATE TABLE `server_bans` (
  `server_id` text NOT NULL REFERENCES `servers`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `until` integer,
  `reason` text,
  `issued_by_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`server_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `server_bans_user_idx` ON `server_bans` (`user_id`);
--> statement-breakpoint

-- Per-server invite codes (net-new; mirrors the room_invites shape) for
-- join_mode='invite' servers. A code grants join rights until used up / expired
-- / revoked. created_by_user_id is a plain nullable text (the issuer may be
-- deleted; the code stays usable until revoked).
CREATE TABLE `server_invites` (
  `id` text PRIMARY KEY NOT NULL,
  `server_id` text NOT NULL REFERENCES `servers`(`id`) ON DELETE CASCADE,
  `code` text NOT NULL UNIQUE,
  `created_by_user_id` text,
  `max_uses` integer,
  `used_count` integer NOT NULL DEFAULT 0,
  `expires_at` integer,
  `revoked_at` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX `server_invites_server_idx` ON `server_invites` (`server_id`);
--> statement-breakpoint

-- Per-user last-visit marker (mirror forum_visits 0231). Drives the rail's
-- "new since you last looked" dot on each round server icon.
CREATE TABLE `server_visits` (
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `server_id` text NOT NULL REFERENCES `servers`(`id`) ON DELETE CASCADE,
  `last_visit_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`user_id`, `server_id`)
);
--> statement-breakpoint

-- Soft feature flag (the plan's "0275-range flag"). Servers ship behind this
-- master-admin toggle on the site_settings singleton; the rail + /s/ routes
-- stay hidden until it flips to 1. Additive, default off, so deploying these
-- migrations changes nothing visible until the owner enables servers.
ALTER TABLE `site_settings` ADD COLUMN `servers_enabled` integer NOT NULL DEFAULT 0;
