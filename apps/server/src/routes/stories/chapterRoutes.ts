import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  StoryChapterLockState,
  StoryChapterVersion,
  StoryReadingPosition } from "@thekeep/shared";
import {
  STORY_CHAPTER_CAP,
  STORY_CHAPTER_LOCK_LEASE_MS,
  countWords,
  serializeTagList,
} from "@thekeep/shared";
import { hasPermission } from "../../auth/permissions.js";
import {
  stories,
  storyChapterLocks,
  storyChapters,
  storyChapterVersions,
  storyReadingPositions,
} from "../../db/schema.js";
import { sanitizeBio, stripMarginNotes } from "../../auth/html.js";
import { getSessionUser } from "../auth.js";
import type { Db } from "../../db/index.js";
import type { Io } from "./shared.js";
import { chapterRowToFull, injectParagraphAnchors, viewerMayRead, buildChapterSample, resolveReadAccess, recountStoryTotals, recountStoryTotalsTx,
  appendChapterVersionTx, loadLockHolder, effectiveStoryPermissions, notifyPublish, awardChapterPublishReward,
  createChapterBody, updateChapterBody, upsertReadingPositionBody,
} from "./shared.js";

export async function registerStoryChapterRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
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
    const isAdmin = !!me && (await hasPermission(me, "view_others_scriptorium_drafts", db));
    // Collaborators with readDrafts (any active role) see drafts too.
    const perm = me ? await effectiveStoryPermissions(db, s, me.id, me.role) : null;
    const canSeeDrafts = isAuthor || isAdmin || (perm?.readDrafts ?? false);
    if (c.status !== "published" && !canSeeDrafts) {
      reply.code(404);
      return { error: "not found" };
    }
    const full = chapterRowToFull(c);
    if (canSeeDrafts) return full;

    // Buy-to-Read paywall — the SERVER-SIDE enforcement point. A locked viewer
    // (book is buyToRead and they don't own it / aren't team / lack the bypass
    // permission) gets a short sample of the FIRST published chapter and
    // nothing for the rest. We never ship the full body to be hidden by CSS.
    const readAccess = await resolveReadAccess(db, s, me ? { id: me.id, role: me.role } : null);
    if (s.buyToRead && !readAccess.canReadFull) {
      const firstPub = (await db
        .select({ id: storyChapters.id })
        .from(storyChapters)
        .where(and(eq(storyChapters.storyId, s.id), eq(storyChapters.status, "published")))
        .orderBy(asc(storyChapters.sortOrder))
        .limit(1))[0];
      if (firstPub?.id === c.id) {
        return {
          ...full,
          bodyHtml: buildChapterSample(stripMarginNotes(full.bodyHtml)),
          authorNotesHtml: "",
          sample: true,
        };
      }
      return { ...full, bodyHtml: "", authorNotesHtml: "", sample: true, locked: true };
    }

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

      // Pre-sanitize HTML outside the transaction, sanitize-html runs
      // a full parse and is the heaviest synchronous work on the path.
      // Keeping it outside means the write lock is held for the
      // minimum window (just the DB writes).
      const sanitizedBody = body.bodyHtml !== undefined ? sanitizeBio(body.bodyHtml) : undefined;
      const sanitizedNotes = body.authorNotesHtml !== undefined ? sanitizeBio(body.authorNotesHtml) : undefined;

      // Atomic write phase. Story status promotion, chapter UPDATE,
      // version append, and totals recount all commit or all roll back
      // together, a crash between any pair would otherwise leave the
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
          // Publishing is gated separately from editing, editors can
          // save changes but only co_authors / owners can flip the
          // chapter live.
          if (publishingNow && !perm.publish) {
            return { ok: false, status: 403, error: "you need co_author or owner access to publish a chapter" };
          }
          update.status = body.status;
          if (publishingNow) {
            update.publishedAt = new Date();
            // Strip margin notes on publish, collaborator-side
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

      // Publish event: fan out follower notifications + the author's writing
      // reward. Both are fire-and-forget so a notification / earning hiccup
      // never blocks the publish itself. Runs AFTER the transaction commits so
      // a failure can't roll back the actual publish (which is already durable).
      if (result.publishedNow) {
        void notifyPublish(db, io, s, result.updated, me.id).catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[scriptorium] notifyPublish failed", err);
        });
        void awardChapterPublishReward(db, io, s, result.updated).catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[scriptorium] awardChapterPublishReward failed", err);
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

      // A reader can't pin a position to a chapter outside this story,
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
        // Atomic increment, read-modify-write would under-count under
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
   *  Chapter soft-lock (Phase 5)
   *
   *  Advisory, "force edit" still saves; the lock just surfaces a
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
          // Caller's own lock, refresh the lease.
          await db
            .update(storyChapterLocks)
            .set({ lastRefreshAt: new Date() })
            .where(eq(storyChapterLocks.chapterId, c.id));
        } else if (expired) {
          // Stale holder, take over.
          await db
            .update(storyChapterLocks)
            .set({ userId: me.id, acquiredAt: new Date(), lastRefreshAt: new Date() })
            .where(eq(storyChapterLocks.chapterId, c.id));
        } else {
          // Active foreign holder, return their state without acquiring.
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
   * holder (foreign locks aren't releasable from this endpoint,
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
        // Lazy GC, scoped to the holder we just observed, otherwise a
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
}
