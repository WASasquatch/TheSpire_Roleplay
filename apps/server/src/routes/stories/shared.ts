import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  PrivateStoryStub,
  Role,
  StoryAuthor,
  StoryCard,
  StoryChapter,
  StoryChapterPublishedEvent,
  StoryChapterRef,
  StoryChapterStatus,
  StoryCollaboratorInvite,
  StoryCollaboratorRole,
  StoryEntity,
  StoryEntityKind,
  StoryGenre,
  StoryRating,
  StoryReportTargetKind,
  StoryReview,
  StoryReviewReply,
  StoryReviewer,
  StoryStatus,
  StoryVisibility,
  Theme,
 ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import {
  PUBLIC_READABLE_RATINGS,
  STORY_AUTOSAVE_HISTORY_CAP,
  STORY_CONTENT_WARNINGS,
  STORY_COPY_PRICE_MIN,
  STORY_COPY_PRICE_MAX,
  STORY_SAMPLE_MAX_WORDS,
  STORY_ENTITY_BODY_MAX,
  STORY_ENTITY_KINDS,
  STORY_GENRES,
  STORY_REVIEW_BODY_MAX,
  STORY_REVIEW_REPLY_MAX,
  STORY_TAG_CAP,
  permissionsForCollaboratorRole,
  countWords,
  slugRx,
  normalizeTheme,
  parseTagList,
  isoWeekKey,
  rollWeeklyStreak,
  scriptoriumChapterBaseReward,
  scriptoriumStreakMultiplier,
  startOfUtcDayMs,
} from "@thekeep/shared";
import type { Server as IoServer } from "socket.io";
import { hasPermission } from "../../auth/permissions.js";
import type {
  storyEntities} from "../../db/schema.js";
import {
  characterEarning,
  characters,
  earningLedger,
  scriptoriumWriteStreaks,
  storyCopies,
  userEarning,
  stories,
  storyApplause,
  storyChapters,
  storyChapterVersions,
  storyCollaborators,
  storyReviewReplies,
  storyReviews,
  storySubscriptions,
  users,
  worlds,
} from "../../db/schema.js";
import { persistTargetedSystemMessageToActiveRooms } from "../../realtime/targetedMessages.js";
import {
  offsetPageQueryShape,
} from "../../lib/pagination.js";
import { pushToUser } from "../../push.js";
import { creditPool } from "../../earning/award.js";
import { earnedTodayForCap } from "../../earning/dailyCap.js";
import { DEFAULT_SERVER_ID } from "../../earning/pool.js";
import { detectProseSpam } from "../../earning/messageQuality.js";
import { getSettings } from "../../settings.js";
import type { Db } from "../../db/index.js";

export type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

// Per-IP cap for the PUBLIC, DB-heavy browse/read routes (splash shelf,
// catalog, story landing). Click-driven, not polled; 60/min leaves
// generous headroom for a page firing a few in parallel while capping a
// refetch/reconnect loop at 1/s. Bump to 120 if a busy shared IP trips it.
export const browseLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } } as const;

/** Slug rules: lowercase letters, numbers, hyphens. 1-60 chars. Same shape as worlds. */
export const SLUG_RX = slugRx(60);

export const visibilityEnum = z.enum(["private", "unlisted", "public"]);
export const ratingEnum = z.enum(["G", "PG", "PG-13", "R", "NC-17"]);
export const statusEnum = z.enum(["draft", "in_progress", "complete", "hiatus", "abandoned"]);
export const genreEnum = z.enum(STORY_GENRES as unknown as [string, ...string[]]);
export const cwEnum = z.enum(STORY_CONTENT_WARNINGS as unknown as [string, ...string[]]);
export const chapterStatusEnum = z.enum(["draft", "published"]);

export const TAG_RX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const tagSchema = z
  .string()
  .min(1)
  .max(32)
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => TAG_RX.test(s), { message: "tags must be lowercase letters / digits / hyphens" });
export const tagsArraySchema = z
  .array(tagSchema)
  .max(STORY_TAG_CAP)
  .transform((arr) => parseTagList(arr.join(",")));
export const cwArraySchema = z
  .array(cwEnum)
  .max(STORY_CONTENT_WARNINGS.length)
  .transform((arr) => parseTagList(arr.join(",")));

export const httpUrl = z.string().min(1).max(2000).refine(
  (s) => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } },
  { message: "coverImageUrl must use http or https" },
);

