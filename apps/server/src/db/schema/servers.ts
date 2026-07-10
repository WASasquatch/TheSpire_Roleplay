import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { id, ts } from "./_helpers.js";
import { rooms } from "./chat.js";
import { forums } from "./forums.js";
import { characters, users } from "./users.js";

/* ===========================================================================
 * Servers Lift, Phase 1 (migrations 0275-0277). A SERVER is the new top-level
 * tenant ABOVE rooms/forums — the existing single chat ("The Spire") becomes
 * the DEFAULT server every new registrant auto-joins; users may apply to
 * register their own. These are near-verbatim clones of the forum analogs
 * above (forums / forum_members / forum_usergroups / …) with the same posture.
 * ======================================================================== */

/**
 * The `servers` container (migration 0275). Mirror of `forums` (0222):
 *   - slug is globally unique (`/s/<slug>`), immutable in v1; reserved names
 *     rejected at the route layer (shared SERVER_SLUG_RE + RESERVED_SERVER_SLUGS).
 *   - isSystem = true marks the undeletable, catalog-pinned default server.
 *   - isDefault = true marks the auto-join target for new registrants (exactly
 *     one row, enforced by the partial unique index `servers_one_default`).
 *   - Branding columns RE-HOME the per-server slice of the site_settings
 *     singleton; platform identity stays on the singleton (see serverSettings).
 */
