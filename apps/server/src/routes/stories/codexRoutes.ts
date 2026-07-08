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

export async function registerStoryCodexRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
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
    const isAdmin = !!me && (await hasPermission(me, "view_others_scriptorium_drafts", db));
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

      const slug = (body.slug ?? deriveSlug(body.name)).toLowerCase();
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
    if (!perm.readDrafts && s.authorUserId !== me.id
        && !(await hasPermission(me, "view_others_scriptorium_drafts", db))) {
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
            // Don't reset acceptedAt, an active collaborator's role
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
      // Idempotent, already accepted, return ok.
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
    // Already-accepted rows can also be declined here, that's just
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
}