export const createStoryBody = z.object({
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
  copyPrice: z.number().int().min(STORY_COPY_PRICE_MIN).max(STORY_COPY_PRICE_MAX).nullable().optional(),
  buyToRead: z.boolean().optional(),
}).strict();

export const updateStoryBody = z.object({
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
  copyPrice: z.number().int().min(STORY_COPY_PRICE_MIN).max(STORY_COPY_PRICE_MAX).nullable().optional(),
  buyToRead: z.boolean().optional(),
}).strict();

export const catalogQuery = z.object({
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
  ...offsetPageQueryShape,
}).strict();

export const createChapterBody = z.object({
  title: z.string().max(120).optional(),
  bodyHtml: z.string().max(500_000).optional(),
  authorNotesHtml: z.string().max(20_000).optional(),
  contentWarnings: cwArraySchema.optional(),
}).strict();

export const updateChapterBody = z.object({
  title: z.string().max(120).optional(),
  bodyHtml: z.string().max(500_000).optional(),
  authorNotesHtml: z.string().max(20_000).optional(),
  contentWarnings: cwArraySchema.optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  status: chapterStatusEnum.optional(),
  reason: z.enum(["autosave", "manual"]).optional(),
}).strict();

export const upsertReadingPositionBody = z.object({
  lastChapterId: z.string().nullable().optional(),
  lastAnchorId: z.string().nullable().optional(),
  percentThrough: z.number().min(0).max(100).optional(),
}).strict();

export const createReviewBody = z.object({
  rating: z.number().int().min(1).max(5),
  bodyHtml: z.string().max(STORY_REVIEW_BODY_MAX).optional(),
  /** Identity to publish under. Null = master account. Must be one of the caller's characters. */
  reviewerCharacterId: z.string().nullable().optional(),
}).strict();

export const updateReviewBody = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  bodyHtml: z.string().max(STORY_REVIEW_BODY_MAX).optional(),
}).strict();

/** Body of the author-only moderation PATCH on a review. */
export const moderateReviewBody = z.object({
  pinnedByAuthor: z.boolean().optional(),
  hiddenByAuthor: z.boolean().optional(),
}).strict();

export const createReplyBody = z.object({
  bodyHtml: z.string().min(1).max(STORY_REVIEW_REPLY_MAX),
  replyerCharacterId: z.string().nullable().optional(),
}).strict();

export const applauseToggleBody = z.object({
  /** Optional, null/omitted toggles applause on the whole story. */
  chapterId: z.string().nullable().optional(),
}).strict();

/* ---------- Codex schemas (Phase 8) ---------- */

export const entityKindEnum = z.enum(STORY_ENTITY_KINDS as unknown as [string, ...string[]]);
export const statsRecord = z.record(z.string().max(500)).refine(
  (o) => Object.keys(o).length <= 50,
  { message: "max 50 stats keys" },
);

export const createEntityBody = z.object({
  kind: entityKindEnum,
  name: z.string().min(1).max(120),
  slug: z.string().max(60).optional(),
  summary: z.string().max(500).optional(),
  bodyHtml: z.string().max(STORY_ENTITY_BODY_MAX).optional(),
  stats: statsRecord.optional(),
  imageUrl: httpUrl.nullable().optional(),
  isPublic: z.boolean().optional(),
}).strict();

