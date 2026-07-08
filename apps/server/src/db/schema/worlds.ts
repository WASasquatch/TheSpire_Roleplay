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
import { characters, users } from "./users.js";

/* ---------- worldbuilding (worlds + pages + room links) ---------- */
/**
 * Top-level world container owned by a user. Visibility tiers:
 *   - private: owner only
 *   - public:  anyone with the URL or who sees it linked from a room
 *   - open:    public + listed in the world catalog + non-owners can link
 *              it to rooms they own/mod
 *
 * Slug is unique per owner; routes use slug for friendly URLs and walk
 * back to id for joins. Cascade deletes the pages and any room links.
 */
export const worlds = sqliteTable(
  "worlds",
  {
    id: id(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    visibility: text("visibility", { enum: ["private", "public", "open"] })
      .notNull()
      .default("private"),
    /**
     * Per-world theme JSON. Applied only when rendering the world's editor /
     * viewer modals - never bleeds into chat or the userlist. Null = use the
     * viewer's chat theme as a fallback.
     */
    theme: text("theme"),
    /**
     * Catalog metadata. Validated as closed enums at the Zod layer (mirrors
     * `rooms.replyMode`); the DB column itself is plain TEXT so a missed
     * Zod entry doesn't crash existing rows. Defaults pick the "most
     * conservative" choice so legacy rows render sanely in the catalog
     * until their owners get around to setting real values.
     */
    genre: text("genre", {
      enum: [
        "fantasy", "modern", "scifi", "horror",
        "western", "steampunk", "mythological", "other",
      ],
    }).notNull().default("other"),
    /** Comma-separated lowercased tag list. Parsed via shared `parseTagList`. */
    tags: text("tags").notNull().default(""),
    /** Comma-separated lowercased content-warning list from the closed CONTENT_WARNINGS set. */
    contentWarnings: text("content_warnings").notNull().default(""),
    /** Admin-curated only for `"featured"`; owners can flip between `active` and `archived`. */
    status: text("status", { enum: ["active", "featured", "archived"] })
      .notNull()
      .default("active"),
    /** Public URL to the catalog cover image (uploaded via /worlds/:id/cover). Null = render text-only fallback. */
    coverImageUrl: text("cover_image_url"),
    /** Soft cadence signal for would-be members. Null = unspecified. */
    pacing: text("pacing", {
      enum: ["freeform", "drop-in", "casual", "slice-of-life", "structured", "long-form"],
    }),
    /**
     * Vibe-stat axes, author-tuned 0..100 integers that describe how
     * the world FEELS along eight orthogonal dimensions. Catalog
     * filters key on these, and world cards render them as horizontal
     * bars. Null = "author hasn't tuned this axis"; the renderer
     * shows a muted "-" instead of a 0% bar so the visual difference
     * between "deliberately none of this" and "not yet set" is clear.
     *
     * The axis list is INTENTIONALLY FIXED so cross-world comparison
     * (the whole point of catalog filtering) stays meaningful. Adding
     * or removing an axis is a schema change.
     */
    statCombat: integer("stat_combat"),
    statMagic: integer("stat_magic"),
    statTechnology: integer("stat_technology"),
    statRomance: integer("stat_romance"),
    statPolitics: integer("stat_politics"),
    statMystery: integer("stat_mystery"),
    statHorror: integer("stat_horror"),
    statExploration: integer("stat_exploration"),
    /**
     * Membership join gate, orthogonal to `visibility`:
     *   - "open": anyone who can see the world can join with one click
     *   - "application": joining requires owner-approved application
     *     (see `world_applications` + `application_questions_json`)
     *   - "invite-only": only the owner can add members (no Join /
     *     Apply button surfaces in the catalog)
     * Defaults to "open" so legacy rows keep their pre-feature
     * behavior, the visibility="open" check that gated joining
     * before this column existed still applies via the route layer.
     */
    joinMode: text("join_mode", { enum: ["open", "application", "invite-only"] })
      .notNull()
      .default("open"),
    /**
     * JSON array of question prompt strings (max 5, each 1..280
     * chars). The applicant's `answers_json` lines up by position.
     * Empty array is legal, an open-question-set application just
     * captures the applicant's intent to join with no Q&A. The
     * column itself defaults to "[]" so the JSON-parse path never
     * sees null.
     */
    applicationQuestionsJson: text("application_questions_json").notNull().default("[]"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    ownerSlugUq: uniqueIndex("worlds_owner_slug_uq").on(t.ownerUserId, sql`lower(${t.slug})`),
    visibilityIdx: index("worlds_visibility_idx").on(t.visibility, t.updatedAt),
    genreIdx: index("worlds_genre_idx").on(t.genre),
    statusIdx: index("worlds_status_idx").on(t.status),
  }),
);

/**
 * World membership applications, created when a user clicks "Apply"
 * on a world whose `joinMode = "application"`. Row lifecycle:
 *
 *   pending → approved   (owner clicks Approve; user is auto-added
 *                         to world_members as part of the same
 *                         transaction)
 *   pending → rejected   (owner clicks Reject, optional review_note)
 *   pending → withdrawn  (applicant cancels their own pending app)
 *
 * Terminal-state rows (approved / rejected / withdrawn) stay as an
 * audit trail; a partial unique index in migration 0186 enforces "at
 * most one PENDING application per (world, applicant)" without
 * blocking a fresh re-apply after a reject or withdraw.
 *
 * Answers ride as a JSON array of strings keyed by question position
 * at the time of submission. Later edits to the world's questions
 * don't retroactively shorten or lengthen existing answers, what
 * the applicant wrote stays what the owner sees.
 */
export const worldApplications = sqliteTable(
  "world_applications",
  {
    id: id(),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    applicantUserId: text("applicant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Identity the application was filed under: null = master OOC,
     * non-null = a specific character of `applicantUserId`. The
     * pending-uniqueness index keys on (world, applicant_user_id,
     * COALESCE(character_id, '')) so the same master can apply as
     * OOC AND as each character independently. Added in 0187.
     */
    characterId: text("character_id").references(() => characters.id, { onDelete: "cascade" }),
    answersJson: text("answers_json").notNull().default("[]"),
    status: text("status", { enum: ["pending", "approved", "rejected", "withdrawn"] })
      .notNull()
      .default("pending"),
    submittedAt: ts("submitted_at"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewNote: text("review_note"),
  },
  (t) => ({
    worldStatusIdx: index("world_applications_world_status_idx").on(t.worldId, t.status),
    applicantIdx: index("world_applications_applicant_idx").on(t.applicantUserId, t.status),
    // The "at most one pending per (world, applicant, identity)"
    // partial unique index lives in the migration only, drizzle's
    // typed builder doesn't model partial-expression indexes. The
    // runtime invariant is enforced both by that index AND by the
    // route layer (which queries for an existing pending row before
    // insert and converts UNIQUE-constraint races into 409s).
  }),
);

/**
 * Tree-structured pages inside a world. parent_page_id NULL = top-level.
 * Cascade deletes children when a parent is removed (matches the "delete
 * cascades with confirmation" decision). Depth cap of 10 enforced in code.
 */
export const worldPages = sqliteTable(
  "world_pages",
  {
    id: id(),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    parentPageId: text("parent_page_id"),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    bodyHtml: text("body_html").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Optional arc grouping (soft ref, route-validated). Migration 0213. */
    arcId: text("arc_id"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    treeIdx: index("world_pages_tree_idx").on(t.worldId, t.parentPageId, t.sortOrder),
    slugIdx: index("world_pages_slug_idx").on(t.worldId, sql`lower(${t.slug})`),
    arcIdx: index("world_pages_arc_idx").on(t.worldId, t.arcId),
  }),
);

/**
 * Room → world link. One-world-per-room (PK on roomId). Surfaces a banner
 * above the chat topic so participants can open the linked wiki.
 */
export const roomWorldLinks = sqliteTable(
  "room_world_links",
  {
    roomId: text("room_id")
      .primaryKey()
      .references(() => rooms.id, { onDelete: "cascade" }),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    linkedByUserId: text("linked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    linkedAt: ts("linked_at"),
  },
  (t) => ({
    worldIdx: index("room_world_links_world_idx").on(t.worldId),
  }),
);

/**
 * Identity → world membership. A user (master account) can hold
 * memberships under multiple identities, their OOC face AND each
 * character, and each identity's membership is independent. Avery
 * can be in Halcyon City without dragging the master's OOC or
 * Sigrid along.
 *
 * Identity key: `character_id` distinguishes per-character rows
 * (non-null) from the OOC row (null). The unique index
 * `world_members_identity_uq` (migration 0187) uses
 * COALESCE(character_id, '') so the NULL slot still participates in
 * the "at most one per (world, user, identity)" enforcement.
 *
 * Joining is gated by world.visibility + world.joinMode at the
 * route layer; the table itself doesn't enforce those, so admin
 * tooling can still seed memberships for private/invite-only
 * worlds if needed.
 *
 * Note: the per-master "isPrimary" concept was retired in migration
 * 0187, with per-identity membership it became meaningless, and
 * the userlist's primary-world grouping was the surface that
 * actually leaked "this character's master is in X" by way of
 * grouping a character row under the master's primary world.
 */
export const worldMembers = sqliteTable(
  "world_members",
  {
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Null = the master's OOC face joined.
     * Non-null = a specific character joined; the FK cascade-deletes
     * the membership if the character is hard-deleted.
     */
    characterId: text("character_id").references(() => characters.id, { onDelete: "cascade" }),
    joinedAt: ts("joined_at"),
    // Identity-uniqueness lives in the migration via an expression
    // index on COALESCE(character_id, ''). Drizzle's typed builder
    // doesn't model expression-unique indexes, so the migration is
    // the source of truth.
  },
  (t) => ({
    userIdx: index("world_members_user_idx").on(t.userId),
    worldIdx: index("world_members_world_idx").on(t.worldId),
    characterIdx: index("world_members_character_idx").on(t.characterId),
  }),
);

/**
 * Per-world editing collaborators. The world's `ownerUserId` is always
 * an implicit editor; this table grants the same edit rights to
 * additional users the owner invites. Collaborators can edit world
 * metadata + pages but cannot manage the collaborator list itself,
 * transfer ownership, or delete the world. Created in migration 0174.
 *
 * Mirrors the scriptorium collaborator pattern (0144): minimal row
 * shape (no role enum yet) with the actual permission decisions
 * computed at request time in the worlds route.
 */
export const worldCollaborators = sqliteTable(
  "world_collaborators",
  {
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addedAt: ts("added_at"),
    addedByUserId: text("added_by_user_id")
      .references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.worldId, t.userId] }),
    userIdx: index("world_collaborators_user_idx").on(t.userId),
  }),
);

