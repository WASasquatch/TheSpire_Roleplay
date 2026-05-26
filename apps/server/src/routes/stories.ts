import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { isAdminRole } from "@thekeep/shared";
import type {
  PrivateStoryStub,
  Role,
  StoryApplauseState,
  StoryAuthor,
  StoryCard,
  StoryCatalogPage,
  StoryChapter,
  StoryChapterLockState,
  StoryChapterPublishedEvent,
  StoryChapterRef,
  StoryChapterStatus,
  StoryChapterVersion,
  StoryCollaborator,
  StoryCollaboratorInvite,
  StoryCollaboratorRole,
  StoryDetail,
  StoryEntity,
  StoryEntityKind,
  StoryGenre,
  StoryRating,
  StoryReadingPosition,
  StoryReport,
  StoryReportStatus,
  StoryReportTargetKind,
  StoryReview,
  StoryReviewPage,
  StoryReviewReply,
  StoryReviewer,
  StoryStatus,
  StorySubscriptionState,
  StoryVisibility,
  Theme,
} from "@thekeep/shared";
import {
  PUBLIC_READABLE_RATINGS,
  SFW_RATINGS,
  STORY_AUTOSAVE_HISTORY_CAP,
  STORY_CHAPTER_CAP,
  STORY_CHAPTER_LOCK_LEASE_MS,
  STORY_CONTENT_WARNINGS,
  STORY_ENTITY_BODY_MAX,
  STORY_ENTITY_KINDS,
  STORY_ENTITY_PER_KIND_CAP,
  STORY_GENRES,
  STORY_COLLABORATOR_ROLES,
  STORY_REVIEW_BODY_MAX,
  STORY_REVIEW_EDIT_GRACE_MS,
  STORY_REVIEW_REPLY_MAX,
  STORY_TAG_CAP,
  permissionsForCollaboratorRole,
  countWords,
  deriveStorySlug,
  normalizeTheme,
  parseTagList,
  serializeTagList,
} from "@thekeep/shared";
import {
  characters,
  earningLedger,
  stories,
  storyApplause,
  storyChapterLocks,
  storyChapters,
  storyChapterVersions,
  storyCollaborators,
  storyEntities,
  storyReadingPositions,
  storyReports,
  storyReviewReplies,
  storyReviews,
  storySubscriptions,
  users,
  worlds,
} from "../db/schema.js";
import { sanitizeBio, stripMarginNotes } from "../auth/html.js";
import { getSessionUser } from "./auth.js";
import { pushToUser } from "../push.js";
import { creditPool } from "../earning/award.js";
import { recordAudit } from "../audit.js";
import type { Db } from "../db/index.js";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** Slug rules: lowercase letters, numbers, hyphens. 1-60 chars. Same shape as worlds. */
const SLUG_RX = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

const visibilityEnum = z.enum(["private", "unlisted", "public"]);
const ratingEnum = z.enum(["G", "PG", "PG-13", "R", "NC-17"]);
const statusEnum = z.enum(["draft", "in_progress", "complete", "hiatus", "abandoned"]);
const genreEnum = z.enum(STORY_GENRES as unknown as [string, ...string[]]);
const cwEnum = z.enum(STORY_CONTENT_WARNINGS as unknown as [string, ...string[]]);
const chapterStatusEnum = z.enum(["draft", "published"]);

const TAG_RX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const tagSchema = z
  .string()
  .min(1)
  .max(32)
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => TAG_RX.test(s), { message: "tags must be lowercase letters / digits / hyphens" });
const tagsArraySchema = z
  .array(tagSchema)
  .max(STORY_TAG_CAP)
  .transform((arr) => parseTagList(arr.join(",")));
const cwArraySchema = z
  .array(cwEnum)
  .max(STORY_CONTENT_WARNINGS.length)
  .transform((arr) => parseTagList(arr.join(",")));

const httpUrl = z.string().min(1).max(2000).refine(
  (s) => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } },
  { message: "coverImageUrl must use http or https" },
);

const createStoryBody = z.object({
  title: z.string().min(1).max(120),
  slug: z.string().max(60).optional(),
  summary: z.string().max(280).optional(),
  synopsisHtml: z.string().max(20_000).optional(),
  authorCharacterId: z.string().nullable().optional(),
  genre: genreEnum.optional(),
  rating: ratingEnum.optional(),
  visibility: visibilityEnum.optional(),
  status: statusEnum.optional(),
  tags: tagsArraySchema.optional(),
  contentWarnings: cwArraySchema.optional(),
  linkedWorldId: z.string().nullable().optional(),
  coverImageUrl: httpUrl.nullable().optional(),
  allowReviews: z.boolean().optional(),
  allowApplause: z.boolean().optional(),
}).strict();

const updateStoryBody = z.object({
  title: z.string().min(1).max(120).optional(),
  slug: z.string().max(60).optional(),
  summary: z.string().max(280).optional(),
  synopsisHtml: z.string().max(20_000).optional(),
  authorCharacterId: z.string().nullable().optional(),
  theme: z.union([z.record(z.unknown()), z.null()]).optional(),
  genre: genreEnum.optional(),
  rating: ratingEnum.optional(),
  visibility: visibilityEnum.optional(),
  status: statusEnum.optional(),
  tags: tagsArraySchema.optional(),
  contentWarnings: cwArraySchema.optional(),
  linkedWorldId: z.string().nullable().optional(),
  coverImageUrl: httpUrl.nullable().optional(),
  allowReviews: z.boolean().optional(),
  allowApplause: z.boolean().optional(),
}).strict();

const catalogQuery = z.object({
  q: z.string().max(120).optional(),
  tag: z.preprocess(
    (v) => (typeof v === "string" ? [v] : v),
    z.array(z.string().max(32)).optional(),
  ),
  exclude: z.preprocess(
    (v) => (typeof v === "string" ? [v] : v),
    z.array(z.string().max(32)).optional(),
  ),
  genre: genreEnum.optional(),
  rating: ratingEnum.optional(),
  status: statusEnum.optional(),
  worldId: z.string().optional(),
  authorId: z.string().optional(),
  sort: z.enum(["updated", "published", "most_read", "applause"]).optional(),
  page: z.coerce.number().int().min(0).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
}).strict();

const createChapterBody = z.object({
  title: z.string().max(120).optional(),
  bodyHtml: z.string().max(500_000).optional(),
  authorNotesHtml: z.string().max(20_000).optional(),
  contentWarnings: cwArraySchema.optional(),
}).strict();

const updateChapterBody = z.object({
  title: z.string().max(120).optional(),
  bodyHtml: z.string().max(500_000).optional(),
  authorNotesHtml: z.string().max(20_000).optional(),
  contentWarnings: cwArraySchema.optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  status: chapterStatusEnum.optional(),
  reason: z.enum(["autosave", "manual"]).optional(),
}).strict();

const upsertReadingPositionBody = z.object({
  lastChapterId: z.string().nullable().optional(),
  lastAnchorId: z.string().nullable().optional(),
  percentThrough: z.number().min(0).max(100).optional(),
}).strict();

const createReviewBody = z.object({
  rating: z.number().int().min(1).max(5),
  bodyHtml: z.string().max(STORY_REVIEW_BODY_MAX).optional(),
  /** Identity to publish under. Null = master account. Must be one of the caller's characters. */
  reviewerCharacterId: z.string().nullable().optional(),
}).strict();

const updateReviewBody = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  bodyHtml: z.string().max(STORY_REVIEW_BODY_MAX).optional(),
}).strict();

/** Body of the author-only moderation PATCH on a review. */
const moderateReviewBody = z.object({
  pinnedByAuthor: z.boolean().optional(),
  hiddenByAuthor: z.boolean().optional(),
}).strict();

const createReplyBody = z.object({
  bodyHtml: z.string().min(1).max(STORY_REVIEW_REPLY_MAX),
  replyerCharacterId: z.string().nullable().optional(),
}).strict();

const applauseToggleBody = z.object({
  /** Optional — null/omitted toggles applause on the whole story. */
  chapterId: z.string().nullable().optional(),
}).strict();

/* ---------- Codex schemas (Phase 8) ---------- */

const entityKindEnum = z.enum(STORY_ENTITY_KINDS as unknown as [string, ...string[]]);
const statsRecord = z.record(z.string().max(500)).refine(
  (o) => Object.keys(o).length <= 50,
  { message: "max 50 stats keys" },
);

const createEntityBody = z.object({
  kind: entityKindEnum,
  name: z.string().min(1).max(120),
  slug: z.string().max(60).optional(),
  summary: z.string().max(500).optional(),
  bodyHtml: z.string().max(STORY_ENTITY_BODY_MAX).optional(),
  stats: statsRecord.optional(),
  imageUrl: httpUrl.nullable().optional(),
  isPublic: z.boolean().optional(),
}).strict();

const updateEntityBody = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z.string().max(60).optional(),
  summary: z.string().max(500).optional(),
  bodyHtml: z.string().max(STORY_ENTITY_BODY_MAX).optional(),
  stats: statsRecord.optional(),
  imageUrl: httpUrl.nullable().optional(),
  isPublic: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
}).strict();

/* =========================================================
 *  Helpers
 * ========================================================= */

async function loadAuthor(db: Db, userId: string, characterId: string | null): Promise<StoryAuthor> {
  const u = (await db
    .select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0];
  let characterName: string | null = null;
  let characterAvatarUrl: string | null = null;
  if (characterId) {
    const c = (await db
      .select({ name: characters.name, avatarUrl: characters.avatarUrl })
      .from(characters)
      .where(eq(characters.id, characterId))
      .limit(1))[0];
    if (c) {
      characterName = c.name;
      characterAvatarUrl = c.avatarUrl ?? null;
    }
  }
  return {
    userId,
    masterUsername: u?.username ?? "(deleted user)",
    characterId,
    characterName,
    characterAvatarUrl,
    masterAvatarUrl: u?.avatarUrl ?? null,
  };
}

function parseStoredTheme(raw: string | null): Theme | null {
  if (!raw) return null;
  try { return normalizeTheme(JSON.parse(raw)); }
  catch { return null; }
}

async function loadLinkedWorldRef(
  db: Db,
  worldId: string | null,
): Promise<{ id: string; slug: string; name: string } | null> {
  if (!worldId) return null;
  const w = (await db
    .select({ id: worlds.id, slug: worlds.slug, name: worlds.name })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1))[0];
  return w ?? null;
}

async function toCard(db: Db, row: typeof stories.$inferSelect): Promise<StoryCard> {
  const author = await loadAuthor(db, row.authorUserId, row.authorCharacterId ?? null);
  const linkedWorld = await loadLinkedWorldRef(db, row.linkedWorldId ?? null);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary ?? "",
    coverImageUrl: row.coverImageUrl ?? null,
    author,
    genre: (row.genre ?? "other") as StoryGenre,
    rating: (row.rating ?? "PG") as StoryRating,
    status: (row.status ?? "draft") as StoryStatus,
    visibility: (row.visibility ?? "private") as StoryVisibility,
    tags: parseTagList(row.tags),
    contentWarnings: parseTagList(row.contentWarnings),
    linkedWorld,
    totalWords: row.totalWords ?? 0,
    totalChapters: row.totalChapters ?? 0,
    readerCount: row.readerCount ?? 0,
    applauseCount: row.applauseCount ?? 0,
    reviewCount: row.reviewCount ?? 0,
    avgRating: row.avgRatingX100 == null ? null : Math.round(row.avgRatingX100) / 100,
    publishedAt: row.publishedAt ? +row.publishedAt : null,
    updatedAt: +row.updatedAt,
  };
}

function chapterRowToRef(row: typeof storyChapters.$inferSelect): StoryChapterRef {
  return {
    id: row.id,
    storyId: row.storyId,
    sortOrder: row.sortOrder,
    title: row.title,
    status: row.status as StoryChapterStatus,
    wordCount: row.wordCount,
    contentWarnings: parseTagList(row.contentWarnings),
    publishedAt: row.publishedAt ? +row.publishedAt : null,
    updatedAt: +row.updatedAt,
  };
}

function chapterRowToFull(row: typeof storyChapters.$inferSelect): StoryChapter {
  return {
    ...chapterRowToRef(row),
    bodyHtml: row.bodyHtml,
    authorNotesHtml: row.authorNotesHtml,
    createdAt: +row.createdAt,
  };
}

function entityRowToWire(row: typeof storyEntities.$inferSelect): StoryEntity {
  let stats: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row.statsJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      stats = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    }
  } catch { /* leave empty */ }
  return {
    id: row.id,
    storyId: row.storyId,
    kind: row.kind as StoryEntityKind,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    bodyHtml: row.bodyHtml,
    stats,
    imageUrl: row.imageUrl ?? null,
    isPublic: !!row.isPublic,
    sortOrder: row.sortOrder,
    createdAt: +row.createdAt,
    updatedAt: +row.updatedAt,
  };
}

/**
 * Inject `<p data-anchor="p-N">` markers onto every top-level paragraph
 * so the "continue reading" pointer can ride on them. Paragraphs that
 * already carry a `data-anchor` are left untouched.
 */
function injectParagraphAnchors(html: string): string {
  let n = 0;
  return html.replace(/<p(\b[^>]*)>/gi, (match, attrs: string) => {
    if (/\bdata-anchor=/i.test(attrs)) return match;
    return `<p${attrs} data-anchor="p-${n++}">`;
  });
}

/**
 * Visibility + rating gating for a single viewer. Returns either ok,
 * a stub (sign-in prompt), or a true 404 signal.
 */
async function viewerMayRead(
  story: typeof stories.$inferSelect,
  viewerUserId: string | null,
  viewerRole: Role | null,
  /** Optional: passing the db lets us include collaborators in the visibility check. */
  db?: Db,
): Promise<
  | { ok: true }
  | { ok: false; stub: PrivateStoryStub }
  | { ok: false; missing: true }
> {
  const isOwner = viewerUserId != null && story.authorUserId === viewerUserId;
  const isAdmin = viewerRole != null && isAdminRole(viewerRole);

  if (isOwner || isAdmin) return { ok: true };

  // Active collaborator (any role) can see the story regardless of
  // visibility. Pending collaborators (acceptedAt null) fall through
  // to the public/unlisted branches below.
  if (viewerUserId && db) {
    const collab = (await db
      .select({ acceptedAt: storyCollaborators.acceptedAt })
      .from(storyCollaborators)
      .where(and(eq(storyCollaborators.storyId, story.id), eq(storyCollaborators.userId, viewerUserId)))
      .limit(1))[0];
    if (collab && collab.acceptedAt) return { ok: true };
  }

  if (story.visibility === "private") {
    if (viewerUserId) return { ok: false, missing: true };
    return {
      ok: false,
      stub: {
        private: true,
        title: story.title,
        slug: story.slug,
        reason: "visibility",
        requiresAuth: true,
      },
    };
  }

  // Anonymous viewers can read up through R (PUBLIC_READABLE_RATINGS).
  // Only NC-17 is gated behind the login wall — the rest is
  // publicly readable so the Scriptorium has the bulk of its catalog
  // open to share off-site.
  const publicReadable = (PUBLIC_READABLE_RATINGS as readonly string[]).includes(story.rating);
  if (!viewerUserId && !publicReadable) {
    return {
      ok: false,
      stub: {
        private: true,
        title: story.title,
        slug: story.slug,
        reason: "rating",
        requiresAuth: true,
      },
    };
  }

  return { ok: true };
}

