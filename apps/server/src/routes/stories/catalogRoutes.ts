import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNull, isNotNull, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { hasPermission } from "../../auth/permissions.js";
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
  STORY_COPY_PRICE_MIN,
  STORY_COPY_PRICE_MAX,
  STORY_SAMPLE_MAX_WORDS,
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
  deriveSlug,
  slugRx,
  normalizeTheme,
  parseTagList,
  serializeTagList,
  isoWeekKey,
  rollWeeklyStreak,
  scriptoriumChapterBaseReward,
  scriptoriumStreakMultiplier,
  startOfUtcDayMs,
} from "@thekeep/shared";
import {
  characterEarning,
  characters,
  earningLedger,
  scriptoriumWriteStreaks,
  storyCopies,
  userEarning,
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
} from "../../db/schema.js";
import { persistTargetedSystemMessageToActiveRooms } from "../../realtime/targetedMessages.js";
import { sanitizeBio, stripMarginNotes } from "../../auth/html.js";
import { tagIncludes, tagExcludes } from "../../lib/tagFilter.js";
import { escapeLike } from "../../lib/nameLookup.js";
import {
  offsetPageQueryShape,
  resolveOffsetPage,
  countRows,
  offsetPageEnvelope,
} from "../../lib/pagination.js";
import { getSessionUser } from "../auth.js";
import { pushToUser } from "../../push.js";
import { creditPool } from "../../earning/award.js";
import { earnedTodayForCap } from "../../earning/dailyCap.js";
import { DEFAULT_SERVER_ID } from "../../earning/pool.js";
import { detectProseSpam } from "../../earning/messageQuality.js";
import { getSettings } from "../../settings.js";
import { recordAudit } from "../../audit.js";
import type { Db } from "../../db/index.js";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { Io } from "./shared.js";
import {
  loadAuthor, parseStoredTheme, loadLinkedWorldRef, toCard, chapterRowToRef, chapterRowToFull,
  entityRowToWire, injectParagraphAnchors, viewerMayRead, buildChapterSample, resolveReadAccess,
  resolveStory, resolveStoryByHandle, recountStoryTotals, recountStoryTotalsTx, appendChapterVersion,
  appendChapterVersionTx, loadLockHolder, isOwnIdentity, effectiveStoryPermissions, loadReviewer,
  recountStoryReviews, recountStoryApplause, reviewRowToWire, replyRowToWire, emitStoryInvite,
  captureReportSnapshot, notifyPublish, awardChapterPublishReward, revokeBookEarnings,
  SLUG_RX, browseLimit, ratingEnum, createStoryBody, updateStoryBody, catalogQuery,
  createChapterBody, updateChapterBody, upsertReadingPositionBody, createReviewBody, updateReviewBody,
  moderateReviewBody, createReplyBody, applauseToggleBody, createEntityBody, updateEntityBody,
} from "./shared.js";