/**
 * Typed knowledge-base entries inside a world (Locations, NPCs, Items/Codex,
 * Factions, and owner-defined custom kinds). Mirrors `storyEntities` (the
 * Scriptorium codex). The "Lore" type is NOT a row here — it stays the
 * `worldPages` tree. `arcId` is a soft reference (no DB FK; the arcs table
 * lands in a later migration and route handlers validate same-world). Migration
 * 0211.
 */
export const worldEntities = sqliteTable(
  "world_entities",
  {
    id: id(),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    /** Built-in key (location|npc|item|faction) or a custom registry key. */
    kind: text("kind").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    bodyHtml: text("body_html").notNull().default(""),
    /** Free-form kv map (e.g. NPC stats). */
    statsJson: text("stats_json").notNull().default("{}"),
    /** Comma-separated tag list (parseTagList). Powers the By-Tag dashboard. */
    tags: text("tags").notNull().default(""),
    imageUrl: text("image_url"),
    isPublic: integer("is_public").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Optional arc grouping (soft ref, route-validated). Added in 0211 so the
     *  arcs migration doesn't need to ALTER this table. */
    arcId: text("arc_id"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    worldKindSlugUq: uniqueIndex("world_entities_world_kind_slug_uq").on(
      t.worldId,
      t.kind,
      sql`lower(${t.slug})`,
    ),
    orderIdx: index("world_entities_order_idx").on(t.worldId, t.kind, t.sortOrder),
    arcIdx: index("world_entities_arc_idx").on(t.worldId, t.arcId),
  }),
);
export type DbWorldEntity = typeof worldEntities.$inferSelect;

