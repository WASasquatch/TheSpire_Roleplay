import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { id, ts } from "./_helpers.js";
import { messages, rooms } from "./chat.js";
import { directMessages } from "./messaging.js";
import { servers } from "./servers.js";
import { characters, friends, users } from "./users.js";

/* ---------- bans ---------- */
export const bans = sqliteTable(
  "bans",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    until: integer("until", { mode: "timestamp_ms" }),
    reason: text("reason"),
    issuedById: text("issued_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roomId, t.userId] }),
  }),
);

/* ---------- mutes (per-room timed silence) ----------
 * A muted user remains *in* the room (they can read) but cannot send
 * chat:input for that room until `until`. Set by /mute, cleared by
 * /unmute or by expiry. Distinct from `bans`, which prevents joining.
 */
export const mutes = sqliteTable(
  "mutes",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    until: integer("until", { mode: "timestamp_ms" }).notNull(),
    reason: text("reason"),
    issuedById: text("issued_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roomId, t.userId] }),
  }),
);

/* ---------- account_mutes (server-wide / site-wide timed silence) ----------
 * Wider-than-room mutes whose REACH follows the ISSUER's authority: site staff
 * (global mod/admin) mute site-wide, server staff mute their whole server. A
 * room owner/mod's /mute stays in the per-room `mutes` table above. Every mute
 * is account-level (silences all of the target's tabs/identities). Enforced in
 * dispatch.ts alongside the room mute; cleared by /unmute or expiry. The
 * partial UNIQUE indexes (one site mute per user; one server mute per
 * user+server) live in migration 0325, not here — drizzle only needs the shape
 * for queries.
 */
export const accountMutes = sqliteTable(
  "account_mutes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // "server" | "site". Server mutes carry a serverId; site mutes leave it null.
    scope: text("scope").notNull(),
    serverId: text("server_id").references(() => servers.id, { onDelete: "cascade" }),
    until: integer("until", { mode: "timestamp_ms" }).notNull(),
    reason: text("reason"),
    issuedById: text("issued_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    byUser: index("account_mutes_user_idx").on(t.userId),
  }),
);

/* ---------- ignores (per-user mute list) ---------- */
export const ignores = sqliteTable(
  "ignores",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ignoredUserId: text("ignored_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.ignoredUserId] }),
  }),
);

/* ---------- blocks (global, MUTUAL invisibility) ----------
 * Stronger than `ignores`. `/ignore` is one-way and message-only: the
 * ignorer stops seeing the ignored user's chat lines, but the ignored user
 * still sees them everywhere. A block is MUTUAL and GLOBAL: once a row exists
 * between two accounts (in either direction), the two users and ALL their
 * characters become invisible to each other across the whole app, chat,
 * userlist, whispers, DMs, friends, profiles, search/@mentions.
 *
 * One directed row is written per initiation (`blocker_user_id` blocked
 * `blocked_user_id`); the effect is symmetric because every read consults
 * BOTH directions (see auth/blocks.ts). Only the blocker can lift their own
 * row (Profile → Privacy); the blocked user has no signal and can't undo it.
 * Keyed on the master userId like `ignores`, so it spans every character on
 * both sides. Blocking performs NO destructive changes, friendships / DM
 * threads are merely filtered out while blocked and reappear on unblock.
 */
export const blocks = sqliteTable(
  "blocks",
  {
    blockerUserId: text("blocker_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedUserId: text("blocked_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.blockerUserId, t.blockedUserId] }),
    // Reverse-direction lookups ("who has blocked me / am I blocked by")
    // hit blocked_user_id, which the PK's leading column can't serve.
    blockedIdx: index("blocks_blocked_idx").on(t.blockedUserId),
  }),
);

/* ---------- audit log (Phase 3) ---------- */
/**
 * Append-only log of admin/mod actions. Stores enough metadata to reconstruct
 * "who did what to whom, when, and why" without ever capturing private chat
 * content. Free-text fields (`reason`, `metadata_json`) are admin-authored
 * descriptions, never user-authored bodies.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: id(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** e.g. "kick", "mute", "ban", "promote_mod", "settings_update", "report_resolve". */
    action: text("action").notNull(),
    targetUserId: text("target_user_id").references(() => users.id, { onDelete: "set null" }),
    targetRoomId: text("target_room_id").references(() => rooms.id, { onDelete: "set null" }),
    targetMessageId: text("target_message_id").references(() => messages.id, { onDelete: "set null" }),
    /** Admin-authored note (e.g. "spamming links"). Optional. */
    reason: text("reason"),
    /** JSON blob for action-specific extras (duration ms, prior/next role, etc.). */
    metadataJson: text("metadata_json"),
    createdAt: ts("created_at"),
    /**
     * Scope discriminator (migration 0278a). NULL = app-global / platform-owned;
     * a server_id scopes the entry to that server's Mod Log. ON DELETE SET NULL
     * so deleting a server un-scopes (never destroys) audit history.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
  },
  (t) => ({
    createdIdx: index("audit_log_created_idx").on(t.createdAt),
    actorIdx: index("audit_log_actor_idx").on(t.actorUserId, t.createdAt),
    targetIdx: index("audit_log_target_idx").on(t.targetUserId, t.createdAt),
    actionIdx: index("audit_log_action_idx").on(t.action, t.createdAt),
    serverIdx: index("audit_log_server_idx").on(t.serverId, t.createdAt),
  }),
);

/* ---------- reports (Phase 3) ---------- */
/**
 * User-filed reports against PUBLIC chat messages. Whispers and private-room
 * messages are intentionally NOT reportable (admins can't see them anyway,
 * by design). Status flow: open → reviewed | dismissed.
 */
