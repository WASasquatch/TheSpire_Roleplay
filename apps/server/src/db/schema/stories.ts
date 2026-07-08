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
import { characters, users } from "./users.js";
import { worlds } from "./worlds.js";

/* =========================================================
 *  Scriptorium, long-form fiction (migration 0139)
 *
 *  Stories are authored by identities (master account OR character)
 *  and inherit the same privacy posture as the rest of the app:
 *  visibility tiers gate who sees a story; the rating tier
 *  additionally gates anonymous splash viewers.
 * ========================================================= */

/**
 * Top-level story row. Catalog cards on the splash + in-app list read
 * directly from here; the editor + reader hydrate chapters from
 * `story_chapters` on demand. Counters (totalWords, totalChapters,
 * readerCount, etc.) are maintained on publish / read events.
 */
export const stories = sqliteTable(
  "stories",
  {
    id: id(),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Null = published under the master identity. */
    authorCharacterId: text("author_character_id").references(() => characters.id, { onDelete: "set null" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    synopsisHtml: text("synopsis_html").notNull().default(""),
    coverImageUrl: text("cover_image_url"),
    themeJson: text("theme_json"),
    genre: text("genre").notNull().default("other"),
    rating: text("rating").notNull().default("PG"),
    status: text("status").notNull().default("draft"),
    visibility: text("visibility").notNull().default("private"),
    tags: text("tags").notNull().default(""),
    contentWarnings: text("content_warnings").notNull().default(""),
    linkedWorldId: text("linked_world_id").references(() => worlds.id, { onDelete: "set null" }),
    allowReviews: integer("allow_reviews").notNull().default(0),
    allowApplause: integer("allow_applause").notNull().default(1),
    /**
     * Author-set "Buy a Copy" price (migration 0216). NULL = inherit the
     * site default (`earningConfig.scriptorium.copyPrice`). When set, it's
     * bounded to STORY_COPY_PRICE_MIN..MAX (packages/shared) at the route
     * layer. Resolved everywhere as `copyPrice ?? configDefault`.
     */
    copyPrice: integer("copy_price"),
    /**
     * "Buy to Read" paywall (migration 0217). When 1, non-purchasers see only
     * a short faded sample of the first chapter and must buy a copy to read
     * on. Enforced server-side in the chapter-body route; bypassable with the
     * `bypass_scriptorium_paywall` permission.
     */
    buyToRead: integer("buy_to_read").notNull().default(0),
    totalWords: integer("total_words").notNull().default(0),
    totalChapters: integer("total_chapters").notNull().default(0),
    readerCount: integer("reader_count").notNull().default(0),
    applauseCount: integer("applause_count").notNull().default(0),
    reviewCount: integer("review_count").notNull().default(0),
    avgRatingX100: integer("avg_rating_x100"),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    authorSlugUq: uniqueIndex("stories_author_slug_uq").on(t.authorUserId, sql`lower(${t.slug})`),
    catalogIdx: index("stories_catalog_idx").on(t.visibility, t.rating, t.status, t.updatedAt),
    linkedWorldIdx: index("stories_linked_world_idx").on(t.linkedWorldId),
    authorIdx: index("stories_author_idx").on(t.authorUserId, t.updatedAt),
  }),
);

/**
 * Ordered chapters inside a story. Chapter 1 is sort_order = 0. A
 * one-shot is a story with a single chapter.
 */
export const storyChapters = sqliteTable(
  "story_chapters",
  {
    id: id(),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    title: text("title").notNull().default(""),
    bodyHtml: text("body_html").notNull().default(""),
    authorNotesHtml: text("author_notes_html").notNull().default(""),
    contentWarnings: text("content_warnings").notNull().default(""),
    wordCount: integer("word_count").notNull().default(0),
    status: text("status").notNull().default("draft"),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    /** When the one-time writing reward was paid for this chapter (stamped on
     *  first publish). Non-null = already rewarded; edits/re-publish never
     *  re-pay. Migration 0209. */
    rewardPaidAt: integer("reward_paid_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    orderIdx: index("story_chapters_order_idx").on(t.storyId, t.sortOrder),
    publishedIdx: index("story_chapters_published_idx").on(t.storyId, t.status, t.publishedAt),
  }),
);

/**
 * Per-authoring-identity weekly publishing streak for Scriptorium writing
 * rewards. Mirrors the eidolon care-streak shape but keyed on ISO week
 * (YYYY-Www) instead of UTC day: publishing a chapter in consecutive weeks
 * raises `streak_count`, which multiplies the chapter payout; a gap of two or
 * more weeks resets it. Migration 0209.
 */
export const scriptoriumWriteStreaks = sqliteTable(
  "scriptorium_write_streaks",
  {
    /** Per-server economy partition (migration 0286). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    streakCount: integer("streak_count").notNull().default(0),
    /** ISO week-key (YYYY-Www) of the last rewarded publish; null until first. */
    lastPublishWeekKey: text("last_publish_week_key"),
    bestStreak: integer("best_streak").notNull().default(0),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.ownerScope, t.ownerId] }),
  }),
);
export type DbScriptoriumWriteStreak = typeof scriptoriumWriteStreaks.$inferSelect;