export const servers = sqliteTable(
  "servers",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    tagline: text("tagline"),
    descriptionHtml: text("description_html"),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The Spire = true: site-owned, undeletable, catalog-pinned, implicit-member. */
    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    /** Exactly one per install: the auto-join target for new registrants. */
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    /** featured = admin-curated (pins catalog top); owners flip active/archived. */
    status: text("status", { enum: ["active", "featured", "archived"] })
      .notNull()
      .default("active"),
    /** public | unlisted | invite_only; v1 is public-only in practice. */
    visibility: text("visibility", { enum: ["public", "unlisted", "invite_only"] })
      .notNull()
      .default("public"),
    /** open = any signed-in non-banned user may join+chat; application = join
     *  gated by an owner/mod-reviewed membership application; invite = code-gated. */
    joinMode: text("join_mode", { enum: ["open", "application", "invite"] })
      .notNull()
      .default("open"),
    /** Anonymous visitors on /s/<slug> may READ the server's public rooms
     *  without an account (mirrors forums.publicBrowsing). Off by default. */
    publicBrowsing: integer("public_browsing", { mode: "boolean" }).notNull().default(false),
    /**
     * "18+ community" flag (migration 0335, age-restriction plan). When
     * true, minors can't see or join the server anywhere — the age check
     * folds into serverAuthority.canParticipate beside the moderation
     * gate, so every chokepoint (discover, detail, by-slug, visit, join,
     * room deep-link, socket join) inherits it — and every room inside is
     * effectively 18+ (`server.is_nsfw OR room.is_nsfw`). The
     * system/default server can NEVER be 18+ (route rejection + seed
     * invariant); the official adult partition is a sibling server.
     */
    isNsfw: integer("is_nsfw", { mode: "boolean" }).notNull().default(false),
    /**
     * Optional public-safe banner variant (migration 0335, decision #10).
     * Surfaces shown to viewers who can't see NSFW (discovery cards, the
     * /s/<slug> share page, OG meta) render THIS instead of
     * `bannerImageUrl` when the server is 18+; NULL falls back to an
     * art-less name/colors card. SFW servers never need it — their real
     * banner must be safe for all audiences by site rule.
     */
    sfwBannerUrl: text("sfw_banner_url"),
    /** Owner-set prompt above the membership application's answer field. */
    applicationPrompt: text("application_prompt"),
    /** Stable per-server landing room (server-scoped mirror of rooms.isDefault).
     *  Nullable until provisioning / the Phase-2 backfill points it. No FK
     *  (the ALTER adds none — kept a plain text id). */
    defaultRoomId: text("default_room_id"),
    /** Per-server branding (re-homed from site_settings). Scoped to this
     *  server's chat shell + /s/ page; never bleeds into another server. */
    themeJson: text("theme_json"),
    themeStyleKey: text("theme_style_key"),
    logoUrl: text("logo_url"),
    bannerImageUrl: text("banner_image_url"),
    bannerFocusY: integer("banner_focus_y").notNull().default(50),
    bannerCoverCss: text("banner_cover_css"),
    /** Monogram tint when the server has no logo image. */
    iconColor: text("icon_color"),
    /** Owner-set accent ring around the rail icon (shows even on logo tiles). */
    borderColor: text("border_color"),
    /** Wide wordmark logo that replaces the app logo in the top bar inside this
     *  server (distinct from logoUrl, the square rail icon). */
    horizontalLogoUrl: text("horizontal_logo_url"),
    /** Pan/zoom focus for the icon + banner — AvatarCrop JSON
     *  ({zoom,offsetX,offsetY}); NULL = centered, no zoom. banner_crop
     *  supersedes banner_focus_y for new positioning. */
    iconCrop: text("icon_crop"),
    bannerCrop: text("banner_crop"),
    /** Owner-set top-bar banner height in px. NULL = default responsive height. */
    bannerHeight: integer("banner_height"),
    /** JSON array of roomIds giving the owner's explicit room ordering in the rail. */
    roomOrderJson: text("room_order_json").notNull().default("[]"),
    /** Owner-set genre/category tags for discovery search (migration 0301).
     *  JSON string[] (lowercased/normalized via shared normalizeTags); NULL =
     *  none. Searched alongside name in the discover modal's search mode. */
    tagsJson: text("tags_json"),
    /** Global-admin moderation state (migration 0306). 'suspended' = indefinite
     *  "under review" hold; 'banned' = auto-expires once moderationUntil passes
     *  (lazy expiry — the row is never cleaned up). A ban past its until behaves
     *  exactly like 'none' EVERYWHERE. Only the server owner, the owner's
     *  admins/mods, and global staff (manage_any_server) may enter while active;
     *  everyone else is blocked at serverAuthority.canParticipate and hidden from
     *  discovery/catalog. The isSystem/home server can NEVER be moderated. */
    moderationState: text("moderation_state", { enum: ["none", "suspended", "banned"] })
      .notNull()
      .default("none"),
    /** When a 'banned' state auto-expires (timestamp ms; NULL = indefinite).
     *  Ignored for 'suspended' (which never expires without a manual lift).
     *  Lazy-evaluated at read time — see isServerModerationActive. */
    moderationUntil: integer("moderation_until", { mode: "timestamp_ms" }),
    /** Optional free-text note from the global admin (shown after the notice). */
    moderationNote: text("moderation_note"),
    /** FK to the global admin who issued the moderation. SET NULL on account
     *  delete so the moderation record survives the actor's removal. */
    moderationByUserId: text("moderation_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** When the moderation was issued (timestamp ms; NULL for legacy rows). */
    moderationAt: integer("moderation_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    slugUq: uniqueIndex("servers_slug_uq").on(sql`lower(${t.slug})`),
    ownerIdx: index("servers_owner_idx").on(t.ownerUserId),
    statusIdx: index("servers_status_idx").on(t.status),
    // A partial UNIQUE `servers_one_default` on (is_default) WHERE is_default=1
    // (migration 0275) enforces exactly one auto-join default server per
    // install. Drizzle can't model partial indexes, so it lives in the SQL only.
  }),
);
export type DbServer = typeof servers.$inferSelect;

/**
 * Relational membership + role per (server, user) (migration 0275). PER-ACCOUNT
 * (mirror forum_members). owner (one per server) / admin / mod (granular via
 * permissionsJson) / member. The DEFAULT (isSystem) server treats every
 * signed-in user as an implicit member with NO row — explicit rows are written
 * for management enumeration, not as the access source of truth.
 */