export const reports = sqliteTable(
  "reports",
  {
    id: id(),
    reporterUserId: text("reporter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Room-message id when this is a room-content report; null for
     * DM reports (which use `directMessageId` below). Exactly one of
     * (messageId, directMessageId) is set on a given row, enforced
     * at the route layer because SQLite has no native XOR check.
     */
    messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "cascade" }),
    /** Free-text reason from the reporter. Optional; many UIs leave it blank. */
    reason: text("reason"),
    status: text("status", { enum: ["open", "reviewed", "dismissed"] })
      .notNull()
      .default("open"),
    resolvedById: text("resolved_by_id").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    /** Admin's note added on resolve/dismiss; surfaced in the audit entry. */
    resolutionNote: text("resolution_note"),
    createdAt: ts("created_at"),
    /**
     * DM report fields (Phase 5). `directMessageId` references the
     * reported DM; `bodySnapshot` captures the body at report-time
     * so the admin queue can show it WITHOUT the admin route ever
     * querying `direct_messages` directly (preserves the "admin
     * queries cannot reach DM tables" invariant). `senderUserId` is
     * denormalized from `direct_messages.senderUserId` for the same
     * reason, the admin row stands on its own.
     */
    directMessageId: text("direct_message_id").references(() => directMessages.id, { onDelete: "set null" }),
    bodySnapshot: text("body_snapshot"),
    senderUserId: text("sender_user_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * Scope discriminator (migration 0278c) — the SINGLE home for per-server
     * message reports (there is NO server_reports table). Message/room reports
     * route to the room's server; DM/profile reports (no room) stay NULL =
     * platform/site staff. ON DELETE SET NULL so deleting a server un-scopes
     * the reports rather than destroying them.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
  },
  (t) => ({
    statusIdx: index("reports_status_idx").on(t.status, t.createdAt),
    reporterMsgUq: uniqueIndex("reports_reporter_msg_uq").on(t.reporterUserId, t.messageId),
    serverIdx: index("reports_server_idx").on(t.serverId, t.status, t.createdAt),
  }),
);

/* ---------- automod rules (migration 0319) ----------
 * Configurable auto-moderation rules the chat + forum pipelines consult before
 * a message lands. A rule matches on a `kind` (keyword / regex / link / invite
 * / mention_cap) and applies an `action` (warn / delete / mute). `serverId`
 * null = site-wide, else scoped to one server (cascade). `scope` picks which
 * surfaces it polices (chat / forum / both). Gated behind the
 * site_settings.automod_enabled master switch; the `bypass_automod` permission
 * (seeded trusted + mod + admin) exempts staff. */
export const automodRules = sqliteTable(
  "automod_rules",
  {
    id: id(),
    /** null = site-wide; set = scoped to this community server. */
    serverId: text("server_id").references(() => servers.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** keyword | regex | link | invite | mention_cap. */
    kind: text("kind", { enum: ["keyword", "regex", "link", "invite", "mention_cap"] }).notNull(),
    /** Matcher input: word/phrase, regex source, or the numeric cap for mention_cap. */
    pattern: text("pattern").notNull().default(""),
    /** warn | delete | mute. */
    action: text("action", { enum: ["warn", "delete", "mute"] }).notNull().default("warn"),
    /** Mute duration (ms) when action = 'mute'; null = engine default. */
    muteMs: integer("mute_ms"),
    /** chat | forum | both. */
    scope: text("scope", { enum: ["chat", "forum", "both"] }).notNull().default("both"),
    caseInsensitive: integer("case_insensitive", { mode: "boolean" }).notNull().default(true),
    wholeWord: integer("whole_word", { mode: "boolean" }).notNull().default(false),
    /** Admin note explaining the rule. */
    note: text("note"),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    scopeIdx: index("automod_rules_scope_idx").on(t.serverId, t.enabled),
  }),
);
export type DbAutomodRule = typeof automodRules.$inferSelect;
export type DbAuditEntry = typeof auditLog.$inferSelect;
export type DbReport = typeof reports.$inferSelect;