/**
 * A purchased copy of a published story. "Buy a Copy" costs the buyer currency
 * (a royalty cut goes to the author); an owned copy can optionally be showcased
 * on the buyer's profile in a Library column. One copy per identity per story.
 * Migration 0210.
 */
export const storyCopies = sqliteTable(
  "story_copies",
  {
    id: id(),
    /** Per-server economy partition (migration 0284). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    storyId: text("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
    /** Buyer identity: "user" (master/OOC) or "character". */
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    /** Buyer's master account, for cascade cleanup + the self-buy guard. */
    ownerUserId: text("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    pricePaid: integer("price_paid").notNull().default(0),
    /** Profile showcase slot; null = owned but not shown, non-null = pinned. */
    showcaseSlot: integer("showcase_slot"),
    purchasedAt: ts("purchased_at"),
  },
  (t) => ({
    ownerStoryUq: uniqueIndex("story_copies_owner_story_uq").on(t.serverId, t.ownerScope, t.ownerId, t.storyId),
    showcaseIdx: index("story_copies_showcase_idx").on(t.serverId, t.ownerScope, t.ownerId, t.showcaseSlot),
    storyIdx: index("story_copies_story_idx").on(t.storyId),
  }),
);
export type DbStoryCopy = typeof storyCopies.$inferSelect;

/**
 * Immutable per-chapter version snapshots. Autosave frames are pruned
 * past a per-chapter cap (default 20, enforced in the route layer);
 * publish frames are kept indefinitely.
 */
export const storyChapterVersions = sqliteTable(
  "story_chapter_versions",
  {
    id: id(),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => storyChapters.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    bodyHtml: text("body_html").notNull().default(""),
    authorNotesHtml: text("author_notes_html").notNull().default(""),
    reason: text("reason").notNull().default("autosave"),
    savedByUserId: text("saved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    savedAt: ts("saved_at"),
  },
  (t) => ({
    chapterVersionUq: uniqueIndex("story_chapter_versions_chapter_version_uq").on(t.chapterId, t.version),
    chapterIdx: index("story_chapter_versions_chapter_idx").on(t.chapterId, t.savedAt),
  }),
);

/**
 * Per-reader "continue reading" pointer. Author cannot see WHICH
 * readers have a row, only the aggregate readerCount. Admins cannot
 * pull individual positions either.
 */
export const storyReadingPositions = sqliteTable(
  "story_reading_positions",
  {
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastChapterId: text("last_chapter_id").references(() => storyChapters.id, { onDelete: "set null" }),
    lastAnchorId: text("last_anchor_id"),
    /** Integer 0..1000 (percent * 10) so we can sort without floats. */
    percentThrough: integer("percent_through").notNull().default(0),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.storyId, t.userId] }),
    userIdx: index("story_reading_positions_user_idx").on(t.userId, t.updatedAt),
  }),
);

