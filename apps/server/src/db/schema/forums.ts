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
import { messages, rooms } from "./chat.js";
import { servers } from "./servers.js";
import { users } from "./users.js";
import { worlds } from "./worlds.js";

/* ============================================================
 * Forums — user-owned message boards (plan.md "Forums Revamp").
 *
 * A forum is a CONTAINER above rooms: `rooms.forumId` set ⇒ that room
 * is a "board" inside the forum (always replyMode "nested"). Topics,
 * replies, stickies, locks, reports, and earning awards all keep
 * living on the rooms/messages tables — these tables only add the
 * container, its roles, its bans, and the two application workflows
 * (forum creation, reviewed by site staff; forum membership, reviewed
 * by the forum owner/mods when postingMode = "application").
 * ============================================================ */

export const forums = sqliteTable(
  "forums",
  {
    id: id(),
    /** Share-URL slug (`/f/<slug>`), canonical lowercase [a-z0-9_]{3,40},
     *  globally unique, immutable in v1 so share links never rot.
     *  Reserved names are rejected at the route layer (shared
     *  RESERVED_FORUM_SLUGS). */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** Short purpose line, seeded from the creation application. */
    tagline: text("tagline"),
    /** Owner-editable long description (sanitized like profile bios). */
    descriptionHtml: text("description_html"),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The Spire Forums = true: site-owned, undeletable, catalog-pinned. */
    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    /** `featured` is admin-curated (pins to catalog top); owners flip
     *  between active and archived. */
    status: text("status", { enum: ["active", "featured", "archived"] })
      .notNull()
      .default("active"),
    /** Reserved for a future "hidden" tier — v1 is public-only, the
     *  column exists so that becomes a flip, not a migration. */
    visibility: text("visibility", { enum: ["public"] }).notNull().default("public"),
    /** open = any signed-in non-banned user may post; application =
     *  membership application reviewed by owner/mods. */
    postingMode: text("posting_mode", { enum: ["open", "application"] })
      .notNull()
      .default("open"),
    /** Owner toggle (migration 0237): anonymous visitors on /f/<slug>
     *  may READ boards/topics/replies without an account. Posting and
     *  joining always require login. Off by default. */
    publicBrowsing: integer("public_browsing", { mode: "boolean" }).notNull().default(false),
    /**
     * Whole-forum 18+ flag (migration 0336, age-restriction plan). When
     * true: excluded from the forums catalog + discover search for viewers
     * who can't see NSFW; /f/<slug> behaves like a non-publicBrowsing
     * forum for minors/anonymous (teaser only, generic OG meta); every
     * board inherits the gate. Individual BOARDS need no column — boards
     * are rooms, so `rooms.is_nsfw` covers board-level 18+. Owner toggle,
     * adult-only write, audited (`forum_nsfw_update`).
     */
    isNsfw: integer("is_nsfw", { mode: "boolean" }).notNull().default(false),
    /**
     * Optional public-safe banner variant (migration 0336, decision #10).
     * Mirrors servers.sfwBannerUrl: shown on public/discovery surfaces to
     * viewers who can't see NSFW when the forum is 18+; NULL = art-less
     * name/colors fallback.
     */
    sfwBannerUrl: text("sfw_banner_url"),
    /** Owner toggle (migration 0268): when true, a mod holding the
     *  `create_tags` granular permission may mint a topic tag on the fly when
     *  tagging a topic. Off = the curated catalog only, offered per category. */
    allowCustomTags: integer("allow_custom_tags", { mode: "boolean" }).notNull().default(false),
    /** Owner-set prompt above the membership application's answer field
     *  (migration 0230). Null = a generic "tell the keeper why" prompt. */
    applicationPrompt: text("application_prompt"),
    /** Per-forum theme JSON (normalizeTheme on read). Scoped to the forum
     *  modal + /f/ page only — never bleeds into chat (worlds pattern). */
    themeJson: text("theme_json"),
    /** Per-forum DESIGN style (ornaments/chrome: medieval, glass, …) —
     *  orthogonal to the palette, mirrors users.style_key. Null = the
     *  viewer's own design. Scoped to the forum's card (migration 0232). */
    themeStyleKey: text("theme_style_key"),
    logoUrl: text("logo_url"),
    bannerImageUrl: text("banner_image_url"),
    /** Vertical banner focus: 0 = show the image's top band, 100 = the
     *  bottom, 50 = center (migration 0234). Cover-cropping picks the
     *  band; the keeper picks which one. */
    bannerFocusY: integer("banner_focus_y").notNull().default(50),
    /** Optional world attachment: the forum header shows the world's
     *  banner strip with view/join/apply actions. */
    linkedWorldId: text("linked_world_id").references(() => worlds.id, { onDelete: "set null" }),
    /** JSON array of roomIds giving the owner's explicit board ordering;
     *  boards missing from the list sort by createdAt after it. */
    boardOrderJson: text("board_order_json").notNull().default("[]"),
    /**
     * Server container (migration 0277). A forum belongs to a server: server is
     * the OUTER container, forum the INNER sub-container, room the leaf. ON
     * DELETE SET NULL so deleting a server un-homes its forums rather than
     * destroying them; the app treats NULL as the default server. NULL until
     * the Phase-2 backfill.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
    /** Owner-set genre/category tags for discovery search (migration 0301).
     *  JSON string[] (lowercased/normalized via shared normalizeTags); NULL =
     *  none. Mirrors servers.tagsJson for the identical forum discover UX. */
    tagsJson: text("tags_json"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    slugUq: uniqueIndex("forums_slug_uq").on(sql`lower(${t.slug})`),
    ownerIdx: index("forums_owner_idx").on(t.ownerUserId),
    statusIdx: index("forums_status_idx").on(t.status),
    serverIdx: index("forums_server_idx").on(t.serverId),
  }),
);