export async function registerStoryCatalogRoutes(app: FastifyInstance, db: Db): Promise<void> {
  /**
   * Shared detail builder used by both id-or-slug and @handle/slug lookups.
   */
  async function buildDetail(
    s: typeof stories.$inferSelect,
    me: { id: string; role: Role } | null,
  ): Promise<StoryDetail> {
    const card = await toCard(db, s);
    const isAuthor = !!me && me.id === s.authorUserId;
    const isAdmin = !!me && (await hasPermission(me, "view_others_scriptorium_drafts", db));
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

    // Buy-to-Read gate state for THIS viewer. `locked` drives the reader's
    // sample-only view; `paywallBypassed` is true only when full access comes
    // SOLELY from the moderator permission (not owning/authoring/collab), so
    // the reader shows a warning banner.
    const access = await resolveReadAccess(db, s, me);
    const locked = !!s.buyToRead && !access.canReadFull;
    const paywallBypassed = !!s.buyToRead && access.canReadFull && access.hasBypass
      && !access.hasPurchased && !access.isTeam;

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
      copyPriceCustom: s.copyPrice ?? null,
      copyPriceDefault: (await getSettings(db)).earningConfig.scriptorium.copyPrice,
      locked,
      paywallBypassed,
      viewerHasPurchased: access.hasPurchased,
    };
  }

  /* ---------- Splash bookshelf (anonymous-safe) ----------
   *
   * Picks every public, non-draft, non-abandoned story regardless
   * of rating, including NC-17. The splash bookshelf renderer
   * paints the lock overlay + "Log in or register to read" hint
   * on NC-17 entries (same pattern as the catalog card tile), and
   * the body-open route returns the login-required private-stub
   * for NC-17 to anonymous viewers. The shelf is honest about what
   * exists; the access gate is at body-open time, not on the
   * cover thumbnail.
   */
  app.get<{ Querystring: { limit?: string } }>("/stories/splash", browseLimit, async (req) => {
    const limit = Math.min(24, Math.max(1, parseInt(req.query.limit ?? "12", 10) || 12));
    const rows = await db
      .select()
      .from(stories)
      .where(and(
        eq(stories.visibility, "public"),
        ne(stories.status, "draft"),
        ne(stories.status, "abandoned"),
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
  app.get<{ Querystring: Record<string, string | string[]> }>("/stories/catalog", browseLimit, async (req, reply) => {
    const me = await getSessionUser(req, db);
    const parsed = catalogQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid catalog query" };
    }
    const q = parsed.data;
    const { page, pageSize } = resolveOffsetPage(q);

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
    //     listing time.
    //   - Anonymous viewers ALSO see every rating, including NC-17,
    //     in the listing, the card-tile renderer paints a
    //     lock overlay + "Log in or register to read" hint on
    //     NC-17 entries, and the body-open route returns the
    //     login-required private-stub for NC-17 to anonymous.
    //     So the catalog is a catalog (honest about what exists);
    //     the access gate is the body, not the chip + thumbnail.
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
        conds.push(tagExcludes(stories.contentWarnings, cw));
      }
    }

    if (q.q && q.q.trim()) {
      const like = `%${escapeLike(q.q.trim()).toLowerCase()}%`;
      conds.push(or(
        sql`lower(${stories.title}) LIKE ${like} ESCAPE '\\'`,
        sql`lower(${stories.summary}) LIKE ${like} ESCAPE '\\'`,
        sql`lower(${stories.tags}) LIKE ${like} ESCAPE '\\'`,
      )!);
    }
    if (q.tag && q.tag.length > 0) {
      for (const t of q.tag) {
        conds.push(tagIncludes(stories.tags, t));
      }
    }
    if (q.exclude && q.exclude.length > 0) {
      for (const cw of q.exclude) {
        conds.push(tagExcludes(stories.contentWarnings, cw));
      }
    }

    const whereExpr = and(...conds);
    const total = await countRows(db, stories, whereExpr);

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

    // Buy-a-Copy state for the card tiles. Price + open/closed come from
    // config; ownership is a single batched lookup over THIS page's ids,
    // keyed on the buyer's master account (owner_user_id) so a copy bought
    // under any of the viewer's identities counts as owned. Anonymous
    // viewers get an empty set (no Buy button).
    const cfg = (await getSettings(db)).earningConfig.scriptorium;
    let ownedStoryIds: string[] = [];
    if (me && rows.length > 0) {
      const ownedRows = await db
        .select({ storyId: storyCopies.storyId })
        .from(storyCopies)
        .where(and(
          eq(storyCopies.ownerUserId, me.id),
          inArray(storyCopies.storyId, rows.map((r) => r.id)),
        ));
      ownedStoryIds = ownedRows.map((o) => o.storyId);
    }

    const payload: StoryCatalogPage = {
      ...offsetPageEnvelope({ entries, page, pageSize, total }),
      copyEnabled: cfg.enabled,
      ownedStoryIds,
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

    const slug = (body.slug ?? deriveSlug(body.title)).toLowerCase();
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
        copyPrice: body.copyPrice ?? null,
        buyToRead: body.buyToRead ? 1 : 0,
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
  app.get<{ Params: { idOrSlug: string } }>("/stories/:idOrSlug", browseLimit, async (req, reply) => {
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
    browseLimit,
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
    if (s.authorUserId !== me.id && !(await hasPermission(me, "edit_others_scriptorium_content", db))) {
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
    // null clears the custom price (revert to the site default); a number sets it.
    if (body.copyPrice !== undefined) update.copyPrice = body.copyPrice;
    if (body.buyToRead !== undefined) update.buyToRead = body.buyToRead ? 1 : 0;
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
    if (s.authorUserId !== me.id && !(await hasPermission(me, "admin_delete_story", db))) {
      reply.code(403);
      return { error: "not yours" };
    }
    await db.delete(stories).where(eq(stories.id, s.id));
    return { ok: true };
  });
}