/* ---------- Scriptorium reviews + replies + applause (migration 0140) ---------- */

/**
 * Top-level review. One per (story, reviewer identity). Mirror of the
 * "identity = master + character" tuple: a player and one of their
 * characters each get their own review slot.
 *
 * `pinnedByAuthor` floats the review to the top of the story's review
 * list; `hiddenByAuthor` removes it from public view (the reviewer
 * still sees it on their own surface, same shape as `/ignore`).
 * `editGraceExpiresAt` is a 60-second window mirroring chat + DM grace.
 */
export const storyReviews = sqliteTable(
  "story_reviews",
  {
    id: id(),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    reviewerUserId: text("reviewer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reviewerCharacterId: text("reviewer_character_id").references(() => characters.id, { onDelete: "set null" }),
    rating: integer("rating").notNull(),
    bodyHtml: text("body_html").notNull().default(""),
    pinnedByAuthor: integer("pinned_by_author").notNull().default(0),
    hiddenByAuthor: integer("hidden_by_author").notNull().default(0),
    editGraceExpiresAt: integer("edit_grace_expires_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    // Identity-tuple uniqueness, partial index expression in the
    // migration (drizzle's typed builder doesn't expose the COALESCE
    // form directly).
    storyIdx: index("story_reviews_story_idx").on(t.storyId, t.createdAt),
    reviewerIdx: index("story_reviews_reviewer_idx").on(t.reviewerUserId, t.createdAt),
  }),
);

/** Threaded one level under a review. Plain sanitized HTML. */
export const storyReviewReplies = sqliteTable(
  "story_review_replies",
  {
    id: id(),
    reviewId: text("review_id")
      .notNull()
      .references(() => storyReviews.id, { onDelete: "cascade" }),
    replyerUserId: text("replyer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    replyerCharacterId: text("replyer_character_id").references(() => characters.id, { onDelete: "set null" }),
    bodyHtml: text("body_html").notNull().default(""),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    reviewIdx: index("story_review_replies_review_idx").on(t.reviewId, t.createdAt),
  }),
);

/**
 * Applause, idempotent boolean per (reader, target). Target is either
 * the whole story (chapterId null) or a specific chapter. Author
 * cannot see WHO applauded; only the rollup count on the story row.
 */
export const storyApplause = sqliteTable(
  "story_applause",
  {
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id").references(() => storyChapters.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    applaudedAt: ts("applauded_at"),
  },
  (t) => ({
    // Uniqueness is enforced by a COALESCE-expression unique index in
    // the migration, SQLite forbids expressions in PK/UNIQUE
    // constraints, so this is a UNIQUE INDEX rather than a composite
    // PK. Rowid is the implicit primary key.
    uq: uniqueIndex("story_applause_uq").on(
      t.storyId,
      sql`coalesce(${t.chapterId}, '')`,
      t.userId,
    ),
    storyIdx: index("story_applause_story_idx").on(t.storyId),
  }),
);

/* ---------- Scriptorium subscriptions (Phase 7) ---------- */

/**
 * Per-reader story subscription. On chapter publish, every row here is
 * notified (in-app via socket; optional web-push when pushEnabled).
 * Author cannot see WHO is subscribed, only the rollup count.
 */
export const storySubscriptions = sqliteTable(
  "story_subscriptions",
  {
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pushEnabled: integer("push_enabled").notNull().default(0),
    subscribedAt: ts("subscribed_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.storyId, t.userId] }),
    userIdx: index("story_subscriptions_user_idx").on(t.userId, t.subscribedAt),
    storyIdx: index("story_subscriptions_story_idx").on(t.storyId),
  }),
);

/* ---------- Scriptorium chapter locks (Phase 5, soft-lock) ---------- */

/**
 * Advisory editing lock on a single chapter. Acquired when a
 * collaborator opens the chapter editor; refreshed by client
 * heartbeat. Lease is 5 minutes since `lastRefreshAt`; the server
 * treats expired rows as available (lazy GC on the next acquire).
 *
 * "Force edit" simply bypasses the lock, the save still goes through
 * and divergence surfaces in the version history (each save is its
 * own row keyed by `savedByUserId`).
 */
export const storyChapterLocks = sqliteTable(
  "story_chapter_locks",
  {
    chapterId: text("chapter_id")
      .primaryKey()
      .references(() => storyChapters.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    acquiredAt: ts("acquired_at"),
    lastRefreshAt: ts("last_refresh_at"),
  },
  (t) => ({
    userIdx: index("story_chapter_locks_user_idx").on(t.userId),
  }),
);

/* ---------- Scriptorium collaborators (Phase 5) ---------- */

/**
 * Per-story collaborators. The owner (`stories.authorUserId`) is
 * implicit and never has a row here. Three added roles:
 *
 *   reader   , read drafts only (beta readers)
 *   editor   , edit existing chapters + manage codex
 *   co_author, edit + add chapters, publish; cannot manage
 *               collaborators or delete the story
 *
 * `acceptedAt` null = pending invite (recipient hasn't decided);
 * non-null = active. Declining deletes the row server-side, so the
 * "rejected" state never persists.
 */
export const storyCollaborators = sqliteTable(
  "story_collaborators",
  {
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    invitedByUserId: text("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
    invitedAt: ts("invited_at"),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.storyId, t.userId] }),
    userIdx: index("story_collaborators_user_idx").on(t.userId, t.invitedAt),
    storyIdx: index("story_collaborators_story_idx").on(t.storyId, t.acceptedAt),
  }),
);