export const serverMembers = sqliteTable(
  "server_members",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "mod", "member"] })
      .notNull()
      .default("member"),
    /** Granular SERVER_MOD_PERMISSIONS keys this mod was granted, as
     *  serializeServerModPermissions output (JSON array). Empty for owners and
     *  members. A SEPARATE per-server registry, NOT the global PERMISSION_KEYS
     *  matrix — never mints a global mod/admin tier. */
    permissionsJson: text("permissions_json").notNull().default("[]"),
    joinedAt: ts("joined_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.userId] }),
    userIdx: index("server_members_user_idx").on(t.userId),
  }),
);
export type DbServerMember = typeof serverMembers.$inferSelect;

/**
 * Server-CREATION applications ("Register your own Server") (migration 0275).
 * Reviewed by SITE staff (`review_server_applications`), NOT server owners —
 * mirror forum_creation_applications. A partial unique index enforces at most
 * one PENDING application per applicant (lives in the SQL).
 */
export const serverCreationApplications = sqliteTable(
  "server_creation_applications",
  {
    id: id(),
    applicantUserId: text("applicant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedName: text("requested_name").notNull(),
    requestedSlug: text("requested_slug").notNull(),
    purpose: text("purpose").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected", "withdrawn"] })
      .notNull()
      .default("pending"),
    submittedAt: ts("submitted_at"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewNote: text("review_note"),
    /** When the applicant ticked the registration-rules agreement (migration
     *  0301). NULL = legacy / no rules in force at submit. */
    agreedAt: integer("agreed_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    statusIdx: index("server_creation_apps_status_idx").on(t.status, t.submittedAt),
    applicantIdx: index("server_creation_apps_applicant_idx").on(t.applicantUserId, t.status),
    // Partial UNIQUE `server_creation_apps_one_pending_uq` on (applicant_user_id)
    // WHERE status='pending' (migration 0275) lives in the SQL only.
  }),
);
export type DbServerCreationApplication = typeof serverCreationApplications.$inferSelect;

/**
 * Per-server membership applications (joinMode='application' servers)
 * (migration 0275). Reviewed by the server owner + mods. Mirror
 * forum_membership_applications; one PENDING per (server, applicant).
 */
export const serverMembershipApplications = sqliteTable(
  "server_membership_applications",
  {
    id: id(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    applicantUserId: text("applicant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    answer: text("answer"),
    status: text("status", { enum: ["pending", "approved", "rejected", "withdrawn"] })
      .notNull()
      .default("pending"),
    submittedAt: ts("submitted_at"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewNote: text("review_note"),
  },
  (t) => ({
    serverStatusIdx: index("server_membership_apps_server_idx").on(t.serverId, t.status),
    applicantIdx: index("server_membership_apps_applicant_idx").on(t.applicantUserId, t.status),
    // Partial UNIQUE `server_membership_apps_one_pending_uq` on
    // (server_id, applicant_user_id) WHERE status='pending' lives in the SQL.
  }),
);
export type DbServerMembershipApplication = typeof serverMembershipApplications.$inferSelect;

/**
 * Per-server usergroups (migration 0275, mirror forum_usergroups). Owner-defined
 * groups granting a set of SERVER_PERMISSIONS as serializeServerPermissions
 * output. Effective perms for a member = union of the default group + every
 * group they're in + any direct mod grant (server_members.permissionsJson).
 */
export const serverUsergroups = sqliteTable(
  "server_usergroups",
  {
    id: id(),
    serverId: text("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    permissionsJson: text("permissions_json").notNull().default("[]"),
    /** Exactly one per server: the implicit baseline for every participant. */
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    autoRulesJson: text("auto_rules_json").notNull().default("[]"),
    /**
     * Self-role toggle (migration 0320). When true a member may add/remove
     * themselves from this group without a manager (Discord-style self-roles).
     * Default false = manager-managed as before.
     */
    memberSelectable: integer("member_selectable", { mode: "boolean" }).notNull().default(false),
    /** Member-facing blurb shown next to the self-role toggle / onboarding option (migration 0320). Null = none. */
    description: text("description"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    serverIdx: index("server_usergroups_server_idx").on(t.serverId, t.sortOrder),
    // Partial UNIQUE `server_usergroups_one_default` on (server_id) WHERE
    // is_default = 1 (migration 0275) lives in the SQL only.
  }),
);
export type DbServerUsergroup = typeof serverUsergroups.$inferSelect;

/**
 * Explicit (non-default) server usergroup memberships (migration 0275).
 * `addedBy` null + `isAuto` true = an automatic membership via the group's
 * auto-join rules; a manual add records the acting manager with `isAuto` false.
 */
export const serverUsergroupMembers = sqliteTable(
  "server_usergroup_members",
  {
    groupId: text("group_id").notNull().references(() => serverUsergroups.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    addedAt: ts("added_at"),
    addedBy: text("added_by"),
    isAuto: integer("is_auto", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.userId] }),
    userIdx: index("server_usergroup_members_user_idx").on(t.userId),
  }),
);
export type DbServerUsergroupMember = typeof serverUsergroupMembers.$inferSelect;

/**
 * Per-server bans (migration 0275, mirror forum_bans). Scoped STRICTLY to this
 * server's rooms — gates join/chat/apply only, NEVER the platform login.
 * `until` null = permanent. Expired rows kept (lazy-ignored) for history.
 */
export const serverBans = sqliteTable(
  "server_bans",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    until: integer("until", { mode: "timestamp_ms" }),
    reason: text("reason"),
    issuedById: text("issued_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.userId] }),
    userIdx: index("server_bans_user_idx").on(t.userId),
  }),
);
export type DbServerBan = typeof serverBans.$inferSelect;

/**
 * Per-server invite codes (migration 0275; mirror room_invites) for
 * joinMode='invite' servers. A code grants join rights until used up / expired
 * / revoked. createdByUserId is a plain nullable text (the issuer may be
 * deleted; the code stays usable until revoked).
 */
export const serverInvites = sqliteTable(
  "server_invites",
  {
    id: id(),
    serverId: text("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
    code: text("code").notNull().unique(),
    createdByUserId: text("created_by_user_id"),
    maxUses: integer("max_uses"),
    usedCount: integer("used_count").notNull().default(0),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    serverIdx: index("server_invites_server_idx").on(t.serverId),
  }),
);
export type DbServerInvite = typeof serverInvites.$inferSelect;

/**
 * Per-user last-visit marker (migration 0275, mirror forum_visits). Drives the
 * rail's "new since you last looked" dot on each round server icon.
 */
export const serverVisits = sqliteTable(
  "server_visits",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    lastVisitAt: ts("last_visit_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.serverId] }),
  }),
);
export type DbServerVisit = typeof serverVisits.$inferSelect;

/**
 * Per-server economy backfill latch (migration 0287). One row per server,
 * idempotency marker for the economy backfill / provisioning pass (Team H
 * runtime). `completedAt` is null until that server's per-server economy
 * initialization has run to completion; a non-null timestamp makes a re-run a
 * no-op. The default (is_system) server is seeded as already-complete because
 * migrations 0282-0286 + the Phase-2 backfill already homed all existing data
 * to it. No FK to `servers` on purpose: the latch may be stamped during
 * provisioning before/independently of the server row's own lifecycle, and a
 * dangling latch row is harmless.
 */
export const serverBackfillState = sqliteTable("server_backfill_state", {
  serverId: text("server_id").primaryKey(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});
export type DbServerBackfillState = typeof serverBackfillState.$inferSelect;

/**
 * Per-server settings row (migration 0276). The per-server BEHAVIOR slice split
 * out of the site_settings singleton (retention, caps, edit grace, default
 * look, welcome/rules HTML, forum caps, earning config, flash sale). NULL
 * columns mean "inherit the platform default" so an all-NULL row behaves
 * exactly like the legacy global config until the owner tunes something.
 */
export const serverSettings = sqliteTable("server_settings", {
  serverId: text("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  // chat behavior (NULL = inherit platform default)
  messageRetentionMs: integer("message_retention_ms"),
  maxRoomsPerOwner: integer("max_rooms_per_owner"),
  maxMessageLength: integer("max_message_length"),
  editGraceMs: integer("edit_grace_ms"),
  // per-server default look (scoped to this server's shell; never bleeds)
  defaultThemeJson: text("default_theme_json"),
  defaultStyleKey: text("default_style_key"),
  themeDesignMap: text("theme_design_map"),
  // per-community content (re-homed rules/securityNotice/newUserWelcome)
  rulesHtml: text("rules_html"),
  securityNoticeHtml: text("security_notice_html"),
  welcomeHtml: text("welcome_html"),
  newUserWelcomeHtml: text("new_user_welcome_html"),
  // per-server forum caps
  maxForumPostLength: integer("max_forum_post_length"),
  forumTopicsPerPage: integer("forum_topics_per_page"),
  // per-server economy (full economy lands in Phase 5b; this is its home)
  earningConfigJson: text("earning_config_json"),
  flashSaleEnabled: integer("flash_sale_enabled", { mode: "boolean" }),
  // Per-server EARNING SUBSYSTEM toggles (migration 0293; NULL = inherit the
  // platform default = enabled). A server owner can turn off a whole subsystem
  // (its catalog section hides + purchases reject). "nothing stays global" —
  // each server runs the earning features it wants.
  shopEnabled: integer("shop_enabled", { mode: "boolean" }),
  ranksEnabled: integer("ranks_enabled", { mode: "boolean" }),
  nameStylesEnabled: integer("name_styles_enabled", { mode: "boolean" }),
  bordersEnabled: integer("borders_enabled", { mode: "boolean" }),
  roomTransitionsEnabled: integer("room_transitions_enabled", { mode: "boolean" }),
  cosmeticsEnabled: integer("cosmetics_enabled", { mode: "boolean" }),
  // Per-server onboarding (migration 0320). NULL = no onboarding flow.
  // `onboardingConfigJson` is a stored OnboardingConfig (the prompt set a new
  // member answers on join, each answer mapping to a self-role usergroup);
  // `onboardingEnabled` is the per-server master switch (NULL/false = off).
  onboardingConfigJson: text("onboarding_config_json"),
  onboardingEnabled: integer("onboarding_enabled", { mode: "boolean" }),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
  updatedById: text("updated_by_id").references(() => users.id, { onDelete: "set null" }),
});
export type DbServerSettings = typeof serverSettings.$inferSelect;

/**
 * Per-(user, server) one-time welcome dismissal (migration 0276). The
 * singleton's per-account welcome_seen_hash can't express "seen server A's
 * welcome but not B's". Absent row = not yet seen; the hash gates re-show when
 * the owner edits the welcome copy.
 */
export const serverWelcomeSeen = sqliteTable(
  "server_welcome_seen",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    seenHash: text("seen_hash").notNull().default(""),
    seenAt: ts("seen_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.serverId] }),
  }),
);
export type DbServerWelcomeSeen = typeof serverWelcomeSeen.$inferSelect;

/**
 * Per-(user, server) last room (migration 0277, server-scoped mirror of
 * users.lastRoomId). A multi-server user needs to return to the right room in
 * EACH server on reconnect / server switch; the per-tab tabRoomId cache still
 * wins above it.
 */
export const userServerLastRoom = sqliteTable(
  "user_server_last_room",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null" }),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.serverId] }),
  }),
);
export type DbUserServerLastRoom = typeof userServerLastRoom.$inferSelect;

/* ---------- server events (migration 0317) ----------
 * Scheduled community events (calendar) per server, plus RSVPs. An event is
 * scoped to a server (FK cascade), created by a member optionally voicing a
 * character; starts/ends are ms epoch (ends nullable = open-ended). Optional
 * deep links to a room/forum. `status` moves scheduled -> live -> ended /
 * cancelled. `reminderLeadMs`/`reminderFiredAt` drive an opt-in "starting
 * soon" ping fired at most once. `recurrenceJson` is RESERVED for future
 * repeating events. Gated by the `manage_events` SERVER permission. */
export const serverEvents = sqliteTable(
  "server_events",
  {
    id: id(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    hostCharacterId: text("host_character_id").references(() => characters.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    /** Curated Lucide icon slug shown before the title; null = no icon. */
    icon: text("icon"),
    descriptionHtml: text("description_html"),
    /** Start time, ms epoch. */
    startsAt: integer("starts_at").notNull(),
    /** End time, ms epoch; null = open-ended. */
    endsAt: integer("ends_at"),
    linkedRoomId: text("linked_room_id").references(() => rooms.id, { onDelete: "set null" }),
    linkedForumId: text("linked_forum_id").references(() => forums.id, { onDelete: "set null" }),
    /** scheduled | live | ended | cancelled. */
    status: text("status").notNull().default("scheduled"),
    /** Opt-in reminder lead time in ms before startsAt; null = no reminder. */
    reminderLeadMs: integer("reminder_lead_ms"),
    /** Stamped when the reminder fired so it only fires once; null = not yet. */
    reminderFiredAt: integer("reminder_fired_at"),
    /** RESERVED for future repeating-event rules (unused today). */
    recurrenceJson: text("recurrence_json"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    serverTimeIdx: index("server_events_server_time_idx").on(t.serverId, t.startsAt),
  }),
);

export const serverEventRsvps = sqliteTable(
  "server_event_rsvps",
  {
    id: id(),
    eventId: text("event_id")
      .notNull()
      .references(() => serverEvents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Identity the member RSVP'd as; null = OOC. */
    characterId: text("character_id").references(() => characters.id, { onDelete: "set null" }),
    /** going | maybe | declined (feature team owns the vocabulary). */
    status: text("status").notNull(),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    eventUserCharUq: uniqueIndex("server_event_rsvps_event_user_char_uq").on(t.eventId, t.userId, t.characterId),
    eventStatusIdx: index("server_event_rsvps_event_status_idx").on(t.eventId, t.status),
  }),
);

/* ---------- contextual tour tracking (migration 0321) ----------
 * Per-surface first-time tours, tracked independently of the single site tour
 * (`users.tour_seen_version`, migration 0312). One row per (user, tour) with a
 * monotonic `seenVersion`; /me/profile reports each tour whose shared catalog
 * version (TOURS[id].version) is ahead of the stored value as `toursToShow`,
 * and POST /me/tours/:tourId/dismiss upserts the current version + dismissedAt.
 * Absent row = seenVersion 0 (never seen). Composite PK, same shape as
 * roomReads / perRoomNotifyPrefs. */
export const tourSeen = sqliteTable(
  "tour_seen",
  {
    userId: text("user_id").notNull(),
    tourId: text("tour_id").notNull(),
    /** Highest tour catalog version this user has acknowledged (0 = never). */
    seenVersion: integer("seen_version").notNull().default(0),
    /** ms epoch of the most recent dismissal; null until first dismissed. */
    dismissedAt: integer("dismissed_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.tourId] }),
  }),
);
export type DbTourSeen = typeof tourSeen.$inferSelect;
export type DbServerEvent = typeof serverEvents.$inferSelect;
export type DbServerEventRsvp = typeof serverEventRsvps.$inferSelect;