async function resolveStory(
  db: Db,
  idOrSlug: string,
  viewerUserId: string | null,
): Promise<typeof stories.$inferSelect | null> {
  let s = (await db.select().from(stories).where(eq(stories.id, idOrSlug)).limit(1))[0];
  if (s) return s;
  const lower = idOrSlug.toLowerCase();
  if (viewerUserId) {
    const own = (await db
      .select()
      .from(stories)
      .where(and(eq(stories.authorUserId, viewerUserId), sql`lower(${stories.slug}) = ${lower}`))
      .limit(1))[0];
    if (own) return own;
  }
  const pub = (await db
    .select()
    .from(stories)
    .where(and(
      sql`lower(${stories.slug}) = ${lower}`,
      or(eq(stories.visibility, "public"), eq(stories.visibility, "unlisted")),
    ))
    .orderBy(desc(stories.updatedAt))
    .limit(1))[0];
  return pub ?? null;
}

async function resolveStoryByHandle(
  db: Db,
  handle: string,
  slug: string,
): Promise<typeof stories.$inferSelect | null> {
  const u = (await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${handle.toLowerCase()}`)
    .limit(1))[0];
  if (!u) return null;
  return (await db
    .select()
    .from(stories)
    .where(and(eq(stories.authorUserId, u.id), sql`lower(${stories.slug}) = ${slug.toLowerCase()}`))
    .limit(1))[0] ?? null;
}

async function recountStoryTotals(db: Db, storyId: string): Promise<void> {
  const rows = await db
    .select({
      total: sql<number>`coalesce(sum(${storyChapters.wordCount}), 0)`,
      published: sql<number>`sum(case when ${storyChapters.status} = 'published' then 1 else 0 end)`,
    })
    .from(storyChapters)
    .where(eq(storyChapters.storyId, storyId));
  const totalWords = rows[0]?.total ?? 0;
  const totalChapters = rows[0]?.published ?? 0;
  await db
    .update(stories)
    .set({ totalWords, totalChapters, updatedAt: new Date() })
    .where(eq(stories.id, storyId));
}

/**
 * Drizzle transaction context for the better-sqlite3 adapter. Extracted
 * from the `Db["transaction"]` callback signature so the sync helpers
 * below can be typed without naming the adapter-specific class.
 */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Sync, transactional twin of `recountStoryTotals`. Use inside a
 * `db.transaction(...)` block when chapter mutations + story totals
 * must commit atomically — otherwise a crash between the chapter
 * UPDATE and the totals UPDATE leaves the story row claiming a word
 * count that doesn't match its chapters.
 */
function recountStoryTotalsTx(tx: Tx, storyId: string): void {
  const row = tx
    .select({
      total: sql<number>`coalesce(sum(${storyChapters.wordCount}), 0)`,
      published: sql<number>`sum(case when ${storyChapters.status} = 'published' then 1 else 0 end)`,
    })
    .from(storyChapters)
    .where(eq(storyChapters.storyId, storyId))
    .all()[0];
  const totalWords = row?.total ?? 0;
  const totalChapters = row?.published ?? 0;
  tx
    .update(stories)
    .set({ totalWords, totalChapters, updatedAt: new Date() })
    .where(eq(stories.id, storyId))
    .run();
}

async function appendChapterVersion(
  db: Db,
  chapterId: string,
  body: { bodyHtml: string; authorNotesHtml: string },
  reason: "autosave" | "publish" | "manual",
  savedByUserId: string,
): Promise<void> {
  await db.transaction((tx) => {
    appendChapterVersionTx(tx, chapterId, body, reason, savedByUserId);
  });
}

/**
 * Sync, transactional twin of `appendChapterVersion`. Use inside an
 * existing `db.transaction(...)` block when the version write needs to
 * commit atomically with surrounding chapter / story writes.
 *
 * Picks the next version number via a SUBQUERY in the INSERT so the
 * "read MAX, then INSERT MAX+1" race is eliminated — two concurrent
 * saves under the SQLite write lock would otherwise both read the
 * same MAX and the loser would 500 on the `(chapter_id, version)`
 * unique index. The subquery evaluates inside the same transaction
 * holding the write lock, so the value cannot drift between read
 * and insert.
 */
function appendChapterVersionTx(
  tx: Tx,
  chapterId: string,
  body: { bodyHtml: string; authorNotesHtml: string },
  reason: "autosave" | "publish" | "manual",
  savedByUserId: string,
): void {
  tx.insert(storyChapterVersions).values({
    id: nanoid(),
    chapterId,
    version: sql<number>`coalesce((select max(${storyChapterVersions.version}) from ${storyChapterVersions} where ${storyChapterVersions.chapterId} = ${chapterId}), 0) + 1`,
    bodyHtml: body.bodyHtml,
    authorNotesHtml: body.authorNotesHtml,
    reason,
    savedByUserId,
  }).run();
  if (reason === "autosave") {
    const autosaves = tx
      .select({ id: storyChapterVersions.id })
      .from(storyChapterVersions)
      .where(and(
        eq(storyChapterVersions.chapterId, chapterId),
        eq(storyChapterVersions.reason, "autosave"),
      ))
      .orderBy(desc(storyChapterVersions.savedAt))
      .all();
    if (autosaves.length > STORY_AUTOSAVE_HISTORY_CAP) {
      const drop = autosaves.slice(STORY_AUTOSAVE_HISTORY_CAP).map((r) => r.id);
      for (const id of drop) {
        tx.delete(storyChapterVersions).where(eq(storyChapterVersions.id, id)).run();
      }
    }
  }
}

/** Look up the master username for a lock holder, for the read-only banner. */
async function loadLockHolder(db: Db, userId: string): Promise<{ userId: string; username: string }> {
  const u = (await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0];
  return { userId, username: u?.username ?? "(unknown)" };
}

async function isOwnIdentity(db: Db, userId: string, characterId: string | null): Promise<boolean> {
  if (!characterId) return true;
  const c = (await db
    .select()
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.userId, userId)))
    .limit(1))[0];
  return c != null;
}

/* ---------- Permission helper (Phase 5) ---------- */

/**
 * Resolve what a viewer can do on a story. Combines:
 *   - implicit owner role (`stories.authorUserId === viewer`)
 *   - admin override (full powers)
 *   - active collaborator role (reader / editor / co_author)
 *   - public read for anyone the visibility gate already let through
 *
 * Returns an object the caller can spot-check (`perm.editChapters`,
 * `perm.publish`, `perm.manageCollaborators`, etc.). The view-side
 * `viewerMayRead` gate is separate and runs first — this helper only
 * answers "what does this viewer get to MUTATE."
 */
async function effectiveStoryPermissions(
  db: Db,
  story: typeof stories.$inferSelect,
  viewerUserId: string | null,
  viewerRole: Role | null,
): Promise<{
  role: "owner" | "admin" | StoryCollaboratorRole | "viewer";
  readDrafts: boolean;
  editChapters: boolean;
  addChapters: boolean;
  manageCodex: boolean;
  manageCollaborators: boolean;
  publish: boolean;
  deleteStory: boolean;
}> {
  if (viewerUserId && story.authorUserId === viewerUserId) {
    return {
      role: "owner",
      readDrafts: true, editChapters: true, addChapters: true,
      manageCodex: true, manageCollaborators: true, publish: true, deleteStory: true,
    };
  }
  if (viewerRole && isAdminRole(viewerRole)) {
    return {
      role: "admin",
      readDrafts: true, editChapters: true, addChapters: true,
      manageCodex: true, manageCollaborators: true, publish: true, deleteStory: true,
    };
  }
  if (viewerUserId) {
    const collab = (await db
      .select()
      .from(storyCollaborators)
      .where(and(eq(storyCollaborators.storyId, story.id), eq(storyCollaborators.userId, viewerUserId)))
      .limit(1))[0];
    if (collab && collab.acceptedAt) {
      const role = collab.role as StoryCollaboratorRole;
      const perms = permissionsForCollaboratorRole(role);
      return {
        role,
        readDrafts: perms.readDrafts,
        editChapters: perms.editChapters,
        addChapters: perms.addChapters,
        manageCodex: perms.manageCodex,
        manageCollaborators: false,
        publish: perms.publish,
        deleteStory: false,
      };
    }
  }
  return {
    role: "viewer",
    readDrafts: false,
    editChapters: false,
    addChapters: false,
    manageCodex: false,
    manageCollaborators: false,
    publish: false,
    deleteStory: false,
  };
}

/* ---------- Reviews + applause helpers ---------- */

/** Reviewer is structurally identical to StoryAuthor; reuse the same loader. */
async function loadReviewer(db: Db, userId: string, characterId: string | null): Promise<StoryReviewer> {
  return loadAuthor(db, userId, characterId);
}

/**
 * Recompute review_count + avg_rating_x100 from the visible reviews
 * (i.e. excludes hidden-by-author). Stored as integer * 100 for sort
 * stability without floats.
 */
async function recountStoryReviews(db: Db, storyId: string): Promise<void> {
  const row = (await db
    .select({
      n: sql<number>`count(*)`,
      avg: sql<number>`coalesce(round(avg(${storyReviews.rating}) * 100), 0)`,
    })
    .from(storyReviews)
    .where(and(eq(storyReviews.storyId, storyId), eq(storyReviews.hiddenByAuthor, 0))))[0];
  await db
    .update(stories)
    .set({
      reviewCount: row?.n ?? 0,
      avgRatingX100: row?.n ? (row.avg ?? null) : null,
      updatedAt: new Date(),
    })
    .where(eq(stories.id, storyId));
}

/** Recompute applause_count from the applause rows (story-level only). */
async function recountStoryApplause(db: Db, storyId: string): Promise<void> {
  const row = (await db
    .select({ n: sql<number>`count(*)` })
    .from(storyApplause)
    .where(eq(storyApplause.storyId, storyId)))[0];
  await db
    .update(stories)
    .set({ applauseCount: row?.n ?? 0, updatedAt: new Date() })
    .where(eq(stories.id, storyId));
}

function reviewRowToWire(
  row: typeof storyReviews.$inferSelect,
  reviewer: StoryReviewer,
  replies: StoryReviewReply[],
): StoryReview {
  return {
    id: row.id,
    storyId: row.storyId,
    reviewer,
    rating: row.rating,
    bodyHtml: row.bodyHtml,
    pinnedByAuthor: !!row.pinnedByAuthor,
    hiddenByAuthor: !!row.hiddenByAuthor,
    editGraceExpiresAt: row.editGraceExpiresAt ? +row.editGraceExpiresAt : null,
    createdAt: +row.createdAt,
    updatedAt: +row.updatedAt,
    replies,
  };
}

function replyRowToWire(
  row: typeof storyReviewReplies.$inferSelect,
  replyer: StoryReviewer,
): StoryReviewReply {
  return {
    id: row.id,
    reviewId: row.reviewId,
    replyer,
    bodyHtml: row.bodyHtml,
    createdAt: +row.createdAt,
    updatedAt: +row.updatedAt,
  };
}

/* =========================================================
 *  Routes
 * ========================================================= */

export async function registerStoryRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /**
   * Shared detail builder used by both id-or-slug and @handle/slug lookups.
   */
  async function buildDetail(
    s: typeof stories.$inferSelect,
    me: { id: string; role: Role } | null,
  ): Promise<StoryDetail> {
    const card = await toCard(db, s);
    const isAuthor = !!me && me.id === s.authorUserId;
    const isAdmin = !!me && isAdminRole(me.role);
    // Collaborators with `readDrafts` (all active roles do) see drafts
    // alongside published chapters, same as the author + admin path.
    const perm = me ? await effectiveStoryPermissions(db, s, me.id, me.role) : null;
    const includeAllChapters = isAuthor || isAdmin || (perm?.readDrafts ?? false);
    const chapterRows = await db
      .select()
      .from(storyChapters)
      .where(includeAllChapters
        ? eq(storyChapters.storyId, s.id)
        : and(eq(storyChapters.storyId, s.id), eq(storyChapters.status, "published")))
      .orderBy(asc(storyChapters.sortOrder));

    let readingPosition: StoryReadingPosition | null = null;
    if (me) {
      const rp = (await db
        .select()
        .from(storyReadingPositions)
        .where(and(eq(storyReadingPositions.storyId, s.id), eq(storyReadingPositions.userId, me.id)))
        .limit(1))[0];
      if (rp) {
        readingPosition = {
          storyId: rp.storyId,
          lastChapterId: rp.lastChapterId ?? null,
          lastAnchorId: rp.lastAnchorId ?? null,
          percentThrough: Math.round((rp.percentThrough ?? 0) / 10),
          updatedAt: +rp.updatedAt,
        };
      }
    }

    return {
      story: {
        ...card,
        synopsisHtml: s.synopsisHtml ?? "",
        theme: parseStoredTheme(s.themeJson),
        allowReviews: !!s.allowReviews,
        allowApplause: !!s.allowApplause,
        createdAt: +s.createdAt,
      },
      chapters: chapterRows.map(chapterRowToRef),
      viewerCanEdit: isAuthor || isAdmin || (perm?.editChapters ?? false),
      viewerIsAuthor: isAuthor,
      readingPosition,
    };
  }

  /* ---------- Splash catalog (anonymous-safe, SFW only) ---------- */
  app.get<{ Querystring: { limit?: string } }>("/stories/splash", async (req) => {
    const limit = Math.min(24, Math.max(1, parseInt(req.query.limit ?? "12", 10) || 12));
    const sfwList = SFW_RATINGS as readonly string[];
    const rows = await db
      .select()
      .from(stories)
      .where(and(
        eq(stories.visibility, "public"),
        ne(stories.status, "draft"),
        ne(stories.status, "abandoned"),
        or(
          eq(stories.rating, sfwList[0]!),
          eq(stories.rating, sfwList[1]!),
          eq(stories.rating, sfwList[2]!),
        ),
      ))
      .orderBy(desc(stories.publishedAt), desc(stories.updatedAt))
      .limit(limit);
    const entries = await Promise.all(rows.map((r) => toCard(db, r)));
    return { entries };
  });

  /* ---------- Caller's own stories ---------- */
  app.get("/me/stories", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const rows = await db
      .select()
      .from(stories)
      .where(eq(stories.authorUserId, me.id))
      .orderBy(desc(stories.updatedAt));
    const cards = await Promise.all(rows.map((r) => toCard(db, r)));
    return { stories: cards };
  });

  /* ---------- Reader's continue-reading list ---------- */
  app.get("/me/stories/reading", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const rows = await db
      .select({ story: stories, position: storyReadingPositions })
      .from(storyReadingPositions)
      .innerJoin(stories, eq(stories.id, storyReadingPositions.storyId))
      .where(eq(storyReadingPositions.userId, me.id))
      .orderBy(desc(storyReadingPositions.updatedAt))
      .limit(50);
    const cards = await Promise.all(rows.map((r) => toCard(db, r.story)));
    return { stories: cards };
  });

  /* ---------- Full catalog (auth-aware filtering) ---------- */
  app.get<{ Querystring: Record<string, string | string[]> }>("/stories/catalog", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const parsed = catalogQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid catalog query" };
    }
    const q = parsed.data;
    const pageSize = q.pageSize ?? 24;
    const page = q.page ?? 0;

    const conds: ReturnType<typeof eq>[] = [eq(stories.visibility, "public")];
    if (q.genre) conds.push(eq(stories.genre, q.genre));
    if (q.rating) conds.push(eq(stories.rating, q.rating));
    if (q.status) conds.push(eq(stories.status, q.status));
    if (q.worldId) conds.push(eq(stories.linkedWorldId, q.worldId));
    if (q.authorId) conds.push(eq(stories.authorUserId, q.authorId));

    // Rating gating, per the simplified design:
    //   - Signed-in viewers see EVERYTHING. The mature-content gate
    //     for signed-in users happens at the body-open / reader
    //     step (splash warning before display), not at catalog
    //     listing time — hiding R / NC-17 from the catalog was
    //     making authors unable to find their own published work
    //     and giving signed-in readers a confusing "where's that
    //     story I saw yesterday" experience.
    //   - Anonymous viewers see UP TO R. NC-17 is hidden from the
    //     anonymous catalog entirely (no chip, no cover thumbnail)
    //     — the existing body-open route still returns the
    //     private-stub for NC-17 if someone somehow lands on a URL,
    //     so this is just removing the listing-side leak.
    // `users.storyCwBlocklist` is still honored as a personal
    // opt-OUT for signed-in readers who explicitly chose to hide
    // certain content warnings (configurable in profile settings);
    // it's a viewer preference, not a default gate.
    if (me) {
      const meRow = (await db
        .select({ cw: users.storyCwBlocklist })
        .from(users)
        .where(eq(users.id, me.id))
        .limit(1))[0];
      const userBlocklist = parseTagList(meRow?.cw ?? "");
      for (const cw of userBlocklist) {
        const needle = `%,${cw.toLowerCase()},%`;
        conds.push(sql`(',' || lower(${stories.contentWarnings}) || ',') NOT LIKE ${needle}`);
      }
    } else {
      // Anonymous: cap at R. NC-17 cards are stripped from the
      // listing entirely (cards never reach unauthenticated
      // viewers; the body-open route would still 401-stub them
      // even if a URL were guessed).
      const allowed = PUBLIC_READABLE_RATINGS as readonly string[];
      conds.push(or(
        ...allowed.map((r) => eq(stories.rating, r)),
      )!);
    }

    if (q.q && q.q.trim()) {
      const like = `%${q.q.trim().replace(/[%_]/g, (c) => `\\${c}`).toLowerCase()}%`;
      conds.push(or(
        sql`lower(${stories.title}) LIKE ${like} ESCAPE '\\'`,
        sql`lower(${stories.summary}) LIKE ${like} ESCAPE '\\'`,
        sql`lower(${stories.tags}) LIKE ${like} ESCAPE '\\'`,
      )!);
    }
    if (q.tag && q.tag.length > 0) {
      for (const t of q.tag) {
        const needle = `%,${t.toLowerCase()},%`;
        conds.push(sql`(',' || lower(${stories.tags}) || ',') LIKE ${needle}`);
      }
    }
    if (q.exclude && q.exclude.length > 0) {
      for (const cw of q.exclude) {
        const needle = `%,${cw.toLowerCase()},%`;
        conds.push(sql`(',' || lower(${stories.contentWarnings}) || ',') NOT LIKE ${needle}`);
      }
    }

    const whereExpr = and(...conds);
    const totalRow = (await db
      .select({ n: sql<number>`count(*)` })
      .from(stories)
      .where(whereExpr))[0];
    const total = totalRow?.n ?? 0;

    const orderBy = q.sort === "published"
      ? [desc(stories.publishedAt), desc(stories.updatedAt)]
      : q.sort === "most_read"
        ? [desc(stories.readerCount), desc(stories.updatedAt)]
        : q.sort === "applause"
          ? [desc(stories.applauseCount), desc(stories.updatedAt)]
          : [desc(stories.updatedAt)];

    const rows = await db
      .select()
      .from(stories)
      .where(whereExpr)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(page * pageSize);
    const entries = await Promise.all(rows.map((r) => toCard(db, r)));
    const payload: StoryCatalogPage = {
      entries,
      page,
      pageSize,
      total,
      hasMore: (page + 1) * pageSize < total,
    };
    return payload;
  });

  /* ---------- Create story ---------- */
  app.post<{ Body: unknown }>("/stories", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let body;
    try { body = createStoryBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const slug = (body.slug ?? deriveStorySlug(body.title)).toLowerCase();
    if (!SLUG_RX.test(slug)) {
      reply.code(400);
      return { error: "slug must be 1-60 lowercase letters, numbers, hyphens" };
    }
    const dup = (await db
      .select()
      .from(stories)
      .where(and(eq(stories.authorUserId, me.id), sql`lower(${stories.slug}) = ${slug}`))
      .limit(1))[0];
    if (dup) { reply.code(409); return { error: "you already have a story with that slug" }; }

    if (body.authorCharacterId !== undefined) {
      const ok = await isOwnIdentity(db, me.id, body.authorCharacterId ?? null);
      if (!ok) { reply.code(400); return { error: "authorCharacterId is not one of your characters" }; }
    }

    if (body.linkedWorldId) {
      const w = (await db.select().from(worlds).where(eq(worlds.id, body.linkedWorldId)).limit(1))[0];
      if (!w || (w.visibility === "private" && w.ownerUserId !== me.id)) {
        reply.code(400);
        return { error: "linkedWorldId must reference a world you can see" };
      }
    }

    const id = nanoid();
    try {
      await db.insert(stories).values({
        id,
        authorUserId: me.id,
        authorCharacterId: body.authorCharacterId ?? null,
        slug,
        title: body.title.trim(),
        summary: body.summary?.trim() ?? "",
        synopsisHtml: body.synopsisHtml ? sanitizeBio(body.synopsisHtml) : "",
        coverImageUrl: body.coverImageUrl ?? null,
        genre: body.genre ?? "other",
        rating: body.rating ?? "PG",
        visibility: body.visibility ?? "private",
        status: body.status ?? "draft",
        tags: body.tags ? serializeTagList(body.tags) : "",
        contentWarnings: body.contentWarnings ? serializeTagList(body.contentWarnings) : "",
        linkedWorldId: body.linkedWorldId ?? null,
        allowReviews: body.allowReviews ? 1 : 0,
        allowApplause: body.allowApplause === false ? 0 : 1,
      });
    } catch (e) {
      // The pre-check above can race with a concurrent create. The unique
      // index on (authorUserId, lower(slug)) is the real source of truth;
      // when it fires, return a friendly 409 instead of a 500.
      if (e instanceof Error && /UNIQUE|constraint/i.test(e.message)) {
        reply.code(409);
        return { error: "you already have a story with that slug" };
      }
      throw e;
    }
    const created = (await db.select().from(stories).where(eq(stories.id, id)).limit(1))[0]!;
    reply.code(201);
    return await toCard(db, created);
  });

  /* ---------- Read story (landing) ---------- */
  app.get<{ Params: { idOrSlug: string } }>("/stories/:idOrSlug", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const s = await resolveStory(db, req.params.idOrSlug, me?.id ?? null);
    if (!s) { reply.code(404); return { error: "not found" }; }
    const access = await viewerMayRead(s, me?.id ?? null, me?.role ?? null, db);
    if (!access.ok) {
      if ("stub" in access) return access.stub;
      reply.code(404);
      return { error: "not found" };
    }
    return await buildDetail(s, me ? { id: me.id, role: me.role } : null);
  });

  /* ---------- Canonical @handle/slug ---------- */
  app.get<{ Params: { handle: string; slug: string } }>(
    "/stories/@:handle/:slug",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      const s = await resolveStoryByHandle(db, req.params.handle, req.params.slug);
      if (!s) { reply.code(404); return { error: "not found" }; }
      const access = await viewerMayRead(s, me?.id ?? null, me?.role ?? null, db);
      if (!access.ok) {
        if ("stub" in access) return access.stub;
        reply.code(404);
        return { error: "not found" };
      }
      return await buildDetail(s, me ? { id: me.id, role: me.role } : null);
    },
  );

  /* ---------- Update story (author-only) ---------- */
  app.patch<{ Params: { id: string }; Body: unknown }>("/stories/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    if (s.authorUserId !== me.id && !isAdminRole(me.role)) {
      reply.code(403);
      return { error: "not yours" };
    }

    let body;
    try { body = updateStoryBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const update: Partial<typeof stories.$inferInsert> = { updatedAt: new Date() };
    if (body.title !== undefined) update.title = body.title.trim();
    if (body.summary !== undefined) update.summary = body.summary.trim();
    if (body.synopsisHtml !== undefined) update.synopsisHtml = sanitizeBio(body.synopsisHtml);
    if (body.authorCharacterId !== undefined) {
      const ok = await isOwnIdentity(db, s.authorUserId, body.authorCharacterId ?? null);
      if (!ok) { reply.code(400); return { error: "authorCharacterId is not one of your characters" }; }
      update.authorCharacterId = body.authorCharacterId ?? null;
    }
    if (body.theme !== undefined) {
      update.themeJson = body.theme === null ? null : JSON.stringify(normalizeTheme(body.theme));
    }
    if (body.genre !== undefined) update.genre = body.genre;
    if (body.rating !== undefined) update.rating = body.rating;
    if (body.visibility !== undefined) update.visibility = body.visibility;
    if (body.status !== undefined) update.status = body.status;
    if (body.tags !== undefined) update.tags = serializeTagList(body.tags);
    if (body.contentWarnings !== undefined) update.contentWarnings = serializeTagList(body.contentWarnings);
    if (body.linkedWorldId !== undefined) {
      if (body.linkedWorldId) {
        const w = (await db.select().from(worlds).where(eq(worlds.id, body.linkedWorldId)).limit(1))[0];
        if (!w || (w.visibility === "private" && w.ownerUserId !== me.id)) {
          reply.code(400);
          return { error: "linkedWorldId must reference a world you can see" };
        }
      }
      update.linkedWorldId = body.linkedWorldId ?? null;
    }
    if (body.coverImageUrl !== undefined) update.coverImageUrl = body.coverImageUrl ?? null;
    if (body.allowReviews !== undefined) update.allowReviews = body.allowReviews ? 1 : 0;
    if (body.allowApplause !== undefined) update.allowApplause = body.allowApplause ? 1 : 0;
    if (body.slug !== undefined) {
      const slug = body.slug.toLowerCase();
      if (!SLUG_RX.test(slug)) {
        reply.code(400);
        return { error: "slug must be 1-60 lowercase letters, numbers, hyphens" };
      }
      if (slug !== s.slug.toLowerCase()) {
        const dup = (await db
          .select()
          .from(stories)
          .where(and(eq(stories.authorUserId, s.authorUserId), sql`lower(${stories.slug}) = ${slug}`, ne(stories.id, s.id)))
          .limit(1))[0];
        if (dup) { reply.code(409); return { error: "you already have a story with that slug" }; }
        update.slug = slug;
      }
    }
    await db.update(stories).set(update).where(eq(stories.id, s.id));
    const updated = (await db.select().from(stories).where(eq(stories.id, s.id)).limit(1))[0]!;
    return await toCard(db, updated);
  });

  /* ---------- Delete story (author-only) ---------- */
  app.delete<{ Params: { id: string } }>("/stories/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    if (s.authorUserId !== me.id && !isAdminRole(me.role)) {
      reply.code(403);
      return { error: "not yours" };
    }
    await db.delete(stories).where(eq(stories.id, s.id));
    return { ok: true };
  });

  /* ===================================================== *
   *  Chapters
   * ===================================================== */

  app.post<{ Params: { id: string }; Body: unknown }>("/stories/:id/chapters", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    const perm = await effectiveStoryPermissions(db, s, me.id, me.role);
    if (!perm.addChapters) {
      reply.code(403);
      return { error: "you need co_author or owner access to add chapters" };
    }

    const countRow = (await db
      .select({ n: sql<number>`count(*)` })
      .from(storyChapters)
      .where(eq(storyChapters.storyId, s.id)))[0];
    if ((countRow?.n ?? 0) >= STORY_CHAPTER_CAP) {
      reply.code(409);
      return { error: `chapter cap (${STORY_CHAPTER_CAP}) reached` };
    }

    let body;
    try { body = createChapterBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const tail = (await db
      .select({ max: sql<number>`coalesce(max(${storyChapters.sortOrder}), -1)` })
      .from(storyChapters)
      .where(eq(storyChapters.storyId, s.id)))[0];
    const nextOrder = (tail?.max ?? -1) + 1;

    const id = nanoid();
    const bodyHtml = body.bodyHtml ? sanitizeBio(body.bodyHtml) : "";
    await db.insert(storyChapters).values({
      id,
      storyId: s.id,
      sortOrder: nextOrder,
      title: body.title?.trim() ?? `Chapter ${nextOrder + 1}`,
      bodyHtml,
      authorNotesHtml: body.authorNotesHtml ? sanitizeBio(body.authorNotesHtml) : "",
      contentWarnings: body.contentWarnings ? serializeTagList(body.contentWarnings) : "",
      wordCount: countWords(bodyHtml),
      status: "draft",
    });
    await recountStoryTotals(db, s.id);
    const created = (await db.select().from(storyChapters).where(eq(storyChapters.id, id)).limit(1))[0]!;
    reply.code(201);
    return chapterRowToFull(created);
  });

  app.get<{ Params: { id: string; chapterId: string } }>("/stories/:id/chapters/:chapterId", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    const access = await viewerMayRead(s, me?.id ?? null, me?.role ?? null, db);
    if (!access.ok) {
      if ("stub" in access) { reply.code(403); return access.stub; }
      reply.code(404);
      return { error: "not found" };
    }
    const c = (await db
      .select()
      .from(storyChapters)
      .where(and(eq(storyChapters.id, req.params.chapterId), eq(storyChapters.storyId, s.id)))
      .limit(1))[0];
    if (!c) { reply.code(404); return { error: "not found" }; }
    const isAuthor = !!me && me.id === s.authorUserId;
    const isAdmin = !!me && isAdminRole(me.role);
    // Collaborators with readDrafts (any active role) see drafts too.
    const perm = me ? await effectiveStoryPermissions(db, s, me.id, me.role) : null;
    const canSeeDrafts = isAuthor || isAdmin || (perm?.readDrafts ?? false);
    if (c.status !== "published" && !canSeeDrafts) {
      reply.code(404);
      return { error: "not found" };
    }
    const full = chapterRowToFull(c);
    if (canSeeDrafts) return full;
    // Belt-and-braces: chapters published before stripMarginNotes was
    // enforced at publish may still hold collaborator-side annotations.
    // Strip on read for any non-collaborator viewer, covering both the
    // body and the author's notes (which the publish path also strips).
    const safeBody = injectParagraphAnchors(stripMarginNotes(full.bodyHtml));
    const safeNotes = stripMarginNotes(full.authorNotesHtml);
    return { ...full, bodyHtml: safeBody, authorNotesHtml: safeNotes };
  });

  app.patch<{ Params: { id: string; chapterId: string }; Body: unknown }>(
    "/stories/:id/chapters/:chapterId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const perm = await effectiveStoryPermissions(db, s, me.id, me.role);
      if (!perm.editChapters) {
        reply.code(403);
        return { error: "you need editor or higher access to edit chapters" };
      }

      let body;
      try { body = updateChapterBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      // Pre-sanitize HTML outside the transaction — sanitize-html runs
      // a full parse and is the heaviest synchronous work on the path.
      // Keeping it outside means the write lock is held for the
      // minimum window (just the DB writes).
      const sanitizedBody = body.bodyHtml !== undefined ? sanitizeBio(body.bodyHtml) : undefined;
      const sanitizedNotes = body.authorNotesHtml !== undefined ? sanitizeBio(body.authorNotesHtml) : undefined;

      // Atomic write phase. Story status promotion, chapter UPDATE,
      // version append, and totals recount all commit or all roll back
      // together — a crash between any pair would otherwise leave the
      // story claiming "in_progress" with no actually-published
      // chapter, or a chapter saved with no corresponding version
      // history row.
      type TxResult =
        | { ok: true; updated: typeof storyChapters.$inferSelect; publishedNow: boolean }
        | { ok: false; status: number; error: string };

      const result: TxResult = db.transaction((tx): TxResult => {
        // Re-read story + chapter inside the tx for a fresh snapshot.
        // A concurrent admin PATCH on the story (e.g. visibility flip)
        // could have landed between our outer read and the write
        // phase; using the in-tx values avoids overwriting their edit.
        const sNow = tx.select().from(stories).where(eq(stories.id, s.id)).limit(1).all()[0];
        if (!sNow) return { ok: false, status: 404, error: "not found" };
        const c = tx.select().from(storyChapters)
          .where(and(eq(storyChapters.id, req.params.chapterId), eq(storyChapters.storyId, s.id)))
          .limit(1).all()[0];
        if (!c) return { ok: false, status: 404, error: "not found" };

        const update: Partial<typeof storyChapters.$inferInsert> = { updatedAt: new Date() };
        let nextBody = c.bodyHtml;
        let nextNotes = c.authorNotesHtml;
        let bodyChanged = false;
        if (body.title !== undefined) update.title = body.title.trim();
        if (sanitizedBody !== undefined) {
          nextBody = sanitizedBody;
          update.bodyHtml = nextBody;
          update.wordCount = countWords(nextBody);
          bodyChanged = nextBody !== c.bodyHtml;
        }
        if (sanitizedNotes !== undefined) {
          nextNotes = sanitizedNotes;
          update.authorNotesHtml = nextNotes;
          bodyChanged = bodyChanged || nextNotes !== c.authorNotesHtml;
        }
        if (body.contentWarnings !== undefined) {
          update.contentWarnings = serializeTagList(body.contentWarnings);
        }
        if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;

        const publishingNow = body.status === "published" && c.status !== "published";
        if (body.status !== undefined) {
          // Publishing is gated separately from editing — editors can
          // save changes but only co_authors / owners can flip the
          // chapter live.
          if (publishingNow && !perm.publish) {
            return { ok: false, status: 403, error: "you need co_author or owner access to publish a chapter" };
          }
          update.status = body.status;
          if (publishingNow) {
            update.publishedAt = new Date();
            // Strip margin notes on publish — collaborator-side
            // drafting annotations MUST NOT survive into the public
            // chapter. Both body and author's notes can carry them.
            const strippedBody = stripMarginNotes(nextBody);
            if (strippedBody !== nextBody) {
              nextBody = strippedBody;
              update.bodyHtml = nextBody;
              update.wordCount = countWords(nextBody);
              bodyChanged = true;
            }
            const strippedNotes = stripMarginNotes(nextNotes);
            if (strippedNotes !== nextNotes) {
              nextNotes = strippedNotes;
              update.authorNotesHtml = nextNotes;
              bodyChanged = true;
            }
            if (sNow.status === "draft") {
              tx.update(stories)
                .set({ status: "in_progress", publishedAt: sNow.publishedAt ?? new Date(), updatedAt: new Date() })
                .where(eq(stories.id, sNow.id)).run();
            } else {
              tx.update(stories)
                .set({ updatedAt: new Date() })
                .where(eq(stories.id, sNow.id)).run();
            }
          }
        }

        tx.update(storyChapters).set(update).where(eq(storyChapters.id, c.id)).run();

        if (bodyChanged) {
          const reason: "autosave" | "publish" | "manual" =
            publishingNow ? "publish"
            : body.reason === "manual" ? "manual"
            : "autosave";
          appendChapterVersionTx(tx, c.id, { bodyHtml: nextBody, authorNotesHtml: nextNotes }, reason, me.id);
        } else if (publishingNow) {
          appendChapterVersionTx(tx, c.id, { bodyHtml: nextBody, authorNotesHtml: nextNotes }, "publish", me.id);
        }

        recountStoryTotalsTx(tx, s.id);

        const updated = tx.select().from(storyChapters).where(eq(storyChapters.id, c.id)).limit(1).all()[0]!;
        return { ok: true, updated, publishedNow: publishingNow };
      });

      if (!result.ok) {
        reply.code(result.status);
        return { error: result.error };
      }

      // Publish event: fan out follower notifications + the author's
      // daily earning trickle. Both are fire-and-forget so a
      // notification / earning hiccup never blocks the publish itself.
      // Runs AFTER the transaction commits so a notify failure can't
      // roll back the actual publish (which is already durable).
      if (result.publishedNow) {
        void notifyPublish(db, io, s, result.updated, me.id).catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[scriptorium] notifyPublish failed", err);
        });
        void awardDailyPublishTrickle(db, io, me.id).catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[scriptorium] awardDailyPublishTrickle failed", err);
        });
      }

      return chapterRowToFull(result.updated);
    },
  );

  app.delete<{ Params: { id: string; chapterId: string } }>(
    "/stories/:id/chapters/:chapterId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const perm = await effectiveStoryPermissions(db, s, me.id, me.role);
      if (!perm.addChapters) {
        reply.code(403);
        return { error: "you need co_author or owner access to delete chapters" };
      }
      const c = (await db
        .select()
        .from(storyChapters)
        .where(and(eq(storyChapters.id, req.params.chapterId), eq(storyChapters.storyId, s.id)))
        .limit(1))[0];
      if (!c) { reply.code(404); return { error: "not found" }; }
      await db.delete(storyChapters).where(eq(storyChapters.id, c.id));
      await recountStoryTotals(db, s.id);
      return { ok: true };
    },
  );

  /* ---------- Reorder chapters (editor + above) ---------- */
  app.post<{ Params: { id: string }; Body: { order: string[] } }>(
    "/stories/:id/chapters/reorder",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const perm = await effectiveStoryPermissions(db, s, me.id, me.role);
      if (!perm.editChapters) {
        reply.code(403);
        return { error: "you need editor or higher access to reorder chapters" };
      }
      const order = Array.isArray(req.body?.order) ? req.body.order : null;
      if (!order) { reply.code(400); return { error: "order must be an array of chapter ids" }; }
      const rows = await db
        .select({ id: storyChapters.id })
        .from(storyChapters)
        .where(eq(storyChapters.storyId, s.id));
      const valid = new Set(rows.map((r) => r.id));
      for (const id of order) {
        if (!valid.has(id)) { reply.code(400); return { error: `unknown chapter id: ${id}` }; }
      }
      let idx = 0;
      for (const id of order) {
        await db
          .update(storyChapters)
          .set({ sortOrder: idx++, updatedAt: new Date() })
          .where(eq(storyChapters.id, id));
      }
      return { ok: true };
    },
  );

  /* ---------- Version history (editor + above) ---------- */
  app.get<{ Params: { id: string; chapterId: string } }>(
    "/stories/:id/chapters/:chapterId/versions",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const perm = await effectiveStoryPermissions(db, s, me.id, me.role);
      if (!perm.editChapters) {
        reply.code(403);
        return { error: "you need editor or higher access to view chapter history" };
      }
      const c = (await db
        .select()
        .from(storyChapters)
        .where(and(eq(storyChapters.id, req.params.chapterId), eq(storyChapters.storyId, s.id)))
        .limit(1))[0];
      if (!c) { reply.code(404); return { error: "not found" }; }
      const rows = await db
        .select()
        .from(storyChapterVersions)
        .where(eq(storyChapterVersions.chapterId, c.id))
        .orderBy(desc(storyChapterVersions.version))
        .limit(100);
      const versions: StoryChapterVersion[] = rows.map((r) => ({
        id: r.id,
        chapterId: r.chapterId,
        version: r.version,
        bodyHtml: r.bodyHtml,
        authorNotesHtml: r.authorNotesHtml,
        reason: r.reason as StoryChapterVersion["reason"],
        savedByUserId: r.savedByUserId ?? null,
        savedAt: +r.savedAt,
      }));
      return { versions };
    },
  );

  /* ===================================================== *
   *  Reading position
   * ===================================================== */

  app.put<{ Params: { id: string }; Body: unknown }>(
    "/stories/:id/reading-position",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const access = await viewerMayRead(s, me.id, me.role, db);
      if (!access.ok) { reply.code(403); return { error: "forbidden" }; }
      let body;
      try { body = upsertReadingPositionBody.parse(req.body ?? {}); }
      catch { reply.code(400); return { error: "invalid body" }; }

      // A reader can't pin a position to a chapter outside this story —
      // otherwise the client could spray cross-story chapter ids through
      // the column and leak existence.
      if (body.lastChapterId) {
        const c = (await db
          .select({ id: storyChapters.id })
          .from(storyChapters)
          .where(and(eq(storyChapters.id, body.lastChapterId), eq(storyChapters.storyId, s.id)))
          .limit(1))[0];
        if (!c) { reply.code(400); return { error: "chapter does not belong to this story" }; }
      }

      const existing = (await db
        .select()
        .from(storyReadingPositions)
        .where(and(
          eq(storyReadingPositions.storyId, s.id),
          eq(storyReadingPositions.userId, me.id),
        ))
        .limit(1))[0];

      const percentX10 = Math.round((body.percentThrough ?? 0) * 10);

      if (existing) {
        await db
          .update(storyReadingPositions)
          .set({
            lastChapterId: body.lastChapterId === undefined ? existing.lastChapterId : body.lastChapterId,
            lastAnchorId: body.lastAnchorId === undefined ? existing.lastAnchorId : body.lastAnchorId,
            percentThrough: body.percentThrough === undefined ? existing.percentThrough : percentX10,
            updatedAt: new Date(),
          })
          .where(and(
            eq(storyReadingPositions.storyId, s.id),
            eq(storyReadingPositions.userId, me.id),
          ));
      } else {
        await db.insert(storyReadingPositions).values({
          storyId: s.id,
          userId: me.id,
          lastChapterId: body.lastChapterId ?? null,
          lastAnchorId: body.lastAnchorId ?? null,
          percentThrough: percentX10,
        });
        // Atomic increment — read-modify-write would under-count under
        // concurrent first-reads from the same reader (rare) or, more
        // realistically, double-count when retried.
        await db
          .update(stories)
          .set({ readerCount: sql`${stories.readerCount} + 1` })
          .where(eq(stories.id, s.id));
      }
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string } }>("/stories/:id/reading-position", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    // Gate by visibility so that an authed user can't probe an arbitrary
    // story id for an existence signal even when they have no row.
    const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    const access = await viewerMayRead(s, me.id, me.role, db);
    if (!access.ok) { reply.code(403); return { error: "forbidden" }; }
    const rp = (await db
      .select()
      .from(storyReadingPositions)
      .where(and(
        eq(storyReadingPositions.storyId, s.id),
        eq(storyReadingPositions.userId, me.id),
      ))
      .limit(1))[0];
    if (!rp) return { position: null };
    const payload: StoryReadingPosition = {
      storyId: rp.storyId,
      lastChapterId: rp.lastChapterId ?? null,
      lastAnchorId: rp.lastAnchorId ?? null,
      percentThrough: Math.round((rp.percentThrough ?? 0) / 10),
      updatedAt: +rp.updatedAt,
    };
    return { position: payload };
  });

  /* ===================================================== *
   *  Applause (Phase 6)
   * ===================================================== */

  /**
   * Toggle applause for the caller on the given story (or specific
   * chapter when chapterId is in the body). Idempotent in both
   * directions: second call removes the row. Returns the post-toggle
   * total + viewer state.
   *
   * Author cannot see WHO applauded — only the rollup count.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/stories/:id/applause", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    if (!s.allowApplause) {
      reply.code(409);
      return { error: "author has applause disabled for this story" };
    }
    // Authors can't applaud their own work — mirrors the self-review
    // block and stops the rollup from being inflated by the creator.
    if (s.authorUserId === me.id) {
      reply.code(403);
      return { error: "you can't applaud your own story" };
    }
    const access = await viewerMayRead(s, me.id, me.role, db);
    if (!access.ok) { reply.code(403); return { error: "forbidden" }; }

    let body;
    try { body = applauseToggleBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const chapterId = body.chapterId ?? null;

    // Validate the chapter (if provided) belongs to this story.
    if (chapterId) {
      const c = (await db
        .select()
        .from(storyChapters)
        .where(and(eq(storyChapters.id, chapterId), eq(storyChapters.storyId, s.id)))
        .limit(1))[0];
      if (!c) { reply.code(400); return { error: "chapter does not belong to this story" }; }
    }

    // Drizzle composite-PK matching for chapter-null requires `IS NULL`,
    // not `= NULL`. Use a raw SQL fragment when the chapter slot is null
    // so the lookup returns the existing row.
    const chapterMatch = chapterId
      ? eq(storyApplause.chapterId, chapterId)
      : sql`${storyApplause.chapterId} IS NULL`;

    const existing = (await db
      .select()
      .from(storyApplause)
      .where(and(
        eq(storyApplause.storyId, s.id),
        chapterMatch,
        eq(storyApplause.userId, me.id),
      ))
      .limit(1))[0];

    let viewerApplauded: boolean;
    if (existing) {
      await db
        .delete(storyApplause)
        .where(and(
          eq(storyApplause.storyId, s.id),
          chapterMatch,
          eq(storyApplause.userId, me.id),
        ));
      viewerApplauded = false;
    } else {
      await db.insert(storyApplause).values({
        storyId: s.id,
        chapterId,
        userId: me.id,
      });
      viewerApplauded = true;
    }

    // Recount only matters at the story level (chapter applause is a
    // separate target and doesn't roll up into stories.applauseCount).
    if (!chapterId) {
      await recountStoryApplause(db, s.id);
    }

    const countRow = (await db
      .select({ n: sql<number>`count(*)` })
      .from(storyApplause)
      .where(and(eq(storyApplause.storyId, s.id), chapterMatch)))[0];
    const payload: StoryApplauseState = {
      count: countRow?.n ?? 0,
      viewerApplauded,
    };
    return payload;
  });

  /** Return whether the caller is currently applauding the story/chapter. */
  app.get<{ Params: { id: string }; Querystring: { chapterId?: string } }>(
    "/stories/:id/applause",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      // Mirrors the read gate on the rest of the story surface — otherwise
      // this endpoint leaks applauseCount + existence for private/unlisted.
      const access = await viewerMayRead(s, me?.id ?? null, me?.role ?? null, db);
      if (!access.ok) {
        if ("stub" in access) { reply.code(403); return access.stub; }
        reply.code(404);
        return { error: "not found" };
      }
      const chapterId = req.query.chapterId ?? null;
      const chapterMatch = chapterId
        ? eq(storyApplause.chapterId, chapterId)
        : sql`${storyApplause.chapterId} IS NULL`;

      const countRow = (await db
        .select({ n: sql<number>`count(*)` })
        .from(storyApplause)
        .where(and(eq(storyApplause.storyId, s.id), chapterMatch)))[0];

      let viewerApplauded = false;
      if (me) {
        const own = (await db
          .select({ userId: storyApplause.userId })
          .from(storyApplause)
          .where(and(
            eq(storyApplause.storyId, s.id),
            chapterMatch,
            eq(storyApplause.userId, me.id),
          ))
          .limit(1))[0];
        viewerApplauded = !!own;
      }
      const payload: StoryApplauseState = {
        count: countRow?.n ?? 0,
        viewerApplauded,
      };
      return payload;
    },
  );

  /* ===================================================== *
   *  Reviews (Phase 6)
   * ===================================================== */

  /**
   * Load reviews for a story. Pinned-by-author float to the top; the
   * rest sort newest-first. Hidden-by-author reviews are filtered out
   * for everyone except the author themselves and the reviewer who
   * authored them (same shape as `/ignore`).
   */
  app.get<{ Params: { id: string } }>("/stories/:id/reviews", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    const access = await viewerMayRead(s, me?.id ?? null, me?.role ?? null, db);
    if (!access.ok) {
      if ("stub" in access) { reply.code(403); return access.stub; }
      reply.code(404);
      return { error: "not found" };
    }

    const isAuthor = !!me && s.authorUserId === me.id;
    const isAdmin = !!me && isAdminRole(me.role);

    // Fetch all reviews, filter visibility in post since hidden-by-author
    // reviews stay visible to (a) the author, (b) the reviewer, (c) admins.
    const allReviews = await db
      .select()
      .from(storyReviews)
      .where(eq(storyReviews.storyId, s.id))
      .orderBy(desc(storyReviews.pinnedByAuthor), desc(storyReviews.createdAt));

    const visibleRows = allReviews.filter((r) => {
      if (!r.hiddenByAuthor) return true;
      if (isAuthor || isAdmin) return true;
      if (me && r.reviewerUserId === me.id) return true;
      return false;
    });

    // Hydrate reviewers + replies in parallel batches.
    const reviewIds = visibleRows.map((r) => r.id);
    const allReplies = reviewIds.length === 0
      ? []
      : await db
          .select()
          .from(storyReviewReplies)
          .where(sql`${storyReviewReplies.reviewId} IN (${sql.join(reviewIds.map((id) => sql`${id}`), sql`, `)})`)
          .orderBy(asc(storyReviewReplies.createdAt));
    const repliesByReview = new Map<string, typeof allReplies>();
    for (const rr of allReplies) {
      const arr = repliesByReview.get(rr.reviewId) ?? [];
      arr.push(rr);
      repliesByReview.set(rr.reviewId, arr);
    }

    const reviews: StoryReview[] = [];
    for (const row of visibleRows) {
      const reviewer = await loadReviewer(db, row.reviewerUserId, row.reviewerCharacterId ?? null);
      const replyRows = repliesByReview.get(row.id) ?? [];
      const replies = await Promise.all(replyRows.map(async (rr) => {
        const r = await loadReviewer(db, rr.replyerUserId, rr.replyerCharacterId ?? null);
        return replyRowToWire(rr, r);
      }));
      reviews.push(reviewRowToWire(row, reviewer, replies));
    }

    // Keep `total` aligned with what the viewer actually sees — the
    // stored rollup counts only public reviews, but author/admin/own
    // views surface hidden ones too. avgRating is recomputed from the
    // same visible set so the displayed stars don't disagree with the
    // displayed reviews.
    const total = visibleRows.length;
    const visibleSum = visibleRows.reduce((acc, r) => acc + (r.rating ?? 0), 0);
    const visibleRated = visibleRows.filter((r) => typeof r.rating === "number" && r.rating > 0);
    const avgRating = visibleRated.length > 0
      ? Math.round((visibleSum / visibleRated.length) * 100) / 100
      : null;
    const viewerHasReviewed = me
      ? allReviews.some((r) => r.reviewerUserId === me.id)
      : false;

    const payload: StoryReviewPage = {
      reviews,
      total,
      avgRating,
      viewerHasReviewed,
    };
    return payload;
  });

  /**
   * Create a review. Disallowed when:
   *   - the author has reviews turned off
   *   - the caller is the author (no self-reviews)
   *   - the caller already has a review under the same identity tuple
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/stories/:id/reviews", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    if (!s.allowReviews) {
      reply.code(409);
      return { error: "author has reviews disabled for this story" };
    }
    if (s.authorUserId === me.id) {
      reply.code(403);
      return { error: "you can't review your own story" };
    }
    const access = await viewerMayRead(s, me.id, me.role, db);
    if (!access.ok) { reply.code(403); return { error: "forbidden" }; }

    let body;
    try { body = createReviewBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    if (body.reviewerCharacterId !== undefined) {
      const ok = await isOwnIdentity(db, me.id, body.reviewerCharacterId ?? null);
      if (!ok) { reply.code(400); return { error: "reviewerCharacterId is not one of your characters" }; }
    }

    // One review per (story, reviewer identity).
    const characterId = body.reviewerCharacterId ?? null;
    const dup = (await db
      .select()
      .from(storyReviews)
      .where(and(
        eq(storyReviews.storyId, s.id),
        eq(storyReviews.reviewerUserId, me.id),
        characterId
          ? eq(storyReviews.reviewerCharacterId, characterId)
          : sql`${storyReviews.reviewerCharacterId} IS NULL`,
      ))
      .limit(1))[0];
    if (dup) { reply.code(409); return { error: "you've already reviewed this story under this identity" }; }

    const id = nanoid();
    const bodyHtml = body.bodyHtml ? sanitizeBio(body.bodyHtml) : "";
    const editGrace = new Date(Date.now() + STORY_REVIEW_EDIT_GRACE_MS);
    await db.insert(storyReviews).values({
      id,
      storyId: s.id,
      reviewerUserId: me.id,
      reviewerCharacterId: characterId,
      rating: body.rating,
      bodyHtml,
      editGraceExpiresAt: editGrace,
    });
    await recountStoryReviews(db, s.id);
    const created = (await db.select().from(storyReviews).where(eq(storyReviews.id, id)).limit(1))[0]!;
    const reviewer = await loadReviewer(db, created.reviewerUserId, created.reviewerCharacterId ?? null);
    reply.code(201);
    return reviewRowToWire(created, reviewer, []);
  });

  /**
   * Edit your own review during the 60-second grace window. After
   * grace, returns 409 — the wire is honest: this isn't a quiet no-op.
   */
  app.patch<{ Params: { id: string; rid: string }; Body: unknown }>(
    "/stories/:id/reviews/:rid",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const r = (await db
        .select()
        .from(storyReviews)
        .where(and(eq(storyReviews.id, req.params.rid), eq(storyReviews.storyId, s.id)))
        .limit(1))[0];
      if (!r) { reply.code(404); return { error: "not found" }; }
      if (r.reviewerUserId !== me.id && !isAdminRole(me.role)) {
        reply.code(403);
        return { error: "not yours" };
      }
      if (!isAdminRole(me.role)) {
        const graceMs = r.editGraceExpiresAt ? +r.editGraceExpiresAt : 0;
        if (Date.now() > graceMs) {
          reply.code(409);
          return { error: "edit grace expired" };
        }
      }
      let body;
      try { body = updateReviewBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const update: Partial<typeof storyReviews.$inferInsert> = { updatedAt: new Date() };
      if (body.rating !== undefined) update.rating = body.rating;
      if (body.bodyHtml !== undefined) update.bodyHtml = sanitizeBio(body.bodyHtml);
      await db.update(storyReviews).set(update).where(eq(storyReviews.id, r.id));
      await recountStoryReviews(db, s.id);
      const updated = (await db.select().from(storyReviews).where(eq(storyReviews.id, r.id)).limit(1))[0]!;
      const reviewer = await loadReviewer(db, updated.reviewerUserId, updated.reviewerCharacterId ?? null);
      // Reload replies so the wire shape stays consistent with GET.
      const replyRows = await db
        .select()
        .from(storyReviewReplies)
        .where(eq(storyReviewReplies.reviewId, r.id))
        .orderBy(asc(storyReviewReplies.createdAt));
      const replies = await Promise.all(replyRows.map(async (rr) => {
        const u = await loadReviewer(db, rr.replyerUserId, rr.replyerCharacterId ?? null);
        return replyRowToWire(rr, u);
      }));
      return reviewRowToWire(updated, reviewer, replies);
    },
  );

  /**
   * Delete your own review (any time) OR an admin force-deletes for
   * moderation. The story's reviewer_count + avg get recomputed.
   */
  app.delete<{ Params: { id: string; rid: string } }>("/stories/:id/reviews/:rid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    const r = (await db
      .select()
      .from(storyReviews)
      .where(and(eq(storyReviews.id, req.params.rid), eq(storyReviews.storyId, s.id)))
      .limit(1))[0];
    if (!r) { reply.code(404); return { error: "not found" }; }
    if (r.reviewerUserId !== me.id && !isAdminRole(me.role)) {
      reply.code(403);
      return { error: "not yours" };
    }
    await db.delete(storyReviews).where(eq(storyReviews.id, r.id));
    await recountStoryReviews(db, s.id);
    return { ok: true };
  });

  /**
   * Author moderation: pin or hide a review on their story. Reviewer
   * still sees their hidden review (same shape as `/ignore`).
   */
  app.patch<{ Params: { id: string; rid: string }; Body: unknown }>(
    "/stories/:id/reviews/:rid/moderate",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      if (s.authorUserId !== me.id && !isAdminRole(me.role)) {
        reply.code(403);
        return { error: "only the story author or an admin can moderate reviews" };
      }
      const r = (await db
        .select()
        .from(storyReviews)
        .where(and(eq(storyReviews.id, req.params.rid), eq(storyReviews.storyId, s.id)))
        .limit(1))[0];
      if (!r) { reply.code(404); return { error: "not found" }; }
      let body;
      try { body = moderateReviewBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const update: Partial<typeof storyReviews.$inferInsert> = { updatedAt: new Date() };
      if (body.pinnedByAuthor !== undefined) {
        update.pinnedByAuthor = body.pinnedByAuthor ? 1 : 0;
        // Only one pinned review per story — clear any previous pin.
        if (body.pinnedByAuthor) {
          await db
            .update(storyReviews)
            .set({ pinnedByAuthor: 0, updatedAt: new Date() })
            .where(and(eq(storyReviews.storyId, s.id), ne(storyReviews.id, r.id), eq(storyReviews.pinnedByAuthor, 1)));
        }
      }
      if (body.hiddenByAuthor !== undefined) update.hiddenByAuthor = body.hiddenByAuthor ? 1 : 0;
      await db.update(storyReviews).set(update).where(eq(storyReviews.id, r.id));
      // Hidden state affects review_count + avg; recompute either way to be safe.
      await recountStoryReviews(db, s.id);
      return { ok: true };
    },
  );

  /**
   * Reply to a review. The chain is one level deep — replies to
   * replies aren't supported (matches the spec). The story author
   * replying is a common case; we don't gate by "are you the author"
   * here since any reader can leave a reply.
   */
  app.post<{ Params: { id: string; rid: string }; Body: unknown }>(
    "/stories/:id/reviews/:rid/replies",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      if (!s.allowReviews) {
        reply.code(409);
        return { error: "author has reviews disabled for this story" };
      }
      const r = (await db
        .select()
        .from(storyReviews)
        .where(and(eq(storyReviews.id, req.params.rid), eq(storyReviews.storyId, s.id)))
        .limit(1))[0];
      if (!r) { reply.code(404); return { error: "not found" }; }
      const access = await viewerMayRead(s, me.id, me.role, db);
      if (!access.ok) { reply.code(403); return { error: "forbidden" }; }

      let body;
      try { body = createReplyBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      if (body.replyerCharacterId !== undefined) {
        const ok = await isOwnIdentity(db, me.id, body.replyerCharacterId ?? null);
        if (!ok) { reply.code(400); return { error: "replyerCharacterId is not one of your characters" }; }
      }

      const id = nanoid();
      await db.insert(storyReviewReplies).values({
        id,
        reviewId: r.id,
        replyerUserId: me.id,
        replyerCharacterId: body.replyerCharacterId ?? null,
        bodyHtml: sanitizeBio(body.bodyHtml),
      });
      const created = (await db
        .select()
        .from(storyReviewReplies)
        .where(eq(storyReviewReplies.id, id))
        .limit(1))[0]!;
      const replyer = await loadReviewer(db, created.replyerUserId, created.replyerCharacterId ?? null);
      reply.code(201);
      return replyRowToWire(created, replyer);
    },
  );

  /** Delete your own reply (or admin force-delete). */
  app.delete<{ Params: { id: string; rid: string; replyId: string } }>(
    "/stories/:id/reviews/:rid/replies/:replyId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const r = (await db
        .select()
        .from(storyReviewReplies)
        .where(eq(storyReviewReplies.id, req.params.replyId))
        .limit(1))[0];
      if (!r || r.reviewId !== req.params.rid) {
        reply.code(404);
        return { error: "not found" };
      }
      if (r.replyerUserId !== me.id && !isAdminRole(me.role)) {
        reply.code(403);
        return { error: "not yours" };
      }
      await db.delete(storyReviewReplies).where(eq(storyReviewReplies.id, r.id));
      return { ok: true };
    },
  );

  /* ===================================================== *
   *  Subscriptions (Phase 7)
   * ===================================================== */

  /**
   * Toggle follow on a story. POST is idempotent in both directions —
   * second call removes the row. Optional `pushEnabled` in the body
   * lets the same call opt into web-push at follow time; otherwise
   * use PATCH below to flip it later without un-following.
   */
  app.post<{ Params: { id: string }; Body: { pushEnabled?: boolean } }>(
    "/stories/:id/follow",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const access = await viewerMayRead(s, me.id, me.role, db);
      if (!access.ok) { reply.code(403); return { error: "forbidden" }; }

      const existing = (await db
        .select()
        .from(storySubscriptions)
        .where(and(eq(storySubscriptions.storyId, s.id), eq(storySubscriptions.userId, me.id)))
        .limit(1))[0];

      let subscribed: boolean;
      let pushEnabled: boolean;
      if (existing) {
        await db
          .delete(storySubscriptions)
          .where(and(eq(storySubscriptions.storyId, s.id), eq(storySubscriptions.userId, me.id)));
        subscribed = false;
        pushEnabled = false;
      } else {
        await db.insert(storySubscriptions).values({
          storyId: s.id,
          userId: me.id,
          pushEnabled: req.body?.pushEnabled ? 1 : 0,
        });
        subscribed = true;
        pushEnabled = !!req.body?.pushEnabled;
      }

      const countRow = (await db
        .select({ n: sql<number>`count(*)` })
        .from(storySubscriptions)
        .where(eq(storySubscriptions.storyId, s.id)))[0];
      const payload: StorySubscriptionState = {
        storyId: s.id,
        subscribed,
        pushEnabled,
        subscriberCount: countRow?.n ?? 0,
      };
      return payload;
    },
  );

  /**
   * Flip push opt-in on an existing subscription without unfollowing.
   * Returns 404 if not subscribed (caller should POST /follow first).
   */
  app.patch<{ Params: { id: string }; Body: { pushEnabled: boolean } }>(
    "/stories/:id/follow",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      // A reader who lost access to a story (visibility flipped to
      // private after they subscribed) shouldn't be able to flap push
      // settings any further — same gate the POST already enforces.
      const access = await viewerMayRead(s, me.id, me.role, db);
      if (!access.ok) { reply.code(403); return { error: "forbidden" }; }
      const existing = (await db
        .select()
        .from(storySubscriptions)
        .where(and(eq(storySubscriptions.storyId, s.id), eq(storySubscriptions.userId, me.id)))
        .limit(1))[0];
      if (!existing) { reply.code(404); return { error: "not subscribed" }; }
      if (typeof req.body?.pushEnabled !== "boolean") {
        reply.code(400);
        return { error: "pushEnabled must be a boolean" };
      }
      await db
        .update(storySubscriptions)
        .set({ pushEnabled: req.body.pushEnabled ? 1 : 0 })
        .where(and(eq(storySubscriptions.storyId, s.id), eq(storySubscriptions.userId, me.id)));
      const countRow = (await db
        .select({ n: sql<number>`count(*)` })
        .from(storySubscriptions)
        .where(eq(storySubscriptions.storyId, s.id)))[0];
      const payload: StorySubscriptionState = {
        storyId: s.id,
        subscribed: true,
        pushEnabled: req.body.pushEnabled,
        subscriberCount: countRow?.n ?? 0,
      };
      return payload;
    },
  );

  /** Return the caller's current subscription state for a story. */
  app.get<{ Params: { id: string } }>("/stories/:id/follow", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    const access = await viewerMayRead(s, me?.id ?? null, me?.role ?? null, db);
    if (!access.ok) {
      if ("stub" in access) { reply.code(403); return access.stub; }
      reply.code(404);
      return { error: "not found" };
    }
    const countRow = (await db
      .select({ n: sql<number>`count(*)` })
      .from(storySubscriptions)
      .where(eq(storySubscriptions.storyId, s.id)))[0];
    let subscribed = false;
    let pushEnabled = false;
    if (me) {
      const own = (await db
        .select()
        .from(storySubscriptions)
        .where(and(eq(storySubscriptions.storyId, s.id), eq(storySubscriptions.userId, me.id)))
        .limit(1))[0];
      if (own) {
        subscribed = true;
        pushEnabled = !!own.pushEnabled;
      }
    }
    const payload: StorySubscriptionState = {
      storyId: s.id,
      subscribed,
      pushEnabled,
      subscriberCount: countRow?.n ?? 0,
    };
    return payload;
  });

  /** List the caller's followed stories (Following tab in the catalog). */
  /* ===================================================== *
   *  Codex (Phase 8)
   *
   *  Per-story characters / locations / plot points. Author-only by
   *  default; entities marked `isPublic` surface in the reader's
   *  "Cast & places" appendix.
   * ===================================================== */

  /**
   * List the story's codex. The author/admin sees all entities;
   * everyone else gets only the public ones. We always return the
   * complete row payload (the entity bodies are small).
   */
  app.get<{ Params: { id: string } }>("/stories/:id/codex", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    const access = await viewerMayRead(s, me?.id ?? null, me?.role ?? null, db);
    if (!access.ok) {
      if ("stub" in access) { reply.code(403); return access.stub; }
      reply.code(404);
      return { error: "not found" };
    }
    const isAuthor = !!me && me.id === s.authorUserId;
    const isAdmin = !!me && isAdminRole(me.role);
    const rows = await db
      .select()
      .from(storyEntities)
      .where(eq(storyEntities.storyId, s.id))
      .orderBy(asc(storyEntities.kind), asc(storyEntities.sortOrder), asc(storyEntities.createdAt));
    const visible = isAuthor || isAdmin
      ? rows
      : rows.filter((r) => r.isPublic);
    const entities: StoryEntity[] = visible.map((row) => entityRowToWire(row));
    return { entities };
  });

  /** Create a codex entity (author-only). */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/stories/:id/codex",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const perm = await effectiveStoryPermissions(db, s, me.id, me.role);
      if (!perm.manageCodex) {
        reply.code(403);
        return { error: "you need editor or higher access to manage the codex" };
      }
      let body;
      try { body = createEntityBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      // Per-kind cap so a codex doesn't grow unboundedly.
      const countRow = (await db
        .select({ n: sql<number>`count(*)` })
        .from(storyEntities)
        .where(and(eq(storyEntities.storyId, s.id), eq(storyEntities.kind, body.kind))))[0];
      if ((countRow?.n ?? 0) >= STORY_ENTITY_PER_KIND_CAP) {
        reply.code(409);
        return { error: `cap of ${STORY_ENTITY_PER_KIND_CAP} ${body.kind} entries reached for this story` };
      }

      const slug = (body.slug ?? deriveStorySlug(body.name)).toLowerCase();
      if (!SLUG_RX.test(slug)) {
        reply.code(400);
        return { error: "slug must be 1-60 lowercase letters, numbers, hyphens" };
      }
      const dup = (await db
        .select()
        .from(storyEntities)
        .where(and(
          eq(storyEntities.storyId, s.id),
          eq(storyEntities.kind, body.kind),
          sql`lower(${storyEntities.slug}) = ${slug}`,
        ))
        .limit(1))[0];
      if (dup) { reply.code(409); return { error: `this story already has a ${body.kind} with that slug` }; }

      // Sort_order = append at the end within this kind.
      const tail = (await db
        .select({ max: sql<number>`coalesce(max(${storyEntities.sortOrder}), -1)` })
        .from(storyEntities)
        .where(and(eq(storyEntities.storyId, s.id), eq(storyEntities.kind, body.kind))))[0];
      const nextOrder = (tail?.max ?? -1) + 1;

      const id = nanoid();
      await db.insert(storyEntities).values({
        id,
        storyId: s.id,
        kind: body.kind,
        slug,
        name: body.name.trim(),
        summary: body.summary?.trim() ?? "",
        bodyHtml: body.bodyHtml ? sanitizeBio(body.bodyHtml) : "",
        statsJson: JSON.stringify(body.stats ?? {}),
        imageUrl: body.imageUrl ?? null,
        isPublic: body.isPublic ? 1 : 0,
        sortOrder: nextOrder,
      });
      const created = (await db.select().from(storyEntities).where(eq(storyEntities.id, id)).limit(1))[0]!;
      reply.code(201);
      return entityRowToWire(created);
    },
  );

  /** Update a codex entity (editor + above). */
  app.patch<{ Params: { id: string; eid: string }; Body: unknown }>(
    "/stories/:id/codex/:eid",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const perm = await effectiveStoryPermissions(db, s, me.id, me.role);
      if (!perm.manageCodex) {
        reply.code(403);
        return { error: "you need editor or higher access to manage the codex" };
      }
      const e = (await db
        .select()
        .from(storyEntities)
        .where(and(eq(storyEntities.id, req.params.eid), eq(storyEntities.storyId, s.id)))
        .limit(1))[0];
      if (!e) { reply.code(404); return { error: "not found" }; }

      let body;
      try { body = updateEntityBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const update: Partial<typeof storyEntities.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) update.name = body.name.trim();
      if (body.summary !== undefined) update.summary = body.summary.trim();
      if (body.bodyHtml !== undefined) update.bodyHtml = sanitizeBio(body.bodyHtml);
      if (body.stats !== undefined) update.statsJson = JSON.stringify(body.stats);
      if (body.imageUrl !== undefined) update.imageUrl = body.imageUrl ?? null;
      if (body.isPublic !== undefined) update.isPublic = body.isPublic ? 1 : 0;
      if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
      if (body.slug !== undefined) {
        const slug = body.slug.toLowerCase();
        if (!SLUG_RX.test(slug)) {
          reply.code(400);
          return { error: "slug must be 1-60 lowercase letters, numbers, hyphens" };
        }
        if (slug !== e.slug.toLowerCase()) {
          const dup = (await db
            .select()
            .from(storyEntities)
            .where(and(
              eq(storyEntities.storyId, s.id),
              eq(storyEntities.kind, e.kind),
              sql`lower(${storyEntities.slug}) = ${slug}`,
              ne(storyEntities.id, e.id),
            ))
            .limit(1))[0];
          if (dup) { reply.code(409); return { error: `this story already has a ${e.kind} with that slug` }; }
          update.slug = slug;
        }
      }
      await db.update(storyEntities).set(update).where(eq(storyEntities.id, e.id));
      const updated = (await db.select().from(storyEntities).where(eq(storyEntities.id, e.id)).limit(1))[0]!;
      return entityRowToWire(updated);
    },
  );

  /** Delete a codex entity (editor + above). */
  app.delete<{ Params: { id: string; eid: string } }>(
    "/stories/:id/codex/:eid",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const perm = await effectiveStoryPermissions(db, s, me.id, me.role);
      if (!perm.manageCodex) {
        reply.code(403);
        return { error: "you need editor or higher access to manage the codex" };
      }
      const e = (await db
        .select()
        .from(storyEntities)
        .where(and(eq(storyEntities.id, req.params.eid), eq(storyEntities.storyId, s.id)))
        .limit(1))[0];
      if (!e) { reply.code(404); return { error: "not found" }; }
      await db.delete(storyEntities).where(eq(storyEntities.id, e.id));
      return { ok: true };
    },
  );

  /* ===================================================== *
   *  Collaboration (Phase 5)
   *
   *  Invite-based co-authoring. Owner = `stories.authorUserId`;
   *  collaborators live in `storyCollaborators` with role + pending
   *  flag (acceptedAt). Permissions are resolved by
   *  effectiveStoryPermissions() above and gate every mutation route.
   * ===================================================== */

  /** List collaborators on a story. Public for the owner / admin /
   *  any active collaborator; 403 for everyone else. */
  app.get<{ Params: { id: string } }>("/stories/:id/collaborators", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    const perm = await effectiveStoryPermissions(db, s, me.id, me.role);
    if (!perm.readDrafts && s.authorUserId !== me.id && !isAdminRole(me.role)) {
      reply.code(403);
      return { error: "forbidden" };
    }
    const rows = await db
      .select({
        c: storyCollaborators,
        u: users,
      })
      .from(storyCollaborators)
      .innerJoin(users, eq(users.id, storyCollaborators.userId))
      .where(eq(storyCollaborators.storyId, s.id))
      .orderBy(asc(storyCollaborators.invitedAt));

    // Resolve inviter usernames in one extra query.
    const inviterIds = Array.from(new Set(
      rows.map((r) => r.c.invitedByUserId).filter((id): id is string => !!id),
    ));
    const inviters = inviterIds.length
      ? await db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(sql`${users.id} IN (${sql.join(inviterIds.map((id) => sql`${id}`), sql`, `)})`)
      : [];
    const inviterById = new Map(inviters.map((i) => [i.id, i.username]));

    const collaborators: StoryCollaborator[] = rows.map((r) => ({
      storyId: r.c.storyId,
      userId: r.c.userId,
      username: r.u.username,
      avatarUrl: r.u.avatarUrl ?? null,
      role: r.c.role as StoryCollaboratorRole,
      invitedByUsername: r.c.invitedByUserId ? (inviterById.get(r.c.invitedByUserId) ?? null) : null,
      invitedAt: +r.c.invitedAt,
      acceptedAt: r.c.acceptedAt ? +r.c.acceptedAt : null,
    }));
    return { collaborators };
  });

  /** Invite a collaborator by master username. Owner only (admin acts as owner). */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/stories/:id/collaborators",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const perm = await effectiveStoryPermissions(db, s, me.id, me.role);
      if (!perm.manageCollaborators) {
        reply.code(403);
        return { error: "only the story owner can invite collaborators" };
      }
      const schema = z.object({
        username: z.string().min(1).max(40),
        role: z.enum(STORY_COLLABORATOR_ROLES as unknown as [string, ...string[]]),
      }).strict();
      let body;
      try { body = schema.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      // Resolve the recipient by master username (case-insensitive).
      const recipient = (await db
        .select()
        .from(users)
        .where(sql`lower(${users.username}) = ${body.username.toLowerCase()}`)
        .limit(1))[0];
      if (!recipient) { reply.code(404); return { error: "no user with that username" }; }
      if (recipient.id === s.authorUserId) {
        reply.code(409);
        return { error: "the owner can't be a collaborator on their own story" };
      }

      // Existing row → update role (silently re-invite if previously declined +
      // GC'd, or upgrade role). Otherwise insert pending.
      const existing = (await db
        .select()
        .from(storyCollaborators)
        .where(and(
          eq(storyCollaborators.storyId, s.id),
          eq(storyCollaborators.userId, recipient.id),
        ))
        .limit(1))[0];
      if (existing) {
        // If already accepted, this is a role change rather than a new invite.
        await db
          .update(storyCollaborators)
          .set({
            role: body.role as StoryCollaboratorRole,
            invitedByUserId: me.id,
            // Don't reset acceptedAt — an active collaborator's role
            // change is immediate; a pending invite stays pending.
          })
          .where(and(
            eq(storyCollaborators.storyId, s.id),
            eq(storyCollaborators.userId, recipient.id),
          ));
        return { ok: true, status: existing.acceptedAt ? "role_changed" : "pending" };
      }

      await db.insert(storyCollaborators).values({
        storyId: s.id,
        userId: recipient.id,
        role: body.role as StoryCollaboratorRole,
        invitedByUserId: me.id,
      });
      // Fire-and-forget invite-card prompt across every live socket
      // the recipient has open. Multiple tabs each see it; whichever
      // acts first wins (the others' cards no-op once the row state
      // changes).
      void emitStoryInvite(io, recipient.id, {
        storyId: s.id,
        storyTitle: s.title,
        storySlug: s.slug,
        storyAuthorUsername: (await db
          .select({ u: users.username })
          .from(users)
          .where(eq(users.id, s.authorUserId))
          .limit(1))[0]?.u ?? "(unknown)",
        role: body.role as StoryCollaboratorRole,
        invitedByUsername: me.username,
        invitedAt: Date.now(),
      }).catch(() => { /* swallow; the invite row still exists */ });
      reply.code(201);
      return { ok: true, status: "invited" };
    },
  );

  /** Change a collaborator's role. Owner-only (admin acts as owner). */
  app.patch<{ Params: { id: string; uid: string }; Body: unknown }>(
    "/stories/:id/collaborators/:uid",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const perm = await effectiveStoryPermissions(db, s, me.id, me.role);
      if (!perm.manageCollaborators) {
        reply.code(403);
        return { error: "only the story owner can change collaborator roles" };
      }
      const schema = z.object({
        role: z.enum(STORY_COLLABORATOR_ROLES as unknown as [string, ...string[]]),
      }).strict();
      let body;
      try { body = schema.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const row = (await db
        .select()
        .from(storyCollaborators)
        .where(and(
          eq(storyCollaborators.storyId, s.id),
          eq(storyCollaborators.userId, req.params.uid),
        ))
        .limit(1))[0];
      if (!row) { reply.code(404); return { error: "not a collaborator" }; }
      await db
        .update(storyCollaborators)
        .set({ role: body.role as StoryCollaboratorRole })
        .where(and(
          eq(storyCollaborators.storyId, s.id),
          eq(storyCollaborators.userId, req.params.uid),
        ));
      return { ok: true };
    },
  );

  /** Remove a collaborator. Either the owner kicks them, or the
   *  collaborator removes themselves. */
  app.delete<{ Params: { id: string; uid: string } }>(
    "/stories/:id/collaborators/:uid",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const perm = await effectiveStoryPermissions(db, s, me.id, me.role);
      // Owner / admin can remove anyone; a collaborator can remove themselves.
      if (!perm.manageCollaborators && req.params.uid !== me.id) {
        reply.code(403);
        return { error: "you can only remove yourself unless you're the owner" };
      }
      await db
        .delete(storyCollaborators)
        .where(and(
          eq(storyCollaborators.storyId, s.id),
          eq(storyCollaborators.userId, req.params.uid),
        ));
      return { ok: true };
    },
  );

  /** Recipient accepts a pending invite. */
  app.post<{ Params: { id: string } }>("/me/story-invites/:id/accept", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const row = (await db
      .select()
      .from(storyCollaborators)
      .where(and(
        eq(storyCollaborators.storyId, req.params.id),
        eq(storyCollaborators.userId, me.id),
      ))
      .limit(1))[0];
    if (!row) { reply.code(404); return { error: "no pending invite" }; }
    if (row.acceptedAt) {
      // Idempotent — already accepted, return ok.
      return { ok: true };
    }
    await db
      .update(storyCollaborators)
      .set({ acceptedAt: new Date() })
      .where(and(
        eq(storyCollaborators.storyId, req.params.id),
        eq(storyCollaborators.userId, me.id),
      ));
    return { ok: true };
  });

  /** Recipient declines a pending invite. Deletes the row. */
  app.post<{ Params: { id: string } }>("/me/story-invites/:id/decline", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const row = (await db
      .select()
      .from(storyCollaborators)
      .where(and(
        eq(storyCollaborators.storyId, req.params.id),
        eq(storyCollaborators.userId, me.id),
      ))
      .limit(1))[0];
    if (!row) { reply.code(404); return { error: "no pending invite" }; }
    // Already-accepted rows can also be declined here — that's just
    // "leave this collaboration" via the invites surface, equivalent
    // to DELETE /stories/:id/collaborators/:me.id. Symmetry is nice.
    await db
      .delete(storyCollaborators)
      .where(and(
        eq(storyCollaborators.storyId, req.params.id),
        eq(storyCollaborators.userId, me.id),
      ));
    return { ok: true };
  });

  /** List the caller's pending collaboration invites (drives the
   *  My Stories pending-invites surface). */
  app.get("/me/story-invites", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const rows = await db
      .select({
        c: storyCollaborators,
        story: stories,
        author: users,
      })
      .from(storyCollaborators)
      .innerJoin(stories, eq(stories.id, storyCollaborators.storyId))
      .innerJoin(users, eq(users.id, stories.authorUserId))
      .where(and(
        eq(storyCollaborators.userId, me.id),
        sql`${storyCollaborators.acceptedAt} IS NULL`,
      ))
      .orderBy(desc(storyCollaborators.invitedAt))
      .limit(50);

    const inviterIds = Array.from(new Set(
      rows.map((r) => r.c.invitedByUserId).filter((id): id is string => !!id),
    ));
    const inviters = inviterIds.length
      ? await db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(sql`${users.id} IN (${sql.join(inviterIds.map((id) => sql`${id}`), sql`, `)})`)
      : [];
    const inviterById = new Map(inviters.map((i) => [i.id, i.username]));

    const invites: StoryCollaboratorInvite[] = rows.map((r) => ({
      storyId: r.story.id,
      storyTitle: r.story.title,
      storySlug: r.story.slug,
      storyAuthorUsername: r.author.username,
      role: r.c.role as StoryCollaboratorRole,
      invitedByUsername: r.c.invitedByUserId ? (inviterById.get(r.c.invitedByUserId) ?? null) : null,
      invitedAt: +r.c.invitedAt,
    }));
    return { invites };
  });

  /* ===================================================== *
   *  Chapter soft-lock (Phase 5)
   *
   *  Advisory — "force edit" still saves; the lock just surfaces a
   *  banner. Lease is STORY_CHAPTER_LOCK_LEASE_MS since last refresh;
   *  the client heartbeats every STORY_CHAPTER_LOCK_HEARTBEAT_MS.
   * ===================================================== */

  /**
   * Acquire or refresh the soft-lock on a chapter. Idempotent for the
   * holder (refreshes the lease); takes over from an expired holder
   * lazily. Returns the lock state so the client can render the
   * read-only banner when someone else holds it.
   */
  app.post<{ Params: { id: string; chapterId: string } }>(
    "/stories/:id/chapters/:chapterId/lock",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const perm = await effectiveStoryPermissions(db, s, me.id, me.role);
      if (!perm.editChapters) {
        reply.code(403);
        return { error: "you need editor or higher access to acquire a chapter lock" };
      }
      const c = (await db
        .select()
        .from(storyChapters)
        .where(and(eq(storyChapters.id, req.params.chapterId), eq(storyChapters.storyId, s.id)))
        .limit(1))[0];
      if (!c) { reply.code(404); return { error: "not found" }; }

      const now = Date.now();
      const existing = (await db
        .select()
        .from(storyChapterLocks)
        .where(eq(storyChapterLocks.chapterId, c.id))
        .limit(1))[0];

      if (existing) {
        const expired = +existing.lastRefreshAt + STORY_CHAPTER_LOCK_LEASE_MS < now;
        if (existing.userId === me.id) {
          // Caller's own lock — refresh the lease.
          await db
            .update(storyChapterLocks)
            .set({ lastRefreshAt: new Date() })
            .where(eq(storyChapterLocks.chapterId, c.id));
        } else if (expired) {
          // Stale holder — take over.
          await db
            .update(storyChapterLocks)
            .set({ userId: me.id, acquiredAt: new Date(), lastRefreshAt: new Date() })
            .where(eq(storyChapterLocks.chapterId, c.id));
        } else {
          // Active foreign holder — return their state without acquiring.
          const holder = await loadLockHolder(db, existing.userId);
          const payload: StoryChapterLockState = {
            chapterId: c.id,
            heldByMe: false,
            holder,
            expiresAt: +existing.lastRefreshAt + STORY_CHAPTER_LOCK_LEASE_MS,
            currentUpdatedAt: +c.updatedAt,
          };
          return payload;
        }
      } else {
        await db.insert(storyChapterLocks).values({
          chapterId: c.id,
          userId: me.id,
        });
      }

      const fresh = (await db
        .select()
        .from(storyChapterLocks)
        .where(eq(storyChapterLocks.chapterId, c.id))
        .limit(1))[0]!;
      const payload: StoryChapterLockState = {
        chapterId: c.id,
        heldByMe: true,
        holder: null,
        expiresAt: +fresh.lastRefreshAt + STORY_CHAPTER_LOCK_LEASE_MS,
        currentUpdatedAt: +c.updatedAt,
      };
      return payload;
    },
  );

  /**
   * Release a lock the caller owns. No-op if the caller isn't the
   * holder (foreign locks aren't releasable from this endpoint —
   * they expire naturally).
   */
  app.delete<{ Params: { id: string; chapterId: string } }>(
    "/stories/:id/chapters/:chapterId/lock",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const c = (await db
        .select({ id: storyChapters.id })
        .from(storyChapters)
        .where(and(eq(storyChapters.id, req.params.chapterId), eq(storyChapters.storyId, req.params.id)))
        .limit(1))[0];
      if (!c) { reply.code(404); return { error: "not found" }; }
      await db
        .delete(storyChapterLocks)
        .where(and(
          eq(storyChapterLocks.chapterId, c.id),
          eq(storyChapterLocks.userId, me.id),
        ));
      return { ok: true };
    },
  );

  /** Read-only lock state inspection. */
  app.get<{ Params: { id: string; chapterId: string } }>(
    "/stories/:id/chapters/:chapterId/lock",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      // Without this storyId binding, anyone authed could probe foreign
      // chapter locks across stories and enumerate holder usernames.
      const c = (await db
        .select({ id: storyChapters.id, updatedAt: storyChapters.updatedAt })
        .from(storyChapters)
        .where(and(eq(storyChapters.id, req.params.chapterId), eq(storyChapters.storyId, req.params.id)))
        .limit(1))[0];
      if (!c) { reply.code(404); return { error: "not found" }; }
      const currentUpdatedAt = +c.updatedAt;
      const existing = (await db
        .select()
        .from(storyChapterLocks)
        .where(eq(storyChapterLocks.chapterId, req.params.chapterId))
        .limit(1))[0];
      if (!existing) {
        const payload: StoryChapterLockState = {
          chapterId: req.params.chapterId,
          heldByMe: false,
          holder: null,
          expiresAt: 0,
          currentUpdatedAt,
        };
        return payload;
      }
      const now = Date.now();
      const expired = +existing.lastRefreshAt + STORY_CHAPTER_LOCK_LEASE_MS < now;
      if (expired) {
        // Lazy GC, scoped to the holder we just observed — otherwise a
        // concurrent takeover could be deleted by a stale-state request.
        await db
          .delete(storyChapterLocks)
          .where(and(
            eq(storyChapterLocks.chapterId, req.params.chapterId),
            eq(storyChapterLocks.userId, existing.userId),
          ))
          .catch(() => {});
        const payload: StoryChapterLockState = {
          chapterId: req.params.chapterId,
          heldByMe: false,
          holder: null,
          expiresAt: 0,
          currentUpdatedAt,
        };
        return payload;
      }
      const heldByMe = existing.userId === me.id;
      const payload: StoryChapterLockState = {
        chapterId: req.params.chapterId,
        heldByMe,
        holder: heldByMe ? null : await loadLockHolder(db, existing.userId),
        expiresAt: +existing.lastRefreshAt + STORY_CHAPTER_LOCK_LEASE_MS,
        currentUpdatedAt,
      };
      return payload;
    },
  );

  app.get("/me/stories/following", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const rows = await db
      .select({ story: stories, sub: storySubscriptions })
      .from(storySubscriptions)
      .innerJoin(stories, eq(stories.id, storySubscriptions.storyId))
      .where(eq(storySubscriptions.userId, me.id))
      .orderBy(desc(storySubscriptions.subscribedAt))
      .limit(100);
    const cards = await Promise.all(rows.map((r) => toCard(db, r.story)));
    return { stories: cards };
  });

  /* ===================================================== *
   *  Reports (Phase 10)
   *
   *  Single-table moderation queue keyed by (targetKind, targetId).
   *  Filing is idempotent — second click silently no-ops thanks to
   *  the (reporterUserId, targetKind, targetId) unique index.
   * ===================================================== */

  /**
   * File a report on a story / chapter / review / review reply.
   * The body's `targetKind` discriminates; the URL fixes the story
   * scope, the body fixes the inner target id (chapter / review /
   * reply id).
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/stories/:id/reports",
    {
      // Anti-spam: a single user can file at most 10 reports per
      // minute across all targets. The unique (reporter, target)
      // index already prevents floods against a single target; this
      // cap blocks a malicious user from cycling through many
      // targets. The window is per-IP at the fastify-rate-limit
      // layer; we err toward generous so good-faith users reporting
      // a thread of related content don't get tripped.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const access = await viewerMayRead(s, me.id, me.role, db);
      if (!access.ok) { reply.code(403); return { error: "forbidden" }; }

      const schema = z.object({
        targetKind: z.enum(["story", "chapter", "review", "review_reply"]),
        targetId: z.string().min(1),
        reason: z.string().max(500).optional(),
      }).strict();
      let body;
      try { body = schema.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      // Resolve target + capture snapshot so the queue still works
      // if the author later deletes the reported content.
      const snapshot = await captureReportSnapshot(db, s, body.targetKind, body.targetId);
      if (!snapshot) { reply.code(404); return { error: "report target not found" }; }

      const id = nanoid();
      try {
        await db.insert(storyReports).values({
          id,
          targetKind: body.targetKind,
          targetId: body.targetId,
          storyId: s.id,
          reporterUserId: me.id,
          reason: body.reason ?? null,
          snapshotJson: JSON.stringify(snapshot),
        });
      } catch {
        // Likely the unique index — second-click silently no-ops.
        return { ok: true, alreadyReported: true };
      }
      reply.code(201);
      return { ok: true };
    },
  );

  /* ---------- Admin queue (Phase 10) ---------- */

  /**
   * Admin: list reports filtered by status / kind / story. Default sort
   * is open-first then newest. Cap at 100 per call — large queues should
   * paginate via the `before` cursor.
   */
  app.get<{ Querystring: { status?: string; targetKind?: string; storyId?: string; limit?: string } }>(
    "/admin/scriptorium/reports",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me || !isAdminRole(me.role)) {
        reply.code(403);
        return { error: "admin only" };
      }
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? "50", 10) || 50));
      const conds: ReturnType<typeof eq>[] = [];
      if (req.query.status && ["open", "reviewed", "dismissed"].includes(req.query.status)) {
        conds.push(eq(storyReports.status, req.query.status as StoryReportStatus));
      }
      if (req.query.targetKind && ["story", "chapter", "review", "review_reply"].includes(req.query.targetKind)) {
        conds.push(eq(storyReports.targetKind, req.query.targetKind));
      }
      if (req.query.storyId) {
        conds.push(eq(storyReports.storyId, req.query.storyId));
      }
      const where = conds.length ? and(...conds) : undefined;
      const rows = await db
        .select({
          report: storyReports,
          story: stories,
          reporter: users,
        })
        .from(storyReports)
        .innerJoin(stories, eq(stories.id, storyReports.storyId))
        .innerJoin(users, eq(users.id, storyReports.reporterUserId))
        .where(where)
        // Open first (asc on status), then newest.
        .orderBy(asc(storyReports.status), desc(storyReports.createdAt))
        .limit(limit);

      // Resolver-username lookup is cheap when nullable.
      const resolverIds = Array.from(new Set(
        rows.map((r) => r.report.resolvedById).filter((id): id is string => !!id),
      ));
      const resolverRows = resolverIds.length
        ? await db
            .select({ id: users.id, username: users.username })
            .from(users)
            .where(sql`${users.id} IN (${sql.join(resolverIds.map((id) => sql`${id}`), sql`, `)})`)
        : [];
      const resolverById = new Map(resolverRows.map((r) => [r.id, r.username]));

      const entries: StoryReport[] = rows.map((r) => {
        let snapshot: Record<string, unknown> = {};
        try { snapshot = JSON.parse(r.report.snapshotJson) as Record<string, unknown>; }
        catch { /* keep empty */ }
        return {
          id: r.report.id,
          targetKind: r.report.targetKind as StoryReportTargetKind,
          targetId: r.report.targetId,
          storyId: r.report.storyId,
          storyTitle: r.story.title,
          reporterUsername: r.reporter.username,
          reporterUserId: r.reporter.id,
          reason: r.report.reason ?? null,
          snapshot,
          status: r.report.status as StoryReportStatus,
          resolvedByUsername: r.report.resolvedById
            ? (resolverById.get(r.report.resolvedById) ?? null)
            : null,
          resolvedAt: r.report.resolvedAt ? +r.report.resolvedAt : null,
          resolutionNote: r.report.resolutionNote ?? null,
          createdAt: +r.report.createdAt,
        };
      });
      return { reports: entries };
    },
  );

  /**
   * Admin: resolve / dismiss a single report. Audit-logged.
   */
  app.patch<{ Params: { rid: string }; Body: unknown }>(
    "/admin/scriptorium/reports/:rid",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me || !isAdminRole(me.role)) {
        reply.code(403);
        return { error: "admin only" };
      }
      const schema = z.object({
        status: z.enum(["reviewed", "dismissed"]),
        note: z.string().max(500).optional(),
      }).strict();
      let body;
      try { body = schema.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const r = (await db
        .select()
        .from(storyReports)
        .where(eq(storyReports.id, req.params.rid))
        .limit(1))[0];
      if (!r) { reply.code(404); return { error: "not found" }; }

      await db
        .update(storyReports)
        .set({
          status: body.status,
          resolvedById: me.id,
          resolvedAt: new Date(),
          resolutionNote: body.note ?? null,
        })
        .where(eq(storyReports.id, r.id));
      await recordAudit(db, {
        actorUserId: me.id,
        action: "report_resolve",
        reason: body.note ?? null,
        metadata: { storyReportId: r.id, targetKind: r.targetKind, targetId: r.targetId, status: body.status },
      });
      return { ok: true };
    },
  );

  /**
   * Admin: force-rate a story (override author's rating). Audit-logged.
   * Useful when a reporter flags a story as mis-rated (e.g., reads as
   * R but the author shipped PG-13). The author cannot revert this
   * without a new admin review — that gate is enforced in the UI, not
   * here (the route accepts patches from authors too; admins set a
   * `force_locked` flag in a future iteration if we need hard lock).
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/admin/scriptorium/stories/:id/force-rate",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me || !isAdminRole(me.role)) {
        reply.code(403);
        return { error: "admin only" };
      }
      const schema = z.object({
        rating: ratingEnum,
        note: z.string().max(500).optional(),
      }).strict();
      let body;
      try { body = schema.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      await db
        .update(stories)
        .set({ rating: body.rating, updatedAt: new Date() })
        .where(eq(stories.id, s.id));
      await recordAudit(db, {
        actorUserId: me.id,
        action: "story_force_rate",
        reason: body.note ?? null,
        metadata: { storyId: s.id, oldRating: s.rating, newRating: body.rating },
      });
      return { ok: true };
    },
  );

  /**
   * Admin: hide a story (set visibility to private). The author still
   * sees it in their My Stories tab; the rest of the world doesn't.
   */
  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    "/admin/scriptorium/stories/:id/hide",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me || !isAdminRole(me.role)) {
        reply.code(403);
        return { error: "admin only" };
      }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      await db
        .update(stories)
        .set({ visibility: "private", updatedAt: new Date() })
        .where(eq(stories.id, s.id));
      await recordAudit(db, {
        actorUserId: me.id,
        action: "story_admin_hide",
        reason: req.body?.note ?? null,
        metadata: { storyId: s.id, oldVisibility: s.visibility },
      });
      return { ok: true };
    },
  );

  /**
   * Admin: delete a story. Cascades to chapters / reviews / applause /
   * subscriptions / reports per the FK constraints. Hard delete.
   */
  app.delete<{ Params: { id: string }; Body: { note?: string } }>(
    "/admin/scriptorium/stories/:id",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me || !isAdminRole(me.role)) {
        reply.code(403);
        return { error: "admin only" };
      }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      await db.delete(stories).where(eq(stories.id, s.id));
      await recordAudit(db, {
        actorUserId: me.id,
        action: "story_admin_delete",
        reason: req.body?.note ?? null,
        metadata: { storyId: s.id, storyTitle: s.title, authorUserId: s.authorUserId },
      });
      return { ok: true };
    },
  );
}

/* =========================================================
 *  Module-level helpers — called from inside the route registration
 *  function as fire-and-forget after publish events.
 * ========================================================= */

/**
 * Push a `story:invite` event to every live socket owned by `userId`.
 * Mirrors `emitMutualPrompt` for collaborator invites — Accept |
 * Decline card lands above the chat composer the same way mutual
 * titles do.
 */
async function emitStoryInvite(
  io: Io,
  userId: string,
  payload: StoryCollaboratorInvite,
): Promise<void> {
  const sockets = await io.fetchSockets();
  for (const s of sockets) {
    if ((s.data as { userId?: string }).userId === userId) {
      s.emit("story:invite", payload);
    }
  }
}

/**
 * Build a snapshot of the reported content for the moderation queue.
 * Returns null when the target id doesn't resolve (caller turns that
 * into a 404). The snapshot's shape varies by `kind`; the admin queue
 * UI branches on it.
 */
async function captureReportSnapshot(
  db: Db,
  story: typeof stories.$inferSelect,
  kind: StoryReportTargetKind,
  targetId: string,
): Promise<Record<string, unknown> | null> {
  // story-level reports always resolve (the caller already loaded the row).
  if (kind === "story") {
    return {
      kind: "story",
      title: story.title,
      slug: story.slug,
      summary: story.summary,
      rating: story.rating,
      visibility: story.visibility,
      authorUserId: story.authorUserId,
      authorCharacterId: story.authorCharacterId,
    };
  }
  if (kind === "chapter") {
    const c = (await db
      .select()
      .from(storyChapters)
      .where(and(eq(storyChapters.id, targetId), eq(storyChapters.storyId, story.id)))
      .limit(1))[0];
    if (!c) return null;
    return {
      kind: "chapter",
      storyTitle: story.title,
      title: c.title,
      sortOrder: c.sortOrder,
      status: c.status,
      bodyExcerpt: c.bodyHtml.slice(0, 2000),
      wordCount: c.wordCount,
    };
  }
  if (kind === "review") {
    const r = (await db
      .select()
      .from(storyReviews)
      .where(and(eq(storyReviews.id, targetId), eq(storyReviews.storyId, story.id)))
      .limit(1))[0];
    if (!r) return null;
    return {
      kind: "review",
      storyTitle: story.title,
      rating: r.rating,
      bodyExcerpt: r.bodyHtml.slice(0, 2000),
      reviewerUserId: r.reviewerUserId,
      reviewerCharacterId: r.reviewerCharacterId,
      pinnedByAuthor: !!r.pinnedByAuthor,
      hiddenByAuthor: !!r.hiddenByAuthor,
    };
  }
  if (kind === "review_reply") {
    const rr = (await db
      .select()
      .from(storyReviewReplies)
      .where(eq(storyReviewReplies.id, targetId))
      .limit(1))[0];
    if (!rr) return null;
    // Verify the reply belongs to a review on this story.
    const parent = (await db
      .select()
      .from(storyReviews)
      .where(and(eq(storyReviews.id, rr.reviewId), eq(storyReviews.storyId, story.id)))
      .limit(1))[0];
    if (!parent) return null;
    return {
      kind: "review_reply",
      storyTitle: story.title,
      bodyExcerpt: rr.bodyHtml.slice(0, 2000),
      replyerUserId: rr.replyerUserId,
      replyerCharacterId: rr.replyerCharacterId,
      parentReviewId: parent.id,
    };
  }
  return null;
}

/**
 * Fan out a `story:chapter-published` socket event to every subscribed
 * follower, plus a web-push notification when they opted in. Excludes
 * the author themselves so they don't ping their own publish. Best
 * effort: a notification hiccup never blocks the publish path.
 */
async function notifyPublish(
  db: Db,
  io: Io,
  story: typeof stories.$inferSelect,
  chapter: typeof storyChapters.$inferSelect,
  publishingUserId: string,
): Promise<void> {
  const subs = await db
    .select()
    .from(storySubscriptions)
    .where(eq(storySubscriptions.storyId, story.id));
  if (subs.length === 0) return;

  // Resolve the author's display name once.
  const authorRow = (await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, story.authorUserId))
    .limit(1))[0];
  const authorHandle = authorRow?.username ?? "(unknown)";
  let authorDisplayName = authorHandle;
  if (story.authorCharacterId) {
    const c = (await db
      .select({ name: characters.name })
      .from(characters)
      .where(eq(characters.id, story.authorCharacterId))
      .limit(1))[0];
    if (c) authorDisplayName = c.name;
  }

  const payload: StoryChapterPublishedEvent = {
    storyId: story.id,
    storySlug: story.slug,
    storyTitle: story.title,
    authorHandle,
    authorDisplayName,
    chapterId: chapter.id,
    chapterTitle: chapter.title || `Chapter ${chapter.sortOrder + 1}`,
    chapterIndex: chapter.sortOrder,
    publishedAt: chapter.publishedAt ? +chapter.publishedAt : Date.now(),
  };

  // Find every connected socket for each subscriber and emit the
  // event directly. The socket layer doesn't have a per-user channel,
  // so we iterate live sockets and filter by userId in data.
  // Excludes the publishing user (no self-notify on your own publish).
  const sockets = await io.fetchSockets();
  const followerIds = new Set(subs.map((s) => s.userId).filter((u) => u !== publishingUserId));
  for (const sock of sockets) {
    const uid = (sock.data as { userId?: string }).userId;
    if (uid && followerIds.has(uid)) {
      sock.emit("story:chapter-published", payload);
    }
  }

  // Web-push fan-out for opted-in followers. Self-deliveries already
  // filtered above (followerIds excludes the publishing user).
  for (const sub of subs) {
    if (!sub.pushEnabled) continue;
    if (sub.userId === publishingUserId) continue;
    void pushToUser(db, sub.userId, {
      title: story.title,
      body: `${authorDisplayName} published "${payload.chapterTitle}"`,
      tag: `story-${story.id}`,
      url: `/stories/@${authorHandle.toLowerCase()}/${story.slug}`,
    }).catch(() => { /* swallow; pushToUser already logs */ });
  }
}

/**
 * Daily-publish XP trickle. Per the project ethos memory: NO daily
 * streaks, NO grinding. This grants a small one-shot XP per UTC day
 * regardless of how many chapters the author publishes — once per day,
 * no chaining. The cap is enforced by looking back at the earning
 * ledger for any prior `scriptorium_daily_publish` row in the current
 * UTC day; if one exists, the call no-ops.
 */
const SCRIPTORIUM_DAILY_PUBLISH_XP = 25;
const SCRIPTORIUM_DAILY_PUBLISH_REASON = "scriptorium_daily_publish";

async function awardDailyPublishTrickle(db: Db, io: Io, userId: string): Promise<void> {
  // UTC midnight today, in ms.
  const now = new Date();
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const prior = (await db
    .select({ id: earningLedger.id })
    .from(earningLedger)
    .where(and(
      eq(earningLedger.scope, "user"),
      eq(earningLedger.ownerId, userId),
      eq(earningLedger.reason, SCRIPTORIUM_DAILY_PUBLISH_REASON),
      sql`${earningLedger.createdAt} >= ${utcMidnight}`,
    ))
    .limit(1))[0];
  if (prior) return; // already credited today; no chaining
  await creditPool(db, io, {
    scope: "user",
    ownerId: userId,
    xpDelta: SCRIPTORIUM_DAILY_PUBLISH_XP,
    currencyDelta: 0,
    reason: SCRIPTORIUM_DAILY_PUBLISH_REASON,
    metadata: null,
    notifyUserId: userId,
  });
}
