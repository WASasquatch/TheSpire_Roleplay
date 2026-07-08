import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { WorldApplicationList, WorldApplicationStatus } from "@thekeep/shared";
import { hasPermission } from "../../auth/permissions.js";
import { worldApplications, worldMembers } from "../../db/schema.js";
import { getSessionUser } from "../auth.js";
import type { Db } from "../../db/index.js";
import {
  submitApplicationBody,
  reviewApplicationBody,
  resolveWorld,
  parseApplicationQuestions,
  applicationToWire,
  rebroadcastUserOccupancy,
} from "./shared.js";
import type { Io } from "./shared.js";

export async function registerWorldApplicationRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /* =========================================================
   *  Application routes, joinMode === "application" flow
   *
   *  POST   /worlds/:idOrSlug/applications       , applicant submits
   *  GET    /worlds/:idOrSlug/applications       , owner lists (pending + recent)
   *  PATCH  /worlds/:idOrSlug/applications/:appId, owner approves / rejects
   *  DELETE /worlds/:idOrSlug/applications/:appId, applicant withdraws their own
   * ========================================================= */

  // Applicant submits an application. Refused when:
  //   * world doesn't exist / viewer can't see it
  //   * world's joinMode isn't "application"
  //   * answers.length doesn't match the world's current question
  //     count (stale form / tampered request)
  //   * applicant already has a pending application on this world
  //   * applicant is already a member (use Leave first to re-join via app)
  //   * applicant is the world's owner (owners join via the Join button)
  app.post<{ Params: { idOrSlug: string }; Body: unknown }>(
    "/worlds/:idOrSlug/applications",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      if ((w.joinMode ?? "open") !== "application") {
        reply.code(400);
        return { error: "this world doesn't accept applications" };
      }
      if (w.ownerUserId === me.id) {
        reply.code(400);
        return { error: "owners don't apply to their own worlds" };
      }
      // Per-identity scope: the applying face is the caller's
      // currently-voiced character (or OOC if no character is
      // active). Other identities of the same master have their
      // own membership / application state, they don't block
      // this one and approving this one doesn't auto-join them.
      const applicantCharId = me.activeCharacterId;
      const identityMatch = applicantCharId === null
        ? sql`${worldMembers.characterId} IS NULL`
        : eq(worldMembers.characterId, applicantCharId);
      const alreadyMember = (await db
        .select({ userId: worldMembers.userId })
        .from(worldMembers)
        .where(and(
          eq(worldMembers.worldId, w.id),
          eq(worldMembers.userId, me.id),
          identityMatch,
        ))
        .limit(1))[0];
      if (alreadyMember) {
        reply.code(409);
        return { error: "you're already a member of this world (as this identity)" };
      }
      let body;
      try { body = submitApplicationBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const questions = parseApplicationQuestions(w.applicationQuestionsJson);
      if (body.answers.length !== questions.length) {
        reply.code(400);
        return {
          error: "answer count doesn't match the world's questions; reload the form",
        };
      }
      const appIdentityMatch = applicantCharId === null
        ? sql`${worldApplications.characterId} IS NULL`
        : eq(worldApplications.characterId, applicantCharId);
      // Single-pending guard PER IDENTITY, the partial unique index
      // enforces this at the DB layer too, but checking first lets
      // us return a friendlier 409 with the existing pending
      // application id.
      const existingPending = (await db
        .select()
        .from(worldApplications)
        .where(and(
          eq(worldApplications.worldId, w.id),
          eq(worldApplications.applicantUserId, me.id),
          appIdentityMatch,
          eq(worldApplications.status, "pending"),
        ))
        .limit(1))[0];
      if (existingPending) {
        reply.code(409);
        return {
          error: "you already have a pending application for this world (as this identity)",
          applicationId: existingPending.id,
        };
      }
      const appId = nanoid();
      try {
        await db.insert(worldApplications).values({
          id: appId,
          worldId: w.id,
          applicantUserId: me.id,
          characterId: applicantCharId,
          answersJson: JSON.stringify(body.answers.map((s) => s.trim())),
          status: "pending",
        });
      } catch (err) {
        // Two simultaneous submits can race past the pre-check above
        // and collide on the partial unique index. Convert the raw
        // SQLite error into the same friendly 409 the pre-check would
        // have returned, so the client never sees a 500.
        const msg = (err as { message?: string } | null)?.message ?? "";
        if (/UNIQUE constraint failed/i.test(msg)) {
          const existing = (await db
            .select({ id: worldApplications.id })
            .from(worldApplications)
            .where(and(
              eq(worldApplications.worldId, w.id),
              eq(worldApplications.applicantUserId, me.id),
              appIdentityMatch,
              eq(worldApplications.status, "pending"),
            ))
            .limit(1))[0];
          reply.code(409);
          return {
            error: "you already have a pending application for this world (as this identity)",
            applicationId: existing?.id,
          };
        }
        throw err;
      }
      const row = (await db
        .select()
        .from(worldApplications)
        .where(eq(worldApplications.id, appId))
        .limit(1))[0]!;
      const wire = await applicationToWire(db, row, questions);
      reply.code(201);
      return { ok: true, application: wire };
    },
  );

  // Owner lists pending applications + a small tail of recently-
  // terminal rows for spot-checking. Permission: world owner OR
  // edit_others_world (admin).
  app.get<{ Params: { idOrSlug: string } }>(
    "/worlds/:idOrSlug/applications",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      const isOwner = w.ownerUserId === me.id;
      const isAdmin = !isOwner && (await hasPermission(me, "edit_others_world", db));
      if (!isOwner && !isAdmin) { reply.code(403); return { error: "owner only" }; }
      const questions = parseApplicationQuestions(w.applicationQuestionsJson);
      const pendingRows = await db
        .select()
        .from(worldApplications)
        .where(and(
          eq(worldApplications.worldId, w.id),
          eq(worldApplications.status, "pending"),
        ))
        .orderBy(asc(worldApplications.submittedAt));
      const recentRows = await db
        .select()
        .from(worldApplications)
        .where(and(
          eq(worldApplications.worldId, w.id),
          ne(worldApplications.status, "pending"),
        ))
        .orderBy(desc(worldApplications.reviewedAt))
        .limit(20);
      const payload: WorldApplicationList = {
        pending: await Promise.all(pendingRows.map((r) => applicationToWire(db, r, questions))),
        recent: await Promise.all(recentRows.map((r) => applicationToWire(db, r, questions))),
      };
      return payload;
    },
  );

  // Owner approves or rejects an application. Approve auto-adds the
  // applicant to world_members in the same transaction; reject stamps
  // the optional review note and leaves the user free to re-apply.
  app.patch<{ Params: { idOrSlug: string; appId: string }; Body: unknown }>(
    "/worlds/:idOrSlug/applications/:appId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      const isOwner = w.ownerUserId === me.id;
      const isAdmin = !isOwner && (await hasPermission(me, "edit_others_world", db));
      if (!isOwner && !isAdmin) { reply.code(403); return { error: "owner only" }; }
      let body;
      try { body = reviewApplicationBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const app = (await db
        .select()
        .from(worldApplications)
        .where(and(
          eq(worldApplications.id, req.params.appId),
          eq(worldApplications.worldId, w.id),
        ))
        .limit(1))[0];
      if (!app) { reply.code(404); return { error: "application not found" }; }
      if (app.status !== "pending") {
        reply.code(409);
        return { error: `application already ${app.status}` };
      }
      const nextStatus: WorldApplicationStatus =
        body.action === "approve" ? "approved" : "rejected";
      // Approve = stamp the row AND insert the membership in one
      // transaction so a partial approve (status flipped but no
      // membership row) is impossible.
      //
      // The UPDATE's WHERE includes `status = 'pending'` so a
      // concurrent reviewer can't flip an already-decided row. We
      // detect a lost race via `changes === 0` and skip the
      // membership insert, otherwise a T1=approve / T2=reject race
      // could leave the applicant added as a member while the app
      // row reads "rejected." The pre-transaction check above is
      // still useful (early friendly 409 in the common case), but
      // the in-transaction guard is the actual safety net.
      let lostRace = false;
      db.transaction((tx) => {
        const updated = tx.update(worldApplications)
          .set({
            status: nextStatus,
            reviewedAt: new Date(),
            reviewedByUserId: me.id,
            reviewNote: body.reviewNote ?? null,
          })
          .where(and(
            eq(worldApplications.id, app.id),
            eq(worldApplications.status, "pending"),
          ))
          .run();
        if (updated.changes === 0) {
          lostRace = true;
          return;
        }
        if (nextStatus === "approved") {
          // Approval binds to the APPLYING IDENTITY: the membership
          // row carries the application's characterId (null = OOC).
          // Other identities of the same master are NOT auto-joined
          //, they have their own application paths.
          //
          // ON CONFLICT DO NOTHING, if the (world, user, identity)
          // membership row already exists (admin tooling seeded it,
          // or a parallel approve raced through), the status flip
          // above is the only side-effect we need. Drizzle doesn't
          // model expression-conflict targets, so we lean on the
          // unique index by passing the table-level columns; the
          // expression index does the actual NULL collapsing.
          tx.insert(worldMembers)
            .values({
              worldId: w.id,
              userId: app.applicantUserId,
              characterId: app.characterId,
            })
            .onConflictDoNothing()
            .run();
        }
      });
      if (lostRace) {
        // Re-read so the 409 carries the actual current status.
        const current = (await db
          .select({ status: worldApplications.status })
          .from(worldApplications)
          .where(eq(worldApplications.id, app.id))
          .limit(1))[0];
        reply.code(409);
        return { error: `application already ${current?.status ?? "decided"}` };
      }
      if (nextStatus === "approved") {
        await rebroadcastUserOccupancy(io, db, app.applicantUserId);
      }
      const refreshed = (await db
        .select()
        .from(worldApplications)
        .where(eq(worldApplications.id, app.id))
        .limit(1))[0]!;
      const wire = await applicationToWire(
        db,
        refreshed,
        parseApplicationQuestions(w.applicationQuestionsJson),
      );
      return { ok: true, application: wire };
    },
  );

  // Applicant withdraws their own pending application. Owners CANNOT
  // withdraw on behalf of an applicant, they reject instead (which
  // preserves the audit signal "owner declined" vs "applicant changed
  // their mind").
  app.delete<{ Params: { idOrSlug: string; appId: string } }>(
    "/worlds/:idOrSlug/applications/:appId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      const app = (await db
        .select()
        .from(worldApplications)
        .where(and(
          eq(worldApplications.id, req.params.appId),
          eq(worldApplications.worldId, w.id),
        ))
        .limit(1))[0];
      if (!app) { reply.code(404); return { error: "application not found" }; }
      if (app.applicantUserId !== me.id) {
        reply.code(403);
        return { error: "only the applicant can withdraw their application" };
      }
      if (app.status !== "pending") {
        reply.code(409);
        return { error: `application already ${app.status}` };
      }
      // Same race guard as approve/reject: only flip to "withdrawn"
      // when the row is still pending. Detects an owner who reviewed
      // between the user's pre-check and the actual write.
      const r = await db
        .update(worldApplications)
        .set({
          status: "withdrawn",
          reviewedAt: new Date(),
          reviewedByUserId: me.id,
        })
        .where(and(
          eq(worldApplications.id, app.id),
          eq(worldApplications.status, "pending"),
        ));
      if (r.changes === 0) {
        reply.code(409);
        return { error: "application was decided by the owner before you withdrew" };
      }
      return { ok: true };
    },
  );
}
