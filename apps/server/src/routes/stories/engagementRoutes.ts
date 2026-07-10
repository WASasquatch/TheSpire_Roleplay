import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNull, isNotNull, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  StoryApplauseState,
  StoryReview,
  StoryReviewPage,
  StorySubscriptionState } from "@thekeep/shared";
import {
  SFW_RATINGS,
  STORY_REVIEW_EDIT_GRACE_MS,
  startOfUtcDayMs,
} from "@thekeep/shared";
import { hasPermission } from "../../auth/permissions.js";
import {
  characterEarning,
  characters,
  storyCopies,
  userEarning,
  stories,
  storyApplause,
  storyChapters,
  storyReviewReplies,
  storyReviews,
  storySubscriptions,
} from "../../db/schema.js";
import { sanitizeBio } from "../../auth/html.js";
import { tFor } from "../../i18n.js";
import { getSessionUser } from "../auth.js";
import { creditPool } from "../../earning/award.js";
import { earnedTodayForCap } from "../../earning/dailyCap.js";
import { DEFAULT_SERVER_ID } from "../../earning/pool.js";
import { getSettings } from "../../settings.js";
import type { Db } from "../../db/index.js";
import type { Io } from "./shared.js";
import { toCard, viewerMayRead, isOwnIdentity, loadReviewer,
  recountStoryReviews, recountStoryApplause, reviewRowToWire, replyRowToWire, createReviewBody, updateReviewBody,
  moderateReviewBody, createReplyBody, applauseToggleBody,
} from "./shared.js";