/* ---------- Scriptorium codex (Phase 8) ---------- */

/**
 * Per-story continuity bible. Three discriminated kinds, characters,
 * locations, plot points, share one table with a `kind` column. Each
 * entity has a per-(story, kind) unique slug so a character and a
 * location can share a name without colliding.
 *
 * `isPublic` opt-in surfaces an entity in the reader's "Cast & places"
 * appendix on the story landing page. Private by default, plot
 * outlines especially shouldn't leak by default.
 */
export const storyEntities = sqliteTable(
  "story_entities",
  {
    id: id(),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    /** "character" | "location" | "plot", enforced at the Zod layer. */
    kind: text("kind").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    bodyHtml: text("body_html").notNull().default(""),
    /** Free-form kv map. Renderer / editor decide what to surface per kind. */
    statsJson: text("stats_json").notNull().default("{}"),
    imageUrl: text("image_url"),
    isPublic: integer("is_public").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    storyKindSlugUq: uniqueIndex("story_entities_story_kind_slug_uq").on(
      t.storyId,
      t.kind,
      sql`lower(${t.slug})`,
    ),
    orderIdx: index("story_entities_order_idx").on(t.storyId, t.kind, t.sortOrder),
  }),
);

/* ---------- Scriptorium reports (Phase 10) ---------- */

/**
 * User-filed report against a story, chapter, review, or review reply.
 * One unified table with a `targetKind` discriminator keeps the admin
 * queue surface uniform.
 *
 * The `snapshotJson` captures title / body / metadata at report time
 * so the queue stays useful even if the author later deletes the
 * reported content, mirror of the `bodySnapshot` pattern on the DM
 * reports column of `reports` above.
 *
 * One report per (reporter, target). Second click silently no-ops.
 */
export const storyReports = sqliteTable(
  "story_reports",
  {
    id: id(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    reporterUserId: text("reporter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason"),
    snapshotJson: text("snapshot_json").notNull().default("{}"),
    status: text("status", { enum: ["open", "reviewed", "dismissed"] })
      .notNull()
      .default("open"),
    resolvedById: text("resolved_by_id").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    resolutionNote: text("resolution_note"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    reporterTargetUq: uniqueIndex("story_reports_reporter_target_uq").on(
      t.reporterUserId,
      t.targetKind,
      t.targetId,
    ),
    statusIdx: index("story_reports_status_idx").on(t.status, t.createdAt),
    storyIdx: index("story_reports_story_idx").on(t.storyId),
  }),
);
