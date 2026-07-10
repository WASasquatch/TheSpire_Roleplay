/**
 * Forum-creation applications + membership applications.
 *
 *  "Create your Forum" (Phase 2):
 *    GET   /forums/slug-availability?slug=…       live form check
 *    POST  /forums/applications                    submit (apply_create_forum)
 *    GET   /forums/applications/mine               applicant's own history
 *    GET   /admin/forums/applications              review queue (view_admin_forums)
 *    PATCH /admin/forums/applications/:id          approve/reject (creates the forum)
 *
 *  Membership applications + open-forum join/leave (Phase 5):
 *    POST   /forums/:id/membership-applications        apply (one pending)
 *    DELETE /forums/:id/membership-applications/mine   withdraw
 *    GET    /forums/:id/membership-applications        owner + forum mods
 *    PATCH  /forums/:id/membership-applications/:appId approve / deny
 *    POST   /forums/:id/leave                          member walks away
 *    POST   /forums/:id/join                           self-join an OPEN forum
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  FORUM_MAX_OWNED_DEFAULT,
  FORUM_NAME_MAX,
  FORUM_NAME_MIN,
  FORUM_PURPOSE_MAX,
  FORUM_PURPOSE_MIN,
  FORUM_REAPPLY_COOLDOWN_DAYS,
  FORUM_SLUG_RE,
  RESERVED_FORUM_SLUGS,
  normalizeForumSlug,
} from "@thekeep/shared";
import type { ForumCreationApplicationWire } from "@thekeep/shared";
import {
  forumCreationApplications,
  forumMembers,
  forumMembershipApplications,
  forums,
  rooms,
  siteSettings,
  users,
} from "../../db/schema.js";
import type { Db } from "../../db/index.js";
import { getSessionUser } from "../auth.js";
import { hasPermission } from "../../auth/permissions.js";
import { forumAuthority } from "../../forums/authority.js";
import { seedForumStarter } from "../../forums/starter.js";
import { tFor } from "../../i18n.js";
import { requireForumPermission as sharedRequireForumPermission, type Io } from "./shared.js";

export async function registerForumApplicationRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  const requireForumPermission = (
    req: Parameters<typeof getSessionUser>[0],
    forumId: string,
    key: Parameters<typeof sharedRequireForumPermission>[3],
  ) => sharedRequireForumPermission(db, req, forumId, key);

  /* =========================================================
   *  "Create your Forum" applications (Phase 2)
   * ========================================================= */

  /** Why a slug is unusable, for the form's live feedback. */
  function slugProblem(raw: string): { ok: false; reason: "invalid" | "reserved" | "taken" | "pending" } | { ok: true; slug: string } {
    const trimmed = raw.trim().toLowerCase();
    if (!FORUM_SLUG_RE.test(trimmed)) return { ok: false, reason: "invalid" };
    if (RESERVED_FORUM_SLUGS.has(trimmed)) return { ok: false, reason: "reserved" };
    return { ok: true, slug: trimmed };
  }

  async function slugInUse(slug: string): Promise<"taken" | "pending" | null> {
    const existing = (await db.select({ id: forums.id }).from(forums)
      .where(sql`lower(${forums.slug}) = ${slug}`).limit(1))[0];
    if (existing) return "taken";
    const pending = (await db.select({ id: forumCreationApplications.id })
      .from(forumCreationApplications)
      .where(and(
        sql`lower(${forumCreationApplications.requestedSlug}) = ${slug}`,
        eq(forumCreationApplications.status, "pending"),
      )).limit(1))[0];
    return pending ? "pending" : null;
  }

  app.get<{ Querystring: { slug?: string } }>("/forums/slug-availability", async (req) => {
    const check = slugProblem(req.query.slug ?? "");
    if (!check.ok) return { ok: false, reason: check.reason };
    const used = await slugInUse(check.slug);
    return used ? { ok: false, reason: used } : { ok: true };
  });

  const toAppWire = async (rows: Array<typeof forumCreationApplications.$inferSelect>): Promise<ForumCreationApplicationWire[]> => {
    const userIds = [...new Set(rows.flatMap((r) => [r.applicantUserId, r.reviewedByUserId].filter((x): x is string => !!x)))];
    const names = userIds.length
      ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds))
      : [];
    const nameBy = new Map(names.map((n) => [n.id, n.username]));
    return rows.map((r) => ({
      id: r.id,
      applicantUserId: r.applicantUserId,
      applicantUsername: nameBy.get(r.applicantUserId) ?? "unknown",
      requestedName: r.requestedName,
      requestedSlug: r.requestedSlug,
      purpose: r.purpose,
      status: r.status,
      submittedAt: +r.submittedAt,
      reviewedAt: r.reviewedAt ? +r.reviewedAt : null,
      reviewedByUsername: r.reviewedByUserId ? nameBy.get(r.reviewedByUserId) ?? null : null,
      reviewNote: r.reviewNote ?? null,
    }));
  };

  const submitBody = z.object({
    name: z.string().trim().min(FORUM_NAME_MIN).max(FORUM_NAME_MAX),
    slug: z.string().trim().min(3).max(40),
    purpose: z.string().trim().min(FORUM_PURPOSE_MIN).max(FORUM_PURPOSE_MAX),
    /** Acceptance of the global "Create your Forum" registration rules.
     *  Only enforced when site_settings.forumRegistrationRulesHtml is set
     *  (migration 0301); empty rules impose no new requirement. */
    agreedToRules: z.boolean().optional(),
  }).strict();

  app.post<{ Body: unknown }>("/forums/applications", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "apply_create_forum", db))) {
      reply.code(403); return { error: tFor(me.locale, "errors:server.forums.applicationsNotAvailable") };
    }
    let body: z.infer<typeof submitBody>;
    try { body = submitBody.parse(req.body); }
    catch { reply.code(400); return { error: tFor(me.locale, "errors:server.applications.checkFields", { nameMin: FORUM_NAME_MIN, nameMax: FORUM_NAME_MAX, purposeMin: FORUM_PURPOSE_MIN, purposeMax: FORUM_PURPOSE_MAX }) }; }

    // Registration rules gate (migration 0301). When the global admin has set
    // forum-registration rules HTML, the applicant must tick "I agree" before
    // the application is accepted. Empty rules = no gate (back-compat).
    const rulesHtml = (await db.select({ html: siteSettings.forumRegistrationRulesHtml })
      .from(siteSettings).where(eq(siteSettings.id, "singleton")).limit(1))[0]?.html ?? "";
    const rulesActive = rulesHtml.trim().length > 0;
    if (rulesActive && body.agreedToRules !== true) {
      reply.code(400);
      return { error: tFor(me.locale, "errors:server.forums.agreeRules") };
    }

    const slug = normalizeForumSlug(body.slug);
    if (!slug) { reply.code(400); return { error: tFor(me.locale, "errors:server.applications.slugUnusable") }; }
    const used = await slugInUse(slug);
    if (used) { reply.code(409); return { error: used === "taken" ? tFor(me.locale, "errors:server.forums.slugTaken") : tFor(me.locale, "errors:server.forums.slugPendingClaim") }; }

    // One pending application per applicant (partial unique index backs this;
    // the pre-check keeps the error friendly).
    const pendingMine = (await db.select({ id: forumCreationApplications.id })
      .from(forumCreationApplications)
      .where(and(
        eq(forumCreationApplications.applicantUserId, me.id),
        eq(forumCreationApplications.status, "pending"),
      )).limit(1))[0];
    if (pendingMine) { reply.code(409); return { error: tFor(me.locale, "errors:server.applications.pendingReview") }; }

    // Rejection cooldown, so a declined applicant revises rather than spams.
    const lastRejected = (await db.select()
      .from(forumCreationApplications)
      .where(and(
        eq(forumCreationApplications.applicantUserId, me.id),
        eq(forumCreationApplications.status, "rejected"),
      ))
      .orderBy(desc(forumCreationApplications.reviewedAt))
      .limit(1))[0];
    if (lastRejected?.reviewedAt) {
      const elapsed = Date.now() - +lastRejected.reviewedAt;
      const cooldownMs = FORUM_REAPPLY_COOLDOWN_DAYS * 86_400_000;
      if (elapsed < cooldownMs) {
        const daysLeft = Math.ceil((cooldownMs - elapsed) / 86_400_000);
        reply.code(429);
        return { error: tFor(me.locale, "errors:server.applications.declinedRecently", { count: daysLeft }) };
      }
    }

    // Owned-forums ceiling (archived forums don't count against it).
    const owned = (await db.select({ n: sql<number>`count(*)` }).from(forums)
      .where(and(eq(forums.ownerUserId, me.id), sql`${forums.status} != 'archived'`)))[0]?.n ?? 0;
    if (owned >= FORUM_MAX_OWNED_DEFAULT) {
      reply.code(409);
      return { error: tFor(me.locale, "errors:server.forums.ownedLimit", { owned, limit: FORUM_MAX_OWNED_DEFAULT }) };
    }

    const id = nanoid();
    try {
      await db.insert(forumCreationApplications).values({
        id,
        applicantUserId: me.id,
        requestedName: body.name,
        requestedSlug: slug,
        purpose: body.purpose,
        // Stamp the acceptance time when the rules gate applied and was met.
        agreedAt: rulesActive ? new Date() : null,
      });
    } catch {
      // UNIQUE race on the partial pending index - same friendly 409.
      reply.code(409); return { error: tFor(me.locale, "errors:server.applications.pendingReview") };
    }
    const rows = await db.select().from(forumCreationApplications)
      .where(eq(forumCreationApplications.id, id)).limit(1);
    return { application: (await toAppWire(rows))[0] };
  });

  app.get("/forums/applications/mine", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const rows = await db.select().from(forumCreationApplications)
      .where(eq(forumCreationApplications.applicantUserId, me.id))
      .orderBy(desc(forumCreationApplications.submittedAt))
      .limit(10);
    return { applications: await toAppWire(rows) };
  });

  app.get("/admin/forums/applications", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "view_admin_forums", db))) {
      reply.code(403); return { error: "forbidden" };
    }
    const pending = await db.select().from(forumCreationApplications)
      .where(eq(forumCreationApplications.status, "pending"))
      .orderBy(forumCreationApplications.submittedAt);
    const recent = await db.select().from(forumCreationApplications)
      .where(sql`${forumCreationApplications.status} != 'pending'`)
      .orderBy(desc(forumCreationApplications.reviewedAt))
      .limit(20);
    return { pending: await toAppWire(pending), recent: await toAppWire(recent) };
  });

  const reviewBody = z.object({
    action: z.enum(["approve", "reject"]),
    reviewNote: z.string().trim().max(500).optional(),
  }).strict();

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/admin/forums/applications/:id",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      if (!(await hasPermission(me, "review_forum_applications", db))) {
        reply.code(403); return { error: "forbidden" };
      }
      let body: z.infer<typeof reviewBody>;
      try { body = reviewBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const appRow = (await db.select().from(forumCreationApplications)
        .where(eq(forumCreationApplications.id, req.params.id)).limit(1))[0];
      if (!appRow) { reply.code(404); return { error: "application not found" }; }
      if (appRow.status !== "pending") {
        reply.code(409); return { error: `application already ${appRow.status}` };
      }

      if (body.action === "approve") {
        // Re-validate at decision time: the world may have moved since
        // submission. Leaving the row PENDING on failure lets the reviewer
        // resolve (ask the applicant, or reject with a note).
        const slug = appRow.requestedSlug.toLowerCase();
        const taken = (await db.select({ id: forums.id }).from(forums)
          .where(sql`lower(${forums.slug}) = ${slug}`).limit(1))[0];
        if (taken) { reply.code(409); return { error: tFor(me.locale, "errors:server.forums.slugClaimedSince") }; }
        const owned = (await db.select({ n: sql<number>`count(*)` }).from(forums)
          .where(and(eq(forums.ownerUserId, appRow.applicantUserId), sql`${forums.status} != 'archived'`)))[0]?.n ?? 0;
        if (owned >= FORUM_MAX_OWNED_DEFAULT) {
          reply.code(409); return { error: tFor(me.locale, "errors:server.forums.applicantAtLimit") };
        }
      }

      const nextStatus = body.action === "approve" ? "approved" as const : "rejected" as const;
      const forumId = nanoid();
      // The General board needs a globally-unique room name (rooms_name_uq).
      // Slug-prefixed is collision-proof and rename-able later from the
      // owner console (Phase 3).
      const boardName = `${appRow.requestedSlug}_general`;
      const boardId = nanoid();
      let lostRace = false;
      let boardNameTaken = false;
      try {
      db.transaction((tx) => {
        const updated = tx.update(forumCreationApplications)
          .set({
            status: nextStatus,
            reviewedAt: new Date(),
            reviewedByUserId: me.id,
            reviewNote: body.reviewNote ?? null,
          })
          .where(and(
            eq(forumCreationApplications.id, appRow.id),
            eq(forumCreationApplications.status, "pending"),
          ))
          .run();
        if (updated.changes === 0) { lostRace = true; return; }
        if (nextStatus !== "approved") return;

        const nameClash = tx.select({ id: rooms.id }).from(rooms)
          .where(sql`lower(${rooms.name}) = ${boardName.toLowerCase()}`).limit(1).all()[0];
        if (nameClash) { boardNameTaken = true; throw new Error("rollback"); }

        // Forum + owner role + starter board + system welcome sticky, one
        // transaction so a half-created forum is impossible.
        tx.insert(forums).values({
          id: forumId,
          slug: appRow.requestedSlug,
          name: appRow.requestedName,
          tagline: appRow.purpose.length <= 200 ? appRow.purpose : `${appRow.purpose.slice(0, 197)}…`,
          ownerUserId: appRow.applicantUserId,
          isSystem: false,
          status: "active",
          visibility: "public",
          postingMode: "open",
        }).run();
        tx.insert(forumMembers).values({
          forumId,
          userId: appRow.applicantUserId,
          role: "owner",
        }).run();
        // Starter board + system welcome sticky, via the shared seeder so
        // the boot backfill (ensureForumStarterBoards) can't drift from
        // what approval provisions.
        seedForumStarter(tx, {
          forumId,
          forumName: appRow.requestedName,
          ownerUserId: appRow.applicantUserId,
          boardId,
          boardName,
        });
      });
      } catch (err) {
        // The board-name clash aborts via a sentinel throw so the whole
        // approve rolls back atomically; anything else is a real error.
        if (!boardNameTaken) throw err;
      }
      if (lostRace) {
        const current = (await db.select({ status: forumCreationApplications.status })
          .from(forumCreationApplications).where(eq(forumCreationApplications.id, appRow.id)).limit(1))[0];
        reply.code(409); return { error: `application already ${current?.status ?? "decided"}` };
      }
      if (boardNameTaken) {
        reply.code(409); return { error: tFor(me.locale, "errors:server.forums.boardNameClash") };
      }

      // Live toast to the applicant's open tabs (offline applicants see the
      // status in the Create-Forum modal next time). Localized to the
      // APPLICANT's saved language (transient per-recipient notice).
      try {
        const applicantLocale = (await db.select({ locale: users.locale })
          .from(users).where(eq(users.id, appRow.applicantUserId)).limit(1))[0]?.locale ?? null;
        const sockets = await io.fetchSockets();
        for (const s of sockets) {
          if ((s.data as { userId?: string }).userId !== appRow.applicantUserId) continue;
          s.emit("error:notice", nextStatus === "approved"
            ? { code: "FORUM_APP_APPROVED", message: tFor(applicantLocale, "errors:server.forums.appApproved", { name: appRow.requestedName }) }
            : { code: "FORUM_APP_REJECTED", message: body.reviewNote
                ? tFor(applicantLocale, "errors:server.forums.appDeclinedNote", { name: appRow.requestedName, note: body.reviewNote })
                : tFor(applicantLocale, "errors:server.forums.appDeclined", { name: appRow.requestedName }) });
        }
      } catch { /* notification is best-effort */ }

      const rows = await db.select().from(forumCreationApplications)
        .where(eq(forumCreationApplications.id, appRow.id)).limit(1);
      return { application: (await toAppWire(rows))[0] };
    },
  );

  /* =========================================================
   *  Phase 5: membership applications (postingMode = "application")
   * ========================================================= */

  const applyBody = z.object({
    answer: z.string().trim().max(500).optional(),
  }).strict();

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/forums/:id/membership-applications",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const a = await forumAuthority(db, me, req.params.id);
      if (!a.forum) { reply.code(404); return { error: "no forum" }; }
      // HARD age gate (age plan, Phase 3): the /f/ deep link deliberately
      // serves a minor the 18+ forum's teaser detail, but applying to a
      // forum they can never read is a dead end — refuse it plainly.
      if (a.forum.isNsfw && !me.isAdult) {
        reply.code(403); return { error: tFor(me.locale, "errors:server.forums.adultsOnly") };
      }
      if (a.forum.postingMode !== "application") {
        reply.code(409); return { error: tFor(me.locale, "errors:server.forums.openNoApplication") };
      }
      if (a.ban) { reply.code(403); return { error: tFor(me.locale, "errors:server.forums.banned") }; }
      if (a.isMember) { reply.code(409); return { error: tFor(me.locale, "errors:server.membership.alreadyMember") }; }
      let body: z.infer<typeof applyBody>;
      try { body = applyBody.parse(req.body ?? {}); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const pending = (await db.select({ id: forumMembershipApplications.id })
        .from(forumMembershipApplications)
        .where(and(
          eq(forumMembershipApplications.forumId, a.forum.id),
          eq(forumMembershipApplications.applicantUserId, me.id),
          eq(forumMembershipApplications.status, "pending"),
        )).limit(1))[0];
      if (pending) { reply.code(409); return { error: tFor(me.locale, "errors:server.applications.alreadyPending") }; }

      try {
        await db.insert(forumMembershipApplications).values({
          id: nanoid(),
          forumId: a.forum.id,
          applicantUserId: me.id,
          answer: body.answer?.trim() ? body.answer.trim() : null,
        });
      } catch {
        reply.code(409); return { error: tFor(me.locale, "errors:server.applications.alreadyPending") };
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/forums/:id/membership-applications/mine",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const updated = await db.update(forumMembershipApplications)
        .set({ status: "withdrawn", reviewedAt: new Date() })
        .where(and(
          eq(forumMembershipApplications.forumId, req.params.id),
          eq(forumMembershipApplications.applicantUserId, me.id),
          eq(forumMembershipApplications.status, "pending"),
        ));
      // better-sqlite3 driver surfaces changes on .run(); drizzle's await
      // path doesn't expose it portably — re-check instead.
      const still = (await db.select({ id: forumMembershipApplications.id })
        .from(forumMembershipApplications)
        .where(and(
          eq(forumMembershipApplications.forumId, req.params.id),
          eq(forumMembershipApplications.applicantUserId, me.id),
          eq(forumMembershipApplications.status, "pending"),
        )).limit(1))[0];
      void updated;
      if (still) { reply.code(500); return { error: "withdraw failed" }; }
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string } }>("/forums/:id/membership-applications", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "review_applications");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const wire = async (rows: Array<typeof forumMembershipApplications.$inferSelect>) => {
      const ids = [...new Set(rows.flatMap((r) => [r.applicantUserId, r.reviewedByUserId].filter((x): x is string => !!x)))];
      const names = ids.length
        ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ids))
        : [];
      const nameBy = new Map(names.map((n) => [n.id, n.username]));
      return rows.map((r) => ({
        id: r.id,
        forumId: r.forumId,
        applicantUserId: r.applicantUserId,
        applicantUsername: nameBy.get(r.applicantUserId) ?? "unknown",
        answer: r.answer ?? null,
        status: r.status,
        submittedAt: +r.submittedAt,
        reviewedAt: r.reviewedAt ? +r.reviewedAt : null,
        reviewedByUsername: r.reviewedByUserId ? nameBy.get(r.reviewedByUserId) ?? null : null,
        reviewNote: r.reviewNote ?? null,
      }));
    };
    const pending = await db.select().from(forumMembershipApplications)
      .where(and(eq(forumMembershipApplications.forumId, gate.forum.id), eq(forumMembershipApplications.status, "pending")))
      .orderBy(forumMembershipApplications.submittedAt);
    const recent = await db.select().from(forumMembershipApplications)
      .where(and(eq(forumMembershipApplications.forumId, gate.forum.id), sql`${forumMembershipApplications.status} != 'pending'`))
      .orderBy(desc(forumMembershipApplications.reviewedAt))
      .limit(20);
    return { pending: await wire(pending), recent: await wire(recent) };
  });

  const reviewMembershipBody = z.object({
    action: z.enum(["approve", "reject"]),
    reviewNote: z.string().trim().max(300).optional(),
  }).strict();

  app.patch<{ Params: { id: string; appId: string }; Body: unknown }>(
    "/forums/:id/membership-applications/:appId",
    async (req, reply) => {
      const gate = await requireForumPermission(req, req.params.id, "review_applications");
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      let body: z.infer<typeof reviewMembershipBody>;
      try { body = reviewMembershipBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const appRow = (await db.select().from(forumMembershipApplications)
        .where(and(
          eq(forumMembershipApplications.id, req.params.appId),
          eq(forumMembershipApplications.forumId, gate.forum.id),
        )).limit(1))[0];
      if (!appRow) { reply.code(404); return { error: "application not found" }; }
      if (appRow.status !== "pending") {
        reply.code(409); return { error: `application already ${appRow.status}` };
      }
      const nextStatus = body.action === "approve" ? "approved" as const : "rejected" as const;
      let lostRace = false;
      db.transaction((tx) => {
        const updated = tx.update(forumMembershipApplications)
          .set({
            status: nextStatus,
            reviewedAt: new Date(),
            reviewedByUserId: gate.me.id,
            reviewNote: body.reviewNote ?? null,
          })
          .where(and(
            eq(forumMembershipApplications.id, appRow.id),
            eq(forumMembershipApplications.status, "pending"),
          ))
          .run();
        if (updated.changes === 0) { lostRace = true; return; }
        if (nextStatus === "approved") {
          tx.insert(forumMembers)
            .values({ forumId: gate.forum.id, userId: appRow.applicantUserId, role: "member" })
            .onConflictDoNothing()
            .run();
        }
      });
      if (lostRace) {
        reply.code(409); return { error: "application was already decided" };
      }
      // Live nudge so an online applicant sees the verdict immediately.
      // Localized to the APPLICANT's saved language (transient per-recipient).
      try {
        const applicantLocale = (await db.select({ locale: users.locale })
          .from(users).where(eq(users.id, appRow.applicantUserId)).limit(1))[0]?.locale ?? null;
        const sockets = await io.fetchSockets();
        for (const s of sockets) {
          if ((s.data as { userId?: string }).userId !== appRow.applicantUserId) continue;
          s.emit("error:notice", nextStatus === "approved"
            ? { code: "FORUM_MEMBER_APPROVED", message: tFor(applicantLocale, "errors:server.forums.memberApproved", { name: gate.forum.name }) }
            : { code: "FORUM_MEMBER_REJECTED", message: body.reviewNote
                ? tFor(applicantLocale, "errors:server.forums.memberDeclinedNote", { name: gate.forum.name, note: body.reviewNote })
                : tFor(applicantLocale, "errors:server.forums.memberDeclined", { name: gate.forum.name }) });
        }
      } catch { /* best-effort */ }
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>("/forums/:id/leave", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const a = await forumAuthority(db, me, req.params.id);
    if (!a.forum) { reply.code(404); return { error: "no forum" }; }
    if (a.forum.ownerUserId === me.id) {
      reply.code(409); return { error: tFor(me.locale, "errors:server.forums.keeperCantLeave") };
    }
    if (!a.role) { reply.code(409); return { error: tFor(me.locale, "errors:server.membership.notMember") }; }
    await db.delete(forumMembers)
      .where(and(eq(forumMembers.forumId, a.forum.id), eq(forumMembers.userId, me.id)));
    return { ok: true };
  });

  /** Self-join an OPEN forum (instant, no review). Open forums need no
   *  membership to post in public sections, but a members-only CATEGORY
   *  inside one is readable/postable only by members — and the apply flow
   *  rejects open forums ("just post"), so there was no way in. This gives a
   *  one-click membership so a user can unlock those sections themselves.
   *  Application-mode forums still go through membership-applications; the
   *  system/default forum needs no join (everyone is an implicit member). */
  app.post<{ Params: { id: string } }>("/forums/:id/join", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const a = await forumAuthority(db, me, req.params.id);
    if (!a.forum) { reply.code(404); return { error: "no forum" }; }
    if (a.ban) { reply.code(403); return { error: tFor(me.locale, "errors:server.forums.banned") }; }
    if (a.forum.postingMode === "application") {
      reply.code(409); return { error: tFor(me.locale, "errors:server.forums.reviewsApplications") };
    }
    // Idempotent: owner/mods/existing members already have access.
    if (a.isMember) return { ok: true };
    await db.insert(forumMembers)
      .values({ forumId: a.forum.id, userId: me.id, role: "member" })
      .onConflictDoNothing();
    return { ok: true };
  });
}