export async function registerStoryEngagementRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /* ===================================================== *
   *  Applause (Phase 6)
   * ===================================================== */

  /**
   * Toggle applause for the caller on the given story (or specific
   * chapter when chapterId is in the body). Idempotent in both
   * directions: second call removes the row. Returns the post-toggle
   * total + viewer state.
   *
   * Author cannot see WHO applauded, only the rollup count.
   */
  app.post<{ Params: { id: string }; Body: unknown }>("/stories/:id/applause", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    if (!s.allowApplause) {
      reply.code(409);
      return { error: tFor(me.locale, "errors:server.stories.applauseDisabled") };
    }
    // Authors can't applaud their own work, mirrors the self-review
    // block and stops the rollup from being inflated by the creator.
    if (s.authorUserId === me.id) {
      reply.code(403);
      return { error: tFor(me.locale, "errors:server.stories.applaudOwn") };
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
      // Mirrors the read gate on the rest of the story surface, otherwise
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
   *  Buy a Copy — paid copies + profile Library showcase
   * ===================================================== */

  /** Resolve the caller's buying identity. A passed characterId must be the
   *  caller's own (and not deleted); otherwise the buy is the master pool. */
  async function resolveBuyerIdentity(
    me: { id: string },
    characterId: string | null | undefined,
  ): Promise<{ scope: "user" | "character"; ownerId: string } | null> {
    if (!characterId) return { scope: "user", ownerId: me.id };
    const ch = (await db
      .select({ id: characters.id })
      .from(characters)
      .where(and(eq(characters.id, characterId), eq(characters.userId, me.id), isNull(characters.deletedAt)))
      .limit(1))[0];
    if (!ch) return null;
    return { scope: "character", ownerId: characterId };
  }

  /** Current liquid currency for a pool (creditPool floors debits at 0, so a
   *  buy must pre-check funds here rather than rely on going negative). */
  async function poolCurrency(scope: "user" | "character", ownerId: string): Promise<number> {
    // Scriptorium copy purchases run over HTTP with no room context, so
    // the funds pre-check reads the default server's pool — the same
    // server the matching debit lands on (flag-off: the only pool,
    // byte-identical to today).
    if (scope === "user") {
      const r = (await db.select({ c: userEarning.currency }).from(userEarning).where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, ownerId))).limit(1))[0];
      return r?.c ?? 0;
    }
    const r = (await db.select({ c: characterEarning.currency }).from(characterEarning).where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, ownerId))).limit(1))[0];
    return r?.c ?? 0;
  }

  const copyIdentityBody = z.object({ characterId: z.string().nullable().optional() }).strict();
  const copyShowcaseBody = z.object({ characterId: z.string().nullable().optional(), shown: z.boolean() }).strict();

  /** Copy state for the reader's CTA. */
  app.get<{ Params: { id: string }; Querystring: { characterId?: string } }>(
    "/stories/:id/copy",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      const access = await viewerMayRead(s, me?.id ?? null, me?.role ?? null, db);
      if (!access.ok) { reply.code(403); return { error: "forbidden" }; }
      const cfg = (await getSettings(db)).earningConfig.scriptorium;
      const price = s.copyPrice ?? cfg.copyPrice;
      const isAuthor = !!me && me.id === s.authorUserId;
      const published = s.visibility === "public" && s.status !== "draft";
      let owned = false;
      let showcased = false;
      if (me) {
        const buyer = await resolveBuyerIdentity(me, req.query.characterId ?? null);
        if (buyer) {
          const copy = (await db.select({ slot: storyCopies.showcaseSlot }).from(storyCopies)
            .where(and(eq(storyCopies.ownerScope, buyer.scope), eq(storyCopies.ownerId, buyer.ownerId), eq(storyCopies.storyId, s.id))).limit(1))[0];
          owned = !!copy;
          showcased = !!copy && copy.slot != null;
        }
      }
      return { owned, showcased, isAuthor, price, canBuy: !!me && cfg.enabled && published && !isAuthor && !owned };
    },
  );

  /** Buy a copy: pre-check funds, insert the copy (one per identity), debit the
   *  buyer, then pay the author a per-day-capped royalty. */
  app.post<{ Params: { id: string }; Body: unknown }>("/stories/:id/copy", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body;
    try { body = copyIdentityBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    const access = await viewerMayRead(s, me.id, me.role, db);
    if (!access.ok) { reply.code(403); return { error: "forbidden" }; }
    if (s.visibility !== "public" || s.status === "draft") { reply.code(409); return { error: tFor(me.locale, "errors:server.stories.notPublished") }; }
    if (s.authorUserId === me.id) { reply.code(400); return { error: tFor(me.locale, "errors:server.stories.buyOwn") }; }
    const cfg = (await getSettings(db)).earningConfig.scriptorium;
    if (!cfg.enabled) { reply.code(409); return { error: tFor(me.locale, "errors:server.stories.shopClosed") }; }
    const price = s.copyPrice ?? cfg.copyPrice;

    const buyer = await resolveBuyerIdentity(me, body.characterId ?? null);
    if (!buyer) { reply.code(403); return { error: "not your character" }; }

    const already = (await db.select({ id: storyCopies.id }).from(storyCopies)
      .where(and(eq(storyCopies.ownerScope, buyer.scope), eq(storyCopies.ownerId, buyer.ownerId), eq(storyCopies.storyId, s.id))).limit(1))[0];
    if (already) { reply.code(409); return { error: tFor(me.locale, "errors:server.stories.alreadyOwnCopy") }; }

    const balance = await poolCurrency(buyer.scope, buyer.ownerId);
    if (balance < price) { reply.code(402); return { error: tFor(me.locale, "errors:server.common.notEnoughCurrency"), required: price, balance }; }

    const now = new Date();
    try {
      await db.insert(storyCopies).values({
        id: nanoid(), storyId: s.id, ownerScope: buyer.scope, ownerId: buyer.ownerId,
        ownerUserId: me.id, pricePaid: price, showcaseSlot: null, purchasedAt: now,
      });
    } catch { reply.code(409); return { error: tFor(me.locale, "errors:server.stories.alreadyOwnCopy") }; }

    if (price > 0) {
      await creditPool(db, io, {
        serverId: DEFAULT_SERVER_ID,
        scope: buyer.scope, ownerId: buyer.ownerId, xpDelta: 0, currencyDelta: -price,
        reason: "scriptorium_copy_purchase", metadata: { storyId: s.id, authorUserId: s.authorUserId }, notifyUserId: me.id,
      });
    }

    // Author royalty to the authoring identity, clamped by the per-day cap so a
    // buyer ring can't farm an author past the ceiling (buyers still pay full).
    const authorScope: "user" | "character" = s.authorCharacterId ? "character" : "user";
    const authorOwnerId = s.authorCharacterId ?? s.authorUserId;
    let royalty = Math.round(price * cfg.royaltyRate);
    if (royalty > 0 && cfg.dailyRoyaltyCap > 0) {
      const utcMidnight = startOfUtcDayMs(now.getTime());
      // Per-server cap scan: Scriptorium rewards stay GLOBAL (plan §9.6) — they
      // credit the default server (see the creditPool below), so the cap count
      // filters the SAME server. With the flag off this is the only pool, so the
      // count is byte-identical to today.
      const paid = earnedTodayForCap(db, {
        serverId: DEFAULT_SERVER_ID,
        scope: authorScope,
        ownerId: authorOwnerId,
        reason: { reason: "scriptorium_royalty" },
        sinceMs: utcMidnight,
      }).currency;
      royalty = Math.max(0, Math.min(royalty, cfg.dailyRoyaltyCap - Number(paid)));
    }
    if (royalty > 0) {
      await creditPool(db, io, {
        serverId: DEFAULT_SERVER_ID,
        scope: authorScope, ownerId: authorOwnerId, xpDelta: 0, currencyDelta: royalty,
        reason: "scriptorium_royalty", metadata: { storyId: s.id, buyerScope: buyer.scope }, notifyUserId: s.authorUserId,
      });
    }

    return { owned: true, price, royaltyPaid: royalty };
  });

  /** Pin / unpin an owned copy to the buyer's profile Library (opt-in display).
   *  `shown:true` appends to the next slot; `shown:false` clears it. */
  app.post<{ Params: { id: string }; Body: unknown }>("/stories/:id/copy/showcase", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body;
    try { body = copyShowcaseBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const buyer = await resolveBuyerIdentity(me, body.characterId ?? null);
    if (!buyer) { reply.code(403); return { error: "not your character" }; }
    const copy = (await db.select().from(storyCopies)
      .where(and(eq(storyCopies.ownerScope, buyer.scope), eq(storyCopies.ownerId, buyer.ownerId), eq(storyCopies.storyId, req.params.id))).limit(1))[0];
    if (!copy) { reply.code(404); return { error: tFor(me.locale, "errors:server.stories.dontOwnCopy") }; }
    let slot: number | null;
    if (!body.shown) {
      slot = null;
    } else if (copy.showcaseSlot != null) {
      slot = copy.showcaseSlot; // already shown
    } else {
      const maxRow = (await db.select({ m: sql<number>`COALESCE(MAX(${storyCopies.showcaseSlot}), -1)` })
        .from(storyCopies).where(and(
          eq(storyCopies.ownerScope, buyer.scope), eq(storyCopies.ownerId, buyer.ownerId), isNotNull(storyCopies.showcaseSlot),
        )))[0];
      slot = Number(maxRow?.m ?? -1) + 1;
    }
    await db.update(storyCopies).set({ showcaseSlot: slot }).where(eq(storyCopies.id, copy.id));
    return { shown: slot != null, slot };
  });
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
    const isAdmin = !!me && (await hasPermission(me, "edit_others_scriptorium_content", db));

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

    // Keep `total` aligned with what the viewer actually sees, the
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
      return { error: tFor(me.locale, "errors:server.stories.reviewsDisabled") };
    }
    if (s.authorUserId === me.id) {
      reply.code(403);
      return { error: tFor(me.locale, "errors:server.stories.reviewOwn") };
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
    if (dup) { reply.code(409); return { error: tFor(me.locale, "errors:server.stories.alreadyReviewed") }; }

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
   * grace, returns 409, the wire is honest: this isn't a quiet no-op.
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
      const canAdminEdit = await hasPermission(me, "edit_others_scriptorium_content", db);
      if (r.reviewerUserId !== me.id && !canAdminEdit) {
        reply.code(403);
        return { error: "not yours" };
      }
      if (!canAdminEdit) {
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
    if (r.reviewerUserId !== me.id && !(await hasPermission(me, "edit_others_scriptorium_content", db))) {
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
      if (s.authorUserId !== me.id && !(await hasPermission(me, "edit_others_scriptorium_content", db))) {
        reply.code(403);
        return { error: tFor(me.locale, "errors:server.stories.moderateReviewsAuthorOnly") };
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
        // Only one pinned review per story, clear any previous pin.
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
   * Reply to a review. The chain is one level deep, replies to
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
        return { error: tFor(me.locale, "errors:server.stories.reviewsDisabled") };
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
      if (r.replyerUserId !== me.id && !(await hasPermission(me, "edit_others_scriptorium_content", db))) {
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
   * Toggle follow on a story. POST is idempotent in both directions,
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

      const existing = (await db
        .select()
        .from(storySubscriptions)
        .where(and(eq(storySubscriptions.storyId, s.id), eq(storySubscriptions.userId, me.id)))
        .limit(1))[0];

      // FOLLOWING requires read access; UNFOLLOWING never does. Deleting
      // your own subscription row must stay possible after the story moves
      // out of your reach (re-rated adult while you're a minor, visibility
      // flipped) — otherwise the stale entry is stuck in your Following
      // list with no way to clear it until the gate would let you back in.
      if (!existing) {
        const access = await viewerMayRead(s, me.id, me.role, db);
        if (!access.ok) { reply.code(403); return { error: "forbidden" }; }
      }

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
      // settings any further, same gate the POST already enforces.
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
  app.get("/me/stories/following", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const rows = await db
      .select({ story: stories, sub: storySubscriptions })
      .from(storySubscriptions)
      .innerJoin(stories, eq(stories.id, storySubscriptions.storyId))
      .where(and(
        eq(storySubscriptions.userId, me.id),
        // HARD age clamp (age plan, Phase 4): a subscription whose story was
        // re-rated adult AFTER the follow must not keep serving its card
        // (title, summary, cover, rating) to a minor — the same staleness
        // case notifyPublish filters on the publish fan-out. The row itself
        // is kept (keep-but-hide; it reappears at 18), and the unfollow
        // branch of POST /stories/:id/follow works without read access so
        // the minor can still clear it by id.
        ...(me.isAdult ? [] : [inArray(stories.rating, [...SFW_RATINGS])]),
      ))
      .orderBy(desc(storySubscriptions.subscribedAt))
      .limit(100);
    const cards = await Promise.all(rows.map((r) => toCard(db, r.story, me)));
    return { stories: cards };
  });
}