/**
 * Per-world registry of OWNER-DEFINED custom entry kinds. Built-in kinds
 * (location/npc/item/faction + synthetic lore) are constants in shared and are
 * NOT stored here. `worldEntities.kind` holds the key for both. Migration 0211.
 */
export const worldEntityKinds = sqliteTable(
  "world_entity_kinds",
  {
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    icon: text("icon"),
    color: text("color"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at"),
  },
  (t) => ({
    worldKeyUq: uniqueIndex("world_entity_kinds_world_key_uq").on(t.worldId, sql`lower(${t.key})`),
  }),
);
export type DbWorldEntityKind = typeof worldEntityKinds.$inferSelect;

/**
 * Arcs: storyline groupings that pages / entities / sessions can belong to,
 * with a status. Migration 0212.
 */
export const worldArcs = sqliteTable(
  "world_arcs",
  {
    id: id(),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    /** planned | active | concluded | archived (Zod-enforced). */
    status: text("status").notNull().default("active"),
    color: text("color"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    worldSlugUq: uniqueIndex("world_arcs_world_slug_uq").on(t.worldId, sql`lower(${t.slug})`),
    orderIdx: index("world_arcs_order_idx").on(t.worldId, t.sortOrder),
  }),
);
export type DbWorldArc = typeof worldArcs.$inferSelect;

/**
 * Sessions: chronological session-log entries. `arcId` is a soft reference
 * (no DB FK; routes validate same-world). Migration 0212.
 */
export const worldSessions = sqliteTable(
  "world_sessions",
  {
    id: id(),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    arcId: text("arc_id"),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    bodyHtml: text("body_html").notNull().default(""),
    /** Epoch ms of the in-fiction/real session date; drives chronological sort. */
    sessionDate: integer("session_date", { mode: "timestamp_ms" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    worldSlugUq: uniqueIndex("world_sessions_world_slug_uq").on(t.worldId, sql`lower(${t.slug})`),
    chronoIdx: index("world_sessions_chrono_idx").on(t.worldId, t.sessionDate, t.sortOrder),
    arcIdx: index("world_sessions_arc_idx").on(t.worldId, t.arcId),
  }),
);
export type DbWorldSession = typeof worldSessions.$inferSelect;
export type DbWorld = typeof worlds.$inferSelect;
export type DbWorldPage = typeof worldPages.$inferSelect;
export type DbRoomWorldLink = typeof roomWorldLinks.$inferSelect;
export type DbWorldMember = typeof worldMembers.$inferSelect;