/* ---------- moderation case log (migration 0254) ----------
 *
 * Mod-authored record of a complaint/dispute and how it was handled —
 * distinct from the user-filed `reports` table (which is reader-initiated).
 * Reporter and subject are freehand text by default, but if the mod typed an
 * `@id:`/`@cid:` identity token we resolve it and ALSO store the linked
 * userId/characterId + a snapshot label, so the log stays queryable ("every
 * case about user X") without losing the freehand affordance. FKs use
 * `set null` so the case survives a deleted account. */
export const modCases = sqliteTable(
  "mod_cases",
  {
    id: id(),
    /** Short category/label for the complaint, freehand (e.g. "harassment"). */
    nature: text("nature").notNull(),
    /** The freehand narrative the mod typed. */
    complaintBody: text("complaint_body").notNull(),
    /** Freehand outcome / action taken; null while the case is open. */
    resolution: text("resolution"),
    status: text("status", { enum: ["open", "in_progress", "resolved"] }).notNull().default("open"),
    /** "case" = an infraction/dispute with a workflow; "note" = a standing
     *  informational note about a user, no resolution needed (migration 0272). */
    kind: text("kind", { enum: ["case", "note"] }).notNull().default("case"),
    /** "Who complained" — freehand text and/or a resolved identity link. */
    reporterText: text("reporter_text"),
    reporterUserId: text("reporter_user_id").references(() => users.id, { onDelete: "set null" }),
    reporterCharacterId: text("reporter_character_id"),
    reporterLabel: text("reporter_label"),
    /** "About whom/what" — same shape as the reporter columns. */
    subjectText: text("subject_text"),
    subjectUserId: text("subject_user_id").references(() => users.id, { onDelete: "set null" }),
    subjectCharacterId: text("subject_character_id"),
    subjectLabel: text("subject_label"),
    /** Optional link to a user-filed report this case stems from. */
    relatedReportId: text("related_report_id").references(() => reports.id, { onDelete: "set null" }),
    /** The mod who recorded the case. */
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    /**
     * Scope discriminator (migration 0278b). NULL = app-global / platform-owned;
     * a server_id scopes the case to that server. mod_case_updates /
     * mod_case_evidence inherit scope through case_id. ON DELETE SET NULL so
     * deleting a server un-scopes (never destroys) case history.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
  },
  (t) => ({
    subjectIdx: index("mod_cases_subject_idx").on(t.subjectUserId),
    reporterIdx: index("mod_cases_reporter_idx").on(t.reporterUserId),
    statusIdx: index("mod_cases_status_idx").on(t.status, t.createdAt),
    serverIdx: index("mod_cases_server_idx").on(t.serverId, t.status, t.createdAt),
  }),
);
export type DbModCase = typeof modCases.$inferSelect;

/* Append-only update timeline on a mod case (migration 0272) — staff add
 * progress notes + status changes without rewriting the original resolution. */
export const modCaseUpdates = sqliteTable(
  "mod_case_updates",
  {
    id: id(),
    caseId: text("case_id").notNull().references(() => modCases.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    /** The status this update moved the case to, when it changed one. */
    statusChange: text("status_change", { enum: ["open", "in_progress", "resolved"] }),
    authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    caseIdx: index("mod_case_updates_case_idx").on(t.caseId, t.createdAt),
  }),
);
export type DbModCaseUpdate = typeof modCaseUpdates.$inferSelect;

/* Snapshotted chat messages backed up as evidence on a case (migration 0272).
 * The original message id is kept for reference; body/author/room are
 * snapshotted so the record survives the janitor hard-deleting the source. */
export const modCaseEvidence = sqliteTable(
  "mod_case_evidence",
  {
    id: id(),
    caseId: text("case_id").notNull().references(() => modCases.id, { onDelete: "cascade" }),
    /** The source message id (for reference; the message itself may be gone). */
    messageId: text("message_id"),
    authorUserId: text("author_user_id"),
    authorLabel: text("author_label"),
    body: text("body"),
    kind: text("kind"),
    roomId: text("room_id"),
    roomName: text("room_name"),
    originalCreatedAt: integer("original_created_at"),
    snapshottedAt: ts("snapshotted_at"),
  },
  (t) => ({
    caseMsgIdx: uniqueIndex("mod_case_evidence_case_msg_idx").on(t.caseId, t.messageId),
    caseIdx: index("mod_case_evidence_case_idx").on(t.caseId, t.snapshottedAt),
  }),
);
export type DbModCaseEvidence = typeof modCaseEvidence.$inferSelect;