/**
 * Forum-creation applications — the "Create your Forum" workflow.
 * Reviewed by site staff (`review_forum_applications`), NOT forum
 * owners. Same lifecycle + audit posture as world_applications:
 * terminal rows stay; a partial unique index (migration 0224) enforces
 * at most one PENDING application per applicant.
 */
export const forumCreationApplications = sqliteTable(
  "forum_creation_applications",
  {
    id: id(),
    applicantUserId: text("applicant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedName: text("requested_name").notNull(),
    requestedSlug: text("requested_slug").notNull(),
    /** The application's "what is your forum for" prose (30..500 chars). */
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
    statusIdx: index("forum_creation_apps_status_idx").on(t.status, t.submittedAt),
    applicantIdx: index("forum_creation_apps_applicant_idx").on(t.applicantUserId, t.status),
    // "One pending per applicant" partial unique index lives in the
    // migration (drizzle's builder doesn't model partial indexes); the
    // route layer also pre-checks and maps races to 409.
  }),
);

/**
 * Forum membership + roles. Only meaningful rows:
 *   - owner: exactly one per forum (the approved applicant; transferable
 *     by site staff later).
 *   - mod:   owner-assigned helpers (topic-level powers only).
 *   - member: approved applicants when postingMode = "application".
 * Open-posting forums don't require membership rows to post.
 */
export const forumMembers = sqliteTable(
  "forum_members",
  {
    forumId: text("forum_id")
      .notNull()
      .references(() => forums.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "mod", "member"] })
      .notNull()
      .default("member"),
    /** Granular mod permissions (migration 0264): JSON array of
     *  FORUM_MOD_PERMISSIONS keys the owner granted this mod. Empty for
     *  owners/members (owners hold all implicitly; members hold none).
     *  Parse via parseForumModPermissions; write via serializeForumModPermissions. */
    permissionsJson: text("permissions_json").notNull().default("[]"),
    joinedAt: ts("joined_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.forumId, t.userId] }),
    userIdx: index("forum_members_user_idx").on(t.userId),
  }),
);

/**
 * Per-account saved NPCs (migration 0267). Name + optional stat lines,
 * reusable in any forum subject to that forum's `use_npc` grant. Posting as
 * an NPC snapshots the stats onto the message, so this is the editable
 * "source" the user re-selects from.
 */
export const userNpcs = sqliteTable(
  "user_npcs",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** JSON array of {label,value} stat lines. */
    statsJson: text("stats_json").notNull().default("[]"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    userIdx: index("user_npcs_user_idx").on(t.userId, t.updatedAt),
  }),
);
export type DbUserNpc = typeof userNpcs.$inferSelect;

/**
 * Forum topic prefixes (migration 0266). Owner-curated labels shown as
 * colored chips on topic cards + filterable. A topic's assigned prefix is
 * `messages.prefix_id`. Curated via manage_prefixes.
 */