export const updateEntityBody = z.object({
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

export async function loadAuthor(db: Db, userId: string, characterId: string | null): Promise<StoryAuthor> {
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

export function parseStoredTheme(raw: string | null): Theme | null {
  if (!raw) return null;
  try { return normalizeTheme(JSON.parse(raw)); }
  catch { return null; }
}

export async function loadLinkedWorldRef(
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

export async function toCard(db: Db, row: typeof stories.$inferSelect): Promise<StoryCard> {
  const author = await loadAuthor(db, row.authorUserId, row.authorCharacterId ?? null);
  const linkedWorld = await loadLinkedWorldRef(db, row.linkedWorldId ?? null);
  // getSettings is an in-memory cached singleton, so resolving the default
  // per card is free. Author-set price wins; null inherits the site default.
  const defaultCopyPrice = (await getSettings(db)).earningConfig.scriptorium.copyPrice;
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
    copyPrice: row.copyPrice ?? defaultCopyPrice,
    buyToRead: !!row.buyToRead,
    publishedAt: row.publishedAt ? +row.publishedAt : null,
    updatedAt: +row.updatedAt,
  };
}

export function chapterRowToRef(row: typeof storyChapters.$inferSelect): StoryChapterRef {
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

export function chapterRowToFull(row: typeof storyChapters.$inferSelect): StoryChapter {
  return {
    ...chapterRowToRef(row),
    bodyHtml: row.bodyHtml,
    authorNotesHtml: row.authorNotesHtml,
    createdAt: +row.createdAt,
  };
}

export function entityRowToWire(row: typeof storyEntities.$inferSelect): StoryEntity {
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
export function injectParagraphAnchors(html: string): string {
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
export async function viewerMayRead(
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
  // Admin-style view of other authors' draft content. Defaults to
  // admin-only via the seed; matrix-grantable so a moderator without
  // full admin can still triage queued reports.
  const isAdmin = viewerUserId != null && viewerRole != null && db
    ? await hasPermission({ id: viewerUserId, role: viewerRole }, "view_others_scriptorium_drafts", db)
    : false;

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
  // Only NC-17 is gated behind the login wall, the rest is
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

/**
 * "Buy to Read" sample: the first chapter's leading paragraphs, capped near
 * STORY_SAMPLE_MAX_WORDS. Cut on whole `<p>` blocks so tags never break;
 * falls back to plain-text truncation when the body has no paragraph markup.
 */
export function buildChapterSample(html: string): string {
  const paras = html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) ?? [];
  const out: string[] = [];
  let words = 0;
  for (const p of paras) {
    // Don't add a paragraph that would push well past the cap once we already
    // have something — keeps the sample close to the target length.
    if (out.length > 0 && words + countWords(p) > STORY_SAMPLE_MAX_WORDS) break;
    out.push(p);
    words += countWords(p);
    if (words >= STORY_SAMPLE_MAX_WORDS) break;
  }
  // Use the whole-paragraph sample only when it's within a sane bound. If the
  // body has no <p> structure, or a single giant first paragraph blew past the
  // cap (would leak most of the chapter), fall back to plain-text truncation.
  if (out.length > 0 && words <= STORY_SAMPLE_MAX_WORDS * 1.6) return out.join("");
  const text = html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const w = text.split(" ").filter(Boolean).slice(0, STORY_SAMPLE_MAX_WORDS);
  return w.length ? `<p>${w.join(" ")}…</p>` : "";
}

/**
 * Resolve whether a viewer may read a (possibly paywalled) story in full.
 * For a non-`buyToRead` story everyone who passed `viewerMayRead` reads full.
 * For a `buyToRead` story, full access requires: author, an active collaborator
 * (book team), owning a copy under ANY of the viewer's identities (reading is
 * account-level), the `bypass_scriptorium_paywall` permission, or masteradmin.
 * The draft-admin permission alone does NOT bypass the paywall — it's a
 * separate, explicitly-warned grant.
 */
export async function resolveReadAccess(
  db: Db,
  story: typeof stories.$inferSelect,
  me: { id: string; role: Role } | null,
): Promise<{ canReadFull: boolean; hasBypass: boolean; hasPurchased: boolean; isAuthor: boolean; isTeam: boolean }> {
  const isAuthor = !!me && me.id === story.authorUserId;
  if (!story.buyToRead || isAuthor) {
    return { canReadFull: true, hasBypass: false, hasPurchased: false, isAuthor, isTeam: isAuthor };
  }
  if (!me) {
    return { canReadFull: false, hasBypass: false, hasPurchased: false, isAuthor: false, isTeam: false };
  }
  const hasBypass = await hasPermission(me, "bypass_scriptorium_paywall", db);
  const hasPurchased = !!(await db
    .select({ id: storyCopies.id })
    .from(storyCopies)
    .where(and(eq(storyCopies.ownerUserId, me.id), eq(storyCopies.storyId, story.id)))
    .limit(1))[0];
  const perm = await effectiveStoryPermissions(db, story, me.id, me.role);
  const isTeam = perm.role === "owner" || perm.role === "reader" || perm.role === "editor" || perm.role === "co_author";
  const canReadFull = isTeam || hasPurchased || hasBypass;
  return { canReadFull, hasBypass, hasPurchased, isAuthor, isTeam };
}

export async function resolveStory(
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

export async function resolveStoryByHandle(
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

export async function recountStoryTotals(db: Db, storyId: string): Promise<void> {
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
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Sync, transactional twin of `recountStoryTotals`. Use inside a
 * `db.transaction(...)` block when chapter mutations + story totals
 * must commit atomically, otherwise a crash between the chapter
 * UPDATE and the totals UPDATE leaves the story row claiming a word
 * count that doesn't match its chapters.
 */
export function recountStoryTotalsTx(tx: Tx, storyId: string): void {
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

export async function appendChapterVersion(
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
 * "read MAX, then INSERT MAX+1" race is eliminated, two concurrent
 * saves under the SQLite write lock would otherwise both read the
 * same MAX and the loser would 500 on the `(chapter_id, version)`
 * unique index. The subquery evaluates inside the same transaction
 * holding the write lock, so the value cannot drift between read
 * and insert.
 */
export function appendChapterVersionTx(
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
export async function loadLockHolder(db: Db, userId: string): Promise<{ userId: string; username: string }> {
  const u = (await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0];
  return { userId, username: u?.username ?? "(unknown)" };
}

export async function isOwnIdentity(db: Db, userId: string, characterId: string | null): Promise<boolean> {
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
 * `viewerMayRead` gate is separate and runs first, this helper only
 * answers "what does this viewer get to MUTATE."
 */
export async function effectiveStoryPermissions(
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
  // Admin override grants the full collaborator-role bundle. Uses
  // `edit_others_scriptorium_content` since this gates write permissions
  // across the story (chapters, codex, collaborators, etc.).
  if (viewerUserId && viewerRole
      && (await hasPermission({ id: viewerUserId, role: viewerRole }, "edit_others_scriptorium_content", db))) {
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
export async function loadReviewer(db: Db, userId: string, characterId: string | null): Promise<StoryReviewer> {
  return loadAuthor(db, userId, characterId);
}

/**
 * Recompute review_count + avg_rating_x100 from the visible reviews
 * (i.e. excludes hidden-by-author). Stored as integer * 100 for sort
 * stability without floats.
 */
export async function recountStoryReviews(db: Db, storyId: string): Promise<void> {
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
export async function recountStoryApplause(db: Db, storyId: string): Promise<void> {
  const row = (await db
    .select({ n: sql<number>`count(*)` })
    .from(storyApplause)
    .where(eq(storyApplause.storyId, storyId)))[0];
  await db
    .update(stories)
    .set({ applauseCount: row?.n ?? 0, updatedAt: new Date() })
    .where(eq(stories.id, storyId));
}

export function reviewRowToWire(
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

export function replyRowToWire(
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
 *  Module-level helpers, called from inside the route registration
 *  function as fire-and-forget after publish events.
 * ========================================================= */

/**
 * Push a `story:invite` event to every live socket owned by `userId`.
 * Mirrors `emitMutualPrompt` for collaborator invites, Accept |
 * Decline card lands above the chat composer the same way mutual
 * titles do.
 */
export async function emitStoryInvite(
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
export async function captureReportSnapshot(
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
export async function notifyPublish(
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
  // Persist the "✦ X published …" line per follower so it survives a
  // refetch. The live copy is still synthesized client-side from the
  // event above; this only writes the durable, recipient-scoped copy and
  // does not emit. Body matches the client's synthesized text exactly.
  await persistTargetedSystemMessageToActiveRooms(
    io,
    db,
    followerIds,
    `✦ ${payload.authorDisplayName} published "${payload.chapterTitle}" of ${payload.storyTitle}.`,
  );

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

export const SCRIPTORIUM_CHAPTER_REWARD_REASON = "scriptorium_chapter_reward";

/**
 * One-time writing reward for publishing a chapter. Writing is a large,
 * deliberate effort, so this pays meaningfully — but only for real output.
 *
 * Credits the AUTHORING identity (the story's character pool if it was authored
 * IC, else the author's master/OOC pool), scaled by word-count brackets and a
 * weekly publishing-streak multiplier, and bounded by a per-pool per-UTC-day
 * cap. All amounts come from the admin-tunable `scriptorium` EarningConfig.
 *
 * Anti-abuse:
 *  - Pays at most ONCE per chapter, ever — the `reward_paid_at` latch is set via
 *    a conditional UPDATE that only one caller can win, so re-publishes and
 *    concurrent publishes never double-pay.
 *  - Chapters under the word floor latch as "paid" but earn nothing, so padding
 *    a stub up to length later can't retrigger a reward.
 *  - The daily cap is enforced by summing today's reward rows for the pool and
 *    clamping the new credit so the running total stays under the ceiling.
 */
export async function awardChapterPublishReward(
  db: Db,
  io: Io,
  story: typeof stories.$inferSelect,
  chapter: typeof storyChapters.$inferSelect,
): Promise<void> {
  const cfg = (await getSettings(db)).earningConfig.scriptorium;
  if (!cfg.enabled) return;

  // Pay-once latch: flip reward_paid_at from NULL → now. Only one publish wins;
  // everything past first publish (edits, unpublish→republish) no-ops here.
  const now = new Date();
  const latched = await db
    .update(storyChapters)
    .set({ rewardPaidAt: now })
    .where(and(eq(storyChapters.id, chapter.id), isNull(storyChapters.rewardPaidAt)))
    .run();
  if (latched.changes === 0) return;

  // Authoring identity → which earning pool gets paid.
  const scope: "user" | "character" = story.authorCharacterId ? "character" : "user";
  const ownerId = story.authorCharacterId ?? story.authorUserId;
  const notifyUserId = story.authorUserId;

  // Per-word base payout; zero below the word floor (we still latched above, so
  // a later edit past the floor can't re-trigger).
  const base = scriptoriumChapterBaseReward(chapter.wordCount, cfg);
  if (base.xp <= 0 && base.currency <= 0) return;

  // Spam gate (the chat-style block, tuned for prose): a padded / pasted-repeat
  // chapter earns nothing. It's latched, so it won't get another shot; we still
  // log a zero-value flagged ledger row so admins can audit + tune the knobs.
  if (cfg.spam.enabled) {
    const text = chapter.bodyHtml
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const spamReason = detectProseSpam(text, cfg.spam);
    if (spamReason) {
      await db.insert(earningLedger).values({
        id: nanoid(),
        scope,
        ownerId,
        xpDelta: 0,
        currencyDelta: 0,
        reason: SCRIPTORIUM_CHAPTER_REWARD_REASON,
        metadataJson: JSON.stringify({ storyId: story.id, chapterId: chapter.id, wordCount: chapter.wordCount, flaggedSpam: true, spamReason }),
      }).run();
      return;
    }
  }

  // Advance the weekly publishing streak (once per ISO week per pool) and scale.
  const weekKey = isoWeekKey(now);
  // Scriptorium rewards stay GLOBAL (plan §9.6) — the streak lives on the
  // default server. server_id is part of the PK (migration 0286), so it must
  // appear in the read filter, the insert value, AND the conflict target
  // (the old 2-column target threw + silently dropped the streak).
  const prev = (await db
    .select()
    .from(scriptoriumWriteStreaks)
    .where(and(eq(scriptoriumWriteStreaks.serverId, DEFAULT_SERVER_ID), eq(scriptoriumWriteStreaks.ownerScope, scope), eq(scriptoriumWriteStreaks.ownerId, ownerId)))
    .limit(1))[0];
  const roll = rollWeeklyStreak(
    { streakCount: prev?.streakCount ?? 0, lastPublishWeekKey: prev?.lastPublishWeekKey ?? null, bestStreak: prev?.bestStreak ?? 0 },
    weekKey,
  );
  await db
    .insert(scriptoriumWriteStreaks)
    .values({ serverId: DEFAULT_SERVER_ID, ownerScope: scope, ownerId, streakCount: roll.streakCount, lastPublishWeekKey: roll.lastPublishWeekKey, bestStreak: roll.bestStreak, updatedAt: now })
    .onConflictDoUpdate({
      target: [scriptoriumWriteStreaks.serverId, scriptoriumWriteStreaks.ownerScope, scriptoriumWriteStreaks.ownerId],
      set: { streakCount: roll.streakCount, lastPublishWeekKey: roll.lastPublishWeekKey, bestStreak: roll.bestStreak, updatedAt: now },
    })
    .run();
  const mult = scriptoriumStreakMultiplier(roll.streakCount, cfg.streak);

  let xp = Math.round(base.xp * mult);
  let currency = Math.round(base.currency * mult);

  // Per-pool, per-UTC-day cap: sum today's reward rows and clamp so the running
  // total never exceeds the ceiling. Per-server cap scan: Scriptorium rewards
  // stay GLOBAL (plan §9.6) — they credit the default server (see the creditPool
  // below), so the cap count filters the SAME server. With the flag off this is
  // the only pool, so the count is byte-identical to today.
  const utcMidnight = startOfUtcDayMs(now.getTime());
  const spent = earnedTodayForCap(db, {
    serverId: DEFAULT_SERVER_ID,
    scope,
    ownerId,
    reason: { reason: SCRIPTORIUM_CHAPTER_REWARD_REASON },
    sinceMs: utcMidnight,
  });
  xp = Math.max(0, Math.min(xp, cfg.dailyXpCap - Number(spent.xp)));
  currency = Math.max(0, Math.min(currency, cfg.dailyCurrencyCap - Number(spent.currency)));
  if (xp <= 0 && currency <= 0) return; // daily cap exhausted

  await creditPool(db, io, {
    serverId: DEFAULT_SERVER_ID,
    scope,
    ownerId,
    xpDelta: xp,
    currencyDelta: currency,
    reason: SCRIPTORIUM_CHAPTER_REWARD_REASON,
    metadata: {
      storyId: story.id,
      chapterId: chapter.id,
      wordCount: chapter.wordCount,
      baseXp: base.xp,
      baseCurrency: base.currency,
      streak: roll.streakCount,
      mult,
    },
    notifyUserId,
  });
}

/**
 * Claw back the XP + currency a book earned its author — chapter-publish
 * rewards and copy-sale royalties (matched by `metadata.storyId`). Used by
 * admin removal when a book was blatantly farming the writing economy. Clamped
 * to the pool's current balance so the author can't be driven negative; writes
 * one negative ledger row (reason `scriptorium_admin_revoke`). Buyers of copies
 * are NOT refunded — that's a separate concern. Returns what was pulled.
 */
export async function revokeBookEarnings(
  db: Db,
  io: Io,
  story: typeof stories.$inferSelect,
): Promise<{ xp: number; currency: number }> {
  const scope: "user" | "character" = story.authorCharacterId ? "character" : "user";
  const ownerId = story.authorCharacterId ?? story.authorUserId;
  const agg = (await db
    .select({
      xp: sql<number>`COALESCE(SUM(${earningLedger.xpDelta}), 0)`,
      currency: sql<number>`COALESCE(SUM(${earningLedger.currencyDelta}), 0)`,
    })
    .from(earningLedger)
    .where(and(
      eq(earningLedger.scope, scope),
      eq(earningLedger.ownerId, ownerId),
      inArray(earningLedger.reason, ["scriptorium_chapter_reward", "scriptorium_royalty"]),
      sql`json_extract(${earningLedger.metadataJson}, '$.storyId') = ${story.id}`,
    )))[0] ?? { xp: 0, currency: 0 };
  const earnedXp = Math.max(0, Number(agg.xp));
  const earnedCurrency = Math.max(0, Number(agg.currency));
  if (earnedXp <= 0 && earnedCurrency <= 0) return { xp: 0, currency: 0 };
  // Clamp to the current balance so the claw-back can't push the pool negative
  // (creditPool floors currency at 0 but NOT xp, and a negative xp would break
  // rank placement).
  const bal = scope === "user"
    ? (await db.select({ xp: userEarning.xp, currency: userEarning.currency }).from(userEarning).where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, ownerId))).limit(1))[0]
    : (await db.select({ xp: characterEarning.xp, currency: characterEarning.currency }).from(characterEarning).where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, ownerId))).limit(1))[0];
  const revokeXp = Math.min(earnedXp, bal?.xp ?? 0);
  const revokeCurrency = Math.min(earnedCurrency, bal?.currency ?? 0);
  if (revokeXp <= 0 && revokeCurrency <= 0) return { xp: 0, currency: 0 };
  await creditPool(db, io, {
    serverId: DEFAULT_SERVER_ID,
    scope,
    ownerId,
    xpDelta: -revokeXp,
    currencyDelta: -revokeCurrency,
    reason: "scriptorium_admin_revoke",
    metadata: { storyId: story.id, storyTitle: story.title, earnedXp, earnedCurrency },
    notifyUserId: story.authorUserId,
  });
  return { xp: revokeXp, currency: revokeCurrency };
}
