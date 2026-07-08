import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  StoryReport,
  StoryReportStatus,
  StoryReportTargetKind } from "@thekeep/shared";
import { hasPermission } from "../../auth/permissions.js";
import {
  stories,
  storyReports,
  users,
} from "../../db/schema.js";
import { getSessionUser } from "../auth.js";
import { recordAudit } from "../../audit.js";
import type { Db } from "../../db/index.js";
import type { Io } from "./shared.js";
import { viewerMayRead,
  captureReportSnapshot, revokeBookEarnings, ratingEnum,
} from "./shared.js";

export async function registerStoryReportRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /* ===================================================== *
   *  Reports (Phase 10)
   *
   *  Single-table moderation queue keyed by (targetKind, targetId).
   *  Filing is idempotent, second click silently no-ops thanks to
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
        // Likely the unique index, second-click silently no-ops.
        return { ok: true, alreadyReported: true };
      }
      reply.code(201);
      return { ok: true };
    },
  );

  /* ---------- Admin queue (Phase 10) ---------- */

  /**
   * Admin: list reports filtered by status / kind / story. Default sort
   * is open-first then newest. Cap at 100 per call, large queues should
   * paginate via the `before` cursor.
   */
  app.get<{ Querystring: { status?: string; targetKind?: string; storyId?: string; limit?: string } }>(
    "/admin/scriptorium/reports",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me || !(await hasPermission(me, "view_report_queue", db))) {
        reply.code(403);
        return { error: "forbidden", missing: "view_report_queue" };
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
      if (!me || !(await hasPermission(me, "resolve_reports", db))) {
        reply.code(403);
        return { error: "forbidden", missing: "resolve_reports" };
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
   * without a new admin review, that gate is enforced in the UI, not
   * here (the route accepts patches from authors too; admins set a
   * `force_locked` flag in a future iteration if we need hard lock).
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/admin/scriptorium/stories/:id/force-rate",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me || !(await hasPermission(me, "admin_force_story_rating", db))) {
        reply.code(403);
        return { error: "forbidden", missing: "admin_force_story_rating" };
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
  app.post<{ Params: { id: string }; Body: { note?: string; revokeEarnings?: boolean } }>(
    "/admin/scriptorium/stories/:id/hide",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me || !(await hasPermission(me, "admin_hide_story", db))) {
        reply.code(403);
        return { error: "forbidden", missing: "admin_hide_story" };
      }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      // Optional earnings claw-back for blatant rule-breaking (BEFORE the hide,
      // though the ledger isn't FK'd to the story so order is cosmetic).
      const revoked = req.body?.revokeEarnings ? await revokeBookEarnings(db, io, s) : { xp: 0, currency: 0 };
      await db
        .update(stories)
        .set({ visibility: "private", updatedAt: new Date() })
        .where(eq(stories.id, s.id));
      await recordAudit(db, {
        actorUserId: me.id,
        action: "story_admin_hide",
        reason: req.body?.note ?? null,
        metadata: { storyId: s.id, oldVisibility: s.visibility, revokedXp: revoked.xp, revokedCurrency: revoked.currency },
      });
      return { ok: true, revoked };
    },
  );

  /**
   * Admin: delete a story. Cascades to chapters / reviews / applause /
   * subscriptions / reports per the FK constraints. Hard delete.
   */
  app.delete<{ Params: { id: string }; Body: { note?: string; revokeEarnings?: boolean } }>(
    "/admin/scriptorium/stories/:id",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me || !(await hasPermission(me, "admin_delete_story", db))) {
        reply.code(403);
        return { error: "forbidden", missing: "admin_delete_story" };
      }
      const s = (await db.select().from(stories).where(eq(stories.id, req.params.id)).limit(1))[0];
      if (!s) { reply.code(404); return { error: "not found" }; }
      // Optional earnings claw-back: must run BEFORE the delete cascades, while
      // the author identity is still resolvable from the story row.
      const revoked = req.body?.revokeEarnings ? await revokeBookEarnings(db, io, s) : { xp: 0, currency: 0 };
      await db.delete(stories).where(eq(stories.id, s.id));
      await recordAudit(db, {
        actorUserId: me.id,
        action: "story_admin_delete",
        reason: req.body?.note ?? null,
        metadata: { storyId: s.id, storyTitle: s.title, authorUserId: s.authorUserId, revokedXp: revoked.xp, revokedCurrency: revoked.currency },
      });
      return { ok: true, revoked };
    },
  );
}