export const forumPrefixes = sqliteTable(
  "forum_prefixes",
  {
    id: id(),
    forumId: text("forum_id").notNull().references(() => forums.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    color: text("color").notNull().default("#888888"),
    /** Short owner-written explanation of the tag, shown on hover (migration
     *  0269). Null = none (the label stands alone). */
    tooltip: text("tooltip"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** JSON array of room_thread_category ids this tag is offered in
     *  (migration 0268). Empty `[]` = global (every topic). Non-empty =
     *  only topics filed under those categories see it in the picker. */
    categoryIdsJson: text("category_ids_json").notNull().default("[]"),
    /** When set, only a `manage_prefixes` mod/owner may attach or remove this
     *  tag on a topic — the ordinary topic author can't (migration 0273). Lets
     *  a keeper mint authoritative tags (e.g. "Announcement") members can't
     *  self-apply. Default false = any author may set it on their own topic. */
    staffOnly: integer("staff_only", { mode: "boolean" }).notNull().default(false),
    createdAt: ts("created_at"),
  },
  (t) => ({
    forumIdx: index("forum_prefixes_forum_idx").on(t.forumId, t.sortOrder),
  }),
);
export type DbForumPrefix = typeof forumPrefixes.$inferSelect;

/**
 * Forum usergroups (migration 0270). Owner/admin-defined groups granting a set
 * of forum permissions (the unified registry — moderation + member features).
 * Effective perms for a member = union of the default group + every group
 * they're in + any direct mod grant (forum_members.permissions_json).
 */
export const forumUsergroups = sqliteTable(
  "forum_usergroups",
  {
    id: id(),
    forumId: text("forum_id").notNull().references(() => forums.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Optional chip color for the group's label. */
    color: text("color"),
    /** JSON array of ForumPermission keys this group grants. */
    permissionsJson: text("permissions_json").notNull().default("[]"),
    /** Exactly one per forum: the implicit baseline for every participant
     *  (no member rows). Editing it changes what ungrouped members can do. */
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    /** JSON array of ForumAutoRule[] — ALL must match for an auto-join. */
    autoRulesJson: text("auto_rules_json").notNull().default("[]"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    forumIdx: index("forum_usergroups_forum_idx").on(t.forumId, t.sortOrder),
    // NOTE: a partial UNIQUE index `forum_usergroups_one_default` on (forum_id)
    // WHERE is_default = 1 (migration 0271) enforces one default group per
    // forum. Drizzle can't model partial indexes, so it lives only in the SQL.
  }),
);
export type DbForumUsergroup = typeof forumUsergroups.$inferSelect;

/**
 * Explicit (non-default) usergroup memberships. `addedBy` null + `isAuto` true
 * = an automatic membership earned via the group's auto-join rules; a manual
 * add records the acting manager with `isAuto` false.
 */
export const forumUsergroupMembers = sqliteTable(
  "forum_usergroup_members",
  {
    groupId: text("group_id").notNull().references(() => forumUsergroups.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    addedAt: ts("added_at"),
    addedBy: text("added_by"),
    isAuto: integer("is_auto", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.userId] }),
    userIdx: index("forum_usergroup_members_user_idx").on(t.userId),
  }),
);
export type DbForumUsergroupMember = typeof forumUsergroupMembers.$inferSelect;

/**
 * Forum report queue (migration 0265). A member flags a topic/post to the
 * forum's owner + mods holding `handle_reports`. Forum-scoped — never
 * reaches site moderation (that's the separate `reports` table).
 */
export const forumReports = sqliteTable(
  "forum_reports",
  {
    id: id(),
    forumId: text("forum_id").notNull().references(() => forums.id, { onDelete: "cascade" }),
    /** The reported post (topic header or reply). */
    messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    /** Snapshot of the board + top-level topic for deep-linking the queue. */
    boardRoomId: text("board_room_id").references(() => rooms.id, { onDelete: "set null" }),
    topicId: text("topic_id").references(() => messages.id, { onDelete: "set null" }),
    reporterUserId: text("reporter_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    /** open | resolved | dismissed. */
    status: text("status", { enum: ["open", "resolved", "dismissed"] }).notNull().default("open"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    resolutionNote: text("resolution_note"),
    createdAt: ts("created_at"),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    forumIdx: index("forum_reports_forum_idx").on(t.forumId, t.status, t.createdAt),
    // A partial UNIQUE index `forum_reports_one_open_uq` on
    // (forum_id, message_id, reporter_user_id) WHERE status='open' lives in
    // migration 0265 — drizzle's builder doesn't model partial indexes. The
    // POST /forums/:id/reports route pre-checks AND catches the index's
    // violation on the concurrent race, so re-reporting an open post is a
    // graceful no-op either way.
  }),
);
export type DbForumReport = typeof forumReports.$inferSelect;

/**
 * Forum membership applications (postingMode = "application" forums).
 * Reviewed by the forum owner + forum mods in the forum settings page.
 * Lifecycle mirrors world_applications; partial unique index (0225)
 * enforces one PENDING per (forum, applicant).
 */
export const forumMembershipApplications = sqliteTable(
  "forum_membership_applications",
  {
    id: id(),
    forumId: text("forum_id")
      .notNull()
      .references(() => forums.id, { onDelete: "cascade" }),
    applicantUserId: text("applicant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Free-text answer to the owner's prompt; null = no prompt set. */
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
    forumStatusIdx: index("forum_membership_apps_forum_idx").on(t.forumId, t.status),
    applicantIdx: index("forum_membership_apps_applicant_idx").on(t.applicantUserId, t.status),
  }),
);

/**
 * Per-user last-visit marker (migration 0231), one row per (user, forum).
 * Drives the catalog's "new since you last looked" dot: unseen when the
 * forum's lastActivityAt outruns this timestamp (or no row exists).
 * Upserted when a signed-in user selects the forum in the catalog.
 */
export const forumVisits = sqliteTable(
  "forum_visits",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    forumId: text("forum_id")
      .notNull()
      .references(() => forums.id, { onDelete: "cascade" }),
    lastVisitAt: ts("last_visit_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.forumId] }),
  }),
);

/**
 * OpenGraph unfurl cache (migration 0238): one row per fetched URL so a
 * popular link is fetched once per TTL, not once per message. `json` is
 * the LinkPreview payload, or '{}' for negative results (nothing
 * previewable / unsafe target) so failures are cached too.
 */
export const ogUnfurlCache = sqliteTable("og_unfurl_cache", {
  url: text("url").primaryKey(),
  json: text("json").notNull().default("{}"),
  fetchedAt: ts("fetched_at"),
});

/**
 * Per-topic read markers (migration 0236): a topic shows unread while
 * its lastActivityAt outruns lastReadAt (or no row). Upserted when the
 * user opens the topic in the Forums Catalog.
 */
export const forumTopicReads = sqliteTable(
  "forum_topic_reads",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    topicId: text("topic_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    lastReadAt: ts("last_read_at"),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.topicId] }) }),
);

/**
 * Topic watches (migration 0236): explicit subscriptions. Authors
 * auto-watch their topics; repliers auto-watch what they reply to.
 * Watchers get a notification for every new reply.
 */
export const forumTopicWatches = sqliteTable(
  "forum_topic_watches",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    topicId: text("topic_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.topicId] }) }),
);

/**
 * Forum notification inbox (migration 0236). Display fields are
 * SNAPSHOTS (actor name, topic title, snippet) so the inbox survives
 * renames; FKs cascade so deleted posts/topics/forums take their
 * notifications with them. kind: reply (your topic) | quote (you were
 * quoted) | watch (watched topic got a reply).
 */
export const forumNotifications = sqliteTable(
  "forum_notifications",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["reply", "quote", "watch"] }).notNull(),
    forumId: text("forum_id").notNull().references(() => forums.id, { onDelete: "cascade" }),
    boardRoomId: text("board_room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    topicId: text("topic_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    actorName: text("actor_name").notNull(),
    topicTitle: text("topic_title").notNull(),
    snippet: text("snippet").notNull().default(""),
    createdAt: ts("created_at"),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    userIdx: index("forum_notifications_user_idx").on(t.userId, t.createdAt),
    unreadIdx: index("forum_notifications_unread_idx").on(t.userId, t.readAt),
  }),
);

/**
 * Per-forum bans, owner-issued (site staff with manage_any_forum can
 * lift). Scoped STRICTLY to the forum's boards — a forum ban must never
 * affect the rest of the site. `until` null = permanent. Enforced at:
 * board join, topic post/reply, membership-application submit.
 */
export const forumBans = sqliteTable(
  "forum_bans",
  {
    forumId: text("forum_id")
      .notNull()
      .references(() => forums.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    until: integer("until", { mode: "timestamp_ms" }),
    reason: text("reason"),
    issuedById: text("issued_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.forumId, t.userId] }),
    userIdx: index("forum_bans_user_idx").on(t.userId),
  }),
);
