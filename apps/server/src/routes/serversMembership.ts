/**
 * serversMembership - creation applications, join / leave / favorite / visit,
 * /s slug + public landing resolution, and the membership-application flow.
 * Move-only extraction from registerServerRoutes.
 */
import {
  RESERVED_SERVER_SLUGS,
  SERVER_MAX_OWNED_DEFAULT,
  SERVER_NAME_MAX,
  SERVER_NAME_MIN,
  SERVER_PURPOSE_MAX,
  SERVER_PURPOSE_MIN,
  SERVER_REAPPLY_COOLDOWN_DAYS,
  SERVER_SLUG_RE,
  normalizeServerSlug,
} from "@thekeep/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  rooms,
  serverCreationApplications,
  serverInvites,
  serverMembers,
  serverMembershipApplications,
  serverVisits,
  servers,
  siteSettings,
  users,
} from "../db/schema.js";
import { hasPermission } from "../auth/permissions.js";
import { serverAuthority } from "../servers/authority.js";
import { isServerModerationActive, serverModerationNotice } from "../servers/moderation.js";
import { notifyUser, emitServersChanged } from "../servers/notifications.js";
import {
  emitTreeChanged,
  findServerLanding,
} from "../realtime/broadcast.js";
import { tFor } from "../i18n.js";
import { getSessionUser } from "./auth.js";
import {
  auditServer,
} from "./serversShared.js";
import type { ServerRoutesCtx } from "./serversShared.js";

export function registerServerMembershipRoutes(ctx: ServerRoutesCtx): void {
  const { app, db, io, serversLive, requireServerOwner, requireServerPermission, resolveServerTarget, writeServerImage, unlinkServerImage } = ctx;

  /* =========================================================
   *  "Register your Server" creation applications
   * ========================================================= */

  function slugProblem(raw: string): { ok: false; reason: "invalid" | "reserved" } | { ok: true; slug: string } {
    const trimmed = raw.trim().toLowerCase();
    if (!SERVER_SLUG_RE.test(trimmed)) return { ok: false, reason: "invalid" };
    if (RESERVED_SERVER_SLUGS.has(trimmed)) return { ok: false, reason: "reserved" };
    return { ok: true, slug: trimmed };
  }

  async function slugInUse(slug: string): Promise<"taken" | "pending" | null> {
    const existing = (await db.select({ id: servers.id }).from(servers)
      .where(sql`lower(${servers.slug}) = ${slug}`).limit(1))[0];
    if (existing) return "taken";
    const pending = (await db.select({ id: serverCreationApplications.id })
      .from(serverCreationApplications)
      .where(and(
        sql`lower(${serverCreationApplications.requestedSlug}) = ${slug}`,
        eq(serverCreationApplications.status, "pending"),
      )).limit(1))[0];
    return pending ? "pending" : null;
  }

  app.get<{ Querystring: { slug?: string } }>("/servers/slug-availability", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const check = slugProblem(req.query.slug ?? "");
    if (!check.ok) return { ok: false, reason: check.reason };
    const used = await slugInUse(check.slug);
    return used ? { ok: false, reason: used } : { ok: true };
  });

  const toAppWire = async (rows: Array<typeof serverCreationApplications.$inferSelect>) => {
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
    requestedName: z.string().trim().min(SERVER_NAME_MIN).max(SERVER_NAME_MAX),
    requestedSlug: z.string().trim().min(3).max(40),
    purpose: z.string().trim().min(SERVER_PURPOSE_MIN).max(SERVER_PURPOSE_MAX),
    /** "I agree to the registration rules" — required (true) only when the
     *  admin has authored non-empty serverRegistrationRulesHtml (migration
     *  0301). Optional in the schema for back-compat; enforced in the handler. */
    agreedToRules: z.boolean().optional(),
  }).strict();

  app.post<{ Body: unknown }>("/servers/applications", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "apply_create_server", db))) {
      reply.code(403); return { error: tFor(me.locale, "errors:server.servers.applicationsNotAvailable") };
    }
    let body: z.infer<typeof submitBody>;
    try { body = submitBody.parse(req.body); }
    catch { reply.code(400); return { error: tFor(me.locale, "errors:server.applications.checkFields", { nameMin: SERVER_NAME_MIN, nameMax: SERVER_NAME_MAX, purposeMin: SERVER_PURPOSE_MIN, purposeMax: SERVER_PURPOSE_MAX }) }; }

    // Registration-rules agreement gate (migration 0301). When the admin has
    // authored non-empty serverRegistrationRulesHtml, the applicant must tick
    // "I agree" (agreedToRules === true); we then stamp agreedAt on the row.
    // Empty rules ⇒ no new requirement (back-compat). Read the column straight
    // off the site_settings singleton — getSettings' typed shape doesn't carry
    // it yet (a sibling track owns that surface).
    const rulesHtml = (await db.select({ html: siteSettings.serverRegistrationRulesHtml })
      .from(siteSettings).where(eq(siteSettings.id, "singleton")).limit(1))[0]?.html ?? "";
    const rulesInForce = rulesHtml.trim().length > 0;
    if (rulesInForce && body.agreedToRules !== true) {
      reply.code(400); return { error: tFor(me.locale, "errors:server.servers.agreeRules") };
    }

    const slug = normalizeServerSlug(body.requestedSlug);
    if (!slug) { reply.code(400); return { error: tFor(me.locale, "errors:server.applications.slugUnusable") }; }
    const used = await slugInUse(slug);
    if (used) { reply.code(409); return { error: used === "taken" ? tFor(me.locale, "errors:server.servers.slugTaken") : tFor(me.locale, "errors:server.servers.slugPendingClaim") }; }

    const pendingMine = (await db.select({ id: serverCreationApplications.id })
      .from(serverCreationApplications)
      .where(and(
        eq(serverCreationApplications.applicantUserId, me.id),
        eq(serverCreationApplications.status, "pending"),
      )).limit(1))[0];
    if (pendingMine) { reply.code(409); return { error: tFor(me.locale, "errors:server.applications.pendingReview") }; }

    const lastRejected = (await db.select()
      .from(serverCreationApplications)
      .where(and(
        eq(serverCreationApplications.applicantUserId, me.id),
        eq(serverCreationApplications.status, "rejected"),
      ))
      .orderBy(desc(serverCreationApplications.reviewedAt))
      .limit(1))[0];
    if (lastRejected?.reviewedAt) {
      const elapsed = Date.now() - +lastRejected.reviewedAt;
      const cooldownMs = SERVER_REAPPLY_COOLDOWN_DAYS * 86_400_000;
      if (elapsed < cooldownMs) {
        const daysLeft = Math.ceil((cooldownMs - elapsed) / 86_400_000);
        reply.code(429);
        return { error: tFor(me.locale, "errors:server.applications.declinedRecently", { count: daysLeft }) };
      }
    }

    const owned = (await db.select({ n: sql<number>`count(*)` }).from(servers)
      .where(and(eq(servers.ownerUserId, me.id), sql`${servers.status} != 'archived'`, eq(servers.isSystem, false))))[0]?.n ?? 0;
    if (owned >= SERVER_MAX_OWNED_DEFAULT) {
      reply.code(409);
      return { error: tFor(me.locale, "errors:server.servers.ownedLimit", { owned, limit: SERVER_MAX_OWNED_DEFAULT }) };
    }

    const id = nanoid();
    try {
      await db.insert(serverCreationApplications).values({
        id,
        applicantUserId: me.id,
        requestedName: body.requestedName,
        requestedSlug: slug,
        purpose: body.purpose,
        // Record the moment of agreement only when rules were actually in force
        // at submit; NULL otherwise (legacy / no gate).
        agreedAt: rulesInForce ? new Date() : null,
      });
    } catch {
      reply.code(409); return { error: tFor(me.locale, "errors:server.applications.pendingReview") };
    }
    const rows = await db.select().from(serverCreationApplications)
      .where(eq(serverCreationApplications.id, id)).limit(1);
    return { application: (await toAppWire(rows))[0] };
  });

  app.get("/servers/applications/mine", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const rows = await db.select().from(serverCreationApplications)
      .where(eq(serverCreationApplications.applicantUserId, me.id))
      .orderBy(desc(serverCreationApplications.submittedAt))
      .limit(10);
    return { applications: await toAppWire(rows) };
  });

  /* =========================================================
   *  Join / leave / visit
   * ========================================================= */

  const joinInviteBody = z.object({ code: z.string().trim().min(1).max(64) }).strict();

  /** Self-join an OPEN server (instant), or an INVITE-mode server when the body
   *  carries a valid invite code (mirrors room-invite redemption). Application-
   *  mode goes through the membership-applications flow; the system/default
   *  server needs no join (implicit membership). */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/join", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const a = await serverAuthority(db, me, req.params.id);
    if (!a.server) { reply.code(404); return { error: "no server" }; }
    if (a.ban) { reply.code(403); return { error: tFor(me.locale, "errors:server.servers.banned") }; }
    // HARD age gate (age plan, Phase 2): an 18+ community accepts no minor
    // members. A clear refusal (not a 404) so a shared join link fails
    // comprehensibly — decision #3.
    if (a.server.isNsfw && !me.isAdult) {
      reply.code(403); return { error: tFor(me.locale, "errors:server.servers.adultsOnly"), code: "AGE_RESTRICTED" };
    }
    // A suspended/banned server accepts no new members (only owner/staff may
    // touch it while it's under moderation). Blocks the "membership accrues on
    // a frozen server" gap; expired bans read as inactive so this no-ops.
    if (isServerModerationActive(a.server) && !a.isMod) {
      const notice = serverModerationNotice(a.server);
      reply.code(403); return { error: notice?.message ?? tFor(me.locale, "errors:server.servers.unavailable"), code: notice?.code ?? null };
    }
    if (a.server.joinMode === "application") {
      reply.code(409); return { error: tFor(me.locale, "errors:server.servers.reviewsApplications") };
    }
    if (a.server.joinMode === "invite") {
      if (a.role) return { ok: true }; // already enrolled (idempotent)
      let body: z.infer<typeof joinInviteBody>;
      try { body = joinInviteBody.parse(req.body ?? {}); }
      catch { reply.code(400); return { error: tFor(me.locale, "errors:server.servers.inviteRequired") }; }
      const code = body.code.trim();
      // Validate: matches THIS server, live (not revoked/expired), under cap.
      // Claim the use inside a transaction so concurrent redemptions can't blow
      // past max_uses (the conditional UPDATE is the atomic gate).
      const invite = (await db.select().from(serverInvites)
        .where(and(eq(serverInvites.serverId, a.server.id), eq(serverInvites.code, code))).limit(1))[0];
      if (!invite) { reply.code(404); return { error: tFor(me.locale, "errors:server.servers.inviteInvalid") }; }
      if (invite.revokedAt) { reply.code(409); return { error: tFor(me.locale, "errors:server.servers.inviteRevoked") }; }
      if (invite.expiresAt && +invite.expiresAt <= Date.now()) {
        reply.code(409); return { error: tFor(me.locale, "errors:server.servers.inviteExpired") };
      }
      if (invite.maxUses != null && invite.usedCount >= invite.maxUses) {
        reply.code(409); return { error: tFor(me.locale, "errors:server.servers.inviteUseLimit") };
      }
      let claimed = false;
      db.transaction((tx) => {
        // Atomic claim: bump used_count only while still live + under cap.
        const claim = tx.update(serverInvites)
          .set({ usedCount: sql`${serverInvites.usedCount} + 1` })
          .where(and(
            eq(serverInvites.id, invite.id),
            isNull(serverInvites.revokedAt),
            sql`(${serverInvites.maxUses} is null or ${serverInvites.usedCount} < ${serverInvites.maxUses})`,
            sql`(${serverInvites.expiresAt} is null or ${serverInvites.expiresAt} > ${Date.now()})`,
          ))
          .run();
        if (claim.changes === 0) return;
        claimed = true;
        tx.insert(serverMembers)
          .values({ serverId: a.server!.id, userId: me.id, role: "member" })
          .onConflictDoNothing()
          .run();
      });
      if (!claimed) { reply.code(409); return { error: tFor(me.locale, "errors:server.servers.inviteUnusable") }; }
      return { ok: true };
    }
    if (a.role) return { ok: true }; // already enrolled (idempotent)
    await db.insert(serverMembers)
      .values({ serverId: a.server.id, userId: me.id, role: "member" })
      .onConflictDoNothing();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/servers/:id/leave", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const a = await serverAuthority(db, me, req.params.id);
    if (!a.server) { reply.code(404); return { error: "no server" }; }
    if (a.server.ownerUserId === me.id) {
      reply.code(409); return { error: tFor(me.locale, "errors:server.servers.ownerCantLeave") };
    }
    if (a.server.isSystem) {
      reply.code(409); return { error: tFor(me.locale, "errors:server.servers.cantLeaveHome") };
    }
    if (!a.role) { reply.code(409); return { error: tFor(me.locale, "errors:server.membership.notMember") }; }
    await db.delete(serverMembers)
      .where(and(eq(serverMembers.serverId, a.server.id), eq(serverMembers.userId, me.id)));
    return { ok: true };
  });

  /* =========================================================
   *  Favorite / default server (the caller's own preference)
   *
   *  Sets `users.default_server_id` — the server whose per-server identity a
   *  GLOBAL profile view of the caller reflects (collection / pet collection /
   *  equipped name style / banner / flair), resolved by resolveProfileServerId.
   *  Also the rail's home-server preference + the off-room earning anchor.
   *  Self-service: a caller only ever sets/clears their OWN favorite, and only
   *  to a server they belong to.
   * ========================================================= */

  /** POST /servers/:id/favorite — mark this server as the caller's favorite /
   *  default. Must be a server they're a member of (the system server counts as
   *  implicit membership). Idempotent. */
  app.post<{ Params: { id: string } }>("/servers/:id/favorite", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const a = await serverAuthority(db, me, req.params.id);
    if (!a.server) { reply.code(404); return { error: "no server" }; }
    // Only a server you belong to can be your default — otherwise the profile
    // would anchor to a server you have no identity on. isMember folds in the
    // owner short-circuit + the system server's implicit membership.
    if (!a.isMember) { reply.code(403); return { error: tFor(me.locale, "errors:server.servers.defaultMustBelong") }; }
    await db.update(users).set({ defaultServerId: a.server.id }).where(eq(users.id, me.id));
    await auditServer(db, {
      serverId: a.server.id, actorUserId: me.id, action: "server_favorite_set",
      metadata: { slug: a.server.slug },
    });
    return { ok: true, defaultServerId: a.server.id };
  });

  /** DELETE /servers/:id/favorite — clear the caller's favorite back to NULL
   *  (the profile then falls back to the system server). The :id is advisory —
   *  we clear regardless, so a stale id still lets the user reset. */
  app.delete<{ Params: { id: string } }>("/servers/:id/favorite", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    await db.update(users).set({ defaultServerId: null }).where(eq(users.id, me.id));
    await auditServer(db, {
      serverId: req.params.id, actorUserId: me.id, action: "server_favorite_clear",
      metadata: {},
    });
    return { ok: true, defaultServerId: null };
  });

  /** Stamp "viewer looked at this server now" — clears the rail's unseen dot. */
  app.post<{ Params: { id: string } }>("/servers/:id/visit", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    // A moderated server (suspended, or banned with an unexpired until) is
    // enterable ONLY by the people who can fix it: the owner, the owner's
    // admins/mods (a.isMod folds owner + staff via isOwner), and global staff.
    // Everyone else gets a 403 carrying the confirmed user-facing notice. A ban
    // past its until reads as 'none' (isServerModerationActive returns false),
    // so this whole block no-ops and the visit proceeds — lazy expiry, no cron.
    const a = await serverAuthority(db, me, req.params.id);
    if (a.server && isServerModerationActive(a.server) && !a.isMod) {
      const notice = serverModerationNotice(a.server);
      reply.code(403);
      return { error: notice?.message ?? tFor(me.locale, "errors:server.servers.unavailable"), code: notice?.code ?? null };
    }
    // HARD age gate: minors can't even "visit" an 18+ community (the visit
    // stamp + landing handoff is how the rail enters it).
    if (a.server?.isNsfw && !me.isAdult) {
      reply.code(403);
      return { error: tFor(me.locale, "errors:server.servers.adultsOnly"), code: "AGE_RESTRICTED" };
    }
    const now = new Date();
    await db.insert(serverVisits)
      .values({ userId: me.id, serverId: req.params.id, lastVisitAt: now })
      .onConflictDoUpdate({
        target: [serverVisits.userId, serverVisits.serverId],
        set: { lastVisitAt: now },
      });
    // Hand back the server's landing room so the client can navigate there on
    // an icon click (the web rail's onServerSelect consumes `landingRoomId`).
    const landing = await findServerLanding(db, req.params.id);
    // FRONT-DOOR HEAL: a parked (auto-archived) default room made the whole
    // server unenterable — the join 404'd the archived id and bounced every
    // visitor (global staff included) back to the home server. The default
    // room is the server's structure, so revive it in place for anyone who
    // passed the gates above; new servers seed it `persistent` and the sweep
    // now skips `isDefault`, so this is the lazy repair for pre-fix rows.
    if (landing?.archivedAt) {
      await db
        .update(rooms)
        .set({ archivedAt: null, archiveHiddenAt: null })
        .where(eq(rooms.id, landing.id));
      emitTreeChanged(io, req.params.id);
    }
    return { ok: true, landingRoomId: landing?.id ?? null };
  });

  /**
   * Resolve a `/s/<slug>` share link to a server the viewer may actually open.
   * Backs the SPA's `/s/:slug` deep-link (and push-notification deep-links).
   *
   * Visibility-preserving: the id is revealed only to someone who can
   * participate — a member, anyone on an open server, or global staff holding
   * `manage_any_server` (owner-equivalent in the authority check). For everyone
   * else a private / invite-only server stays a 404 so the slug's existence
   * isn't disclosed. The client then enters via the normal /visit + room-join
   * path (which re-checks the same `canParticipate` gate).
   */
  app.get<{ Params: { slug: string } }>("/servers/by-slug/:slug", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const slug = req.params.slug.trim().toLowerCase();
    const server = (await db.select({ id: servers.id, name: servers.name })
      .from(servers).where(eq(servers.slug, slug)).limit(1))[0];
    if (!server) { reply.code(404); return { error: "not found" }; }
    const a = await serverAuthority(db, me, server.id);
    if (!a.canParticipate) { reply.code(404); return { error: "not found" }; }
    return { id: server.id, name: server.name };
  });

  /** GET /servers/public/:slug — ANONYMOUS public landing data for a community,
   *  the shareable face of `/s/<slug>` for logged-out visitors (mirrors the
   *  forum public landing). PUBLIC, non-archived, non-moderated servers only
   *  (same gate as discover + the per-route SEO): a private / unlisted / invite-
   *  only / suspended / banned server 404s so its existence isn't leaked. No
   *  auth, no viewer state; the client renders identity + a join/login CTA. */
  app.get<{ Params: { slug: string } }>("/servers/public/:slug", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const slug = req.params.slug.trim().toLowerCase();
    const s = (await db
      .select({
        id: servers.id,
        name: servers.name,
        tagline: servers.tagline,
        descriptionHtml: servers.descriptionHtml,
        bannerImageUrl: servers.bannerImageUrl,
        bannerFocusY: servers.bannerFocusY,
        logoUrl: servers.logoUrl,
        iconColor: servers.iconColor,
        ownerUserId: servers.ownerUserId,
        isSystem: servers.isSystem,
        status: servers.status,
        visibility: servers.visibility,
        joinMode: servers.joinMode,
        moderationState: servers.moderationState,
        moderationUntil: servers.moderationUntil,
        themeJson: servers.themeJson,
        themeStyleKey: servers.themeStyleKey,
        createdAt: servers.createdAt,
        isNsfw: servers.isNsfw,
        sfwBannerUrl: servers.sfwBannerUrl,
      })
      .from(servers)
      .where(eq(servers.slug, slug))
      .limit(1))[0];
    const moderated = !!s && (s.moderationState === "suspended"
      || (s.moderationState === "banned"
          && (!s.moderationUntil || +s.moderationUntil > Date.now())));
    if (!s || s.visibility !== "public" || s.status === "archived" || moderated) {
      reply.code(404); return { error: "not found" };
    }
    const owner = (await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, s.ownerUserId))
      .limit(1))[0];
    // System server is implicit-membership (no explicit rows) — count the whole
    // registered base, matching /servers/popular. Others count their members.
    const memberCount = s.isSystem
      ? Number((await db.select({ n: sql<number>`count(*)` }).from(users).where(isNull(users.disabledAt)))[0]?.n ?? 0)
      : Number((await db.select({ n: sql<number>`count(*)` }).from(serverMembers).where(eq(serverMembers.serverId, s.id)))[0]?.n ?? 0);
    return {
      slug,
      name: s.name,
      tagline: s.tagline,
      descriptionHtml: s.descriptionHtml,
      // Public-safe branding (age plan, decision #10): this landing is
      // ANONYMOUS, and anonymous can never see NSFW — an 18+ community's
      // share page shows its public-safe banner, or no banner art at all
      // (the client falls back to name + colors). Name/tagline stay: the
      // page exists so shared links fail comprehensibly, with a join CTA
      // the join route will still age-gate.
      bannerImageUrl: s.isNsfw ? (s.sfwBannerUrl ?? null) : s.bannerImageUrl,
      bannerFocusY: s.bannerFocusY ?? 50,
      logoUrl: s.logoUrl,
      iconColor: s.iconColor,
      ownerUsername: owner?.username ?? null,
      memberCount,
      joinMode: s.joinMode,
      isSystem: !!s.isSystem,
      // Surfaced so the public page can say "18+ community" plainly instead
      // of showing minors a dead join button.
      isNsfw: !!s.isNsfw,
      createdAt: +s.createdAt,
      themeJson: s.themeJson,
      themeStyleKey: s.themeStyleKey,
    };
  });

  /* =========================================================
   *  Membership applications (joinMode = "application")
   * ========================================================= */

  const applyBody = z.object({
    answer: z.string().trim().max(500).optional(),
  }).strict();

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/servers/:id/membership-applications",
    async (req, reply) => {
      if (!(await serversLive(reply))) return { error: "not found" };
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const a = await serverAuthority(db, me, req.params.id);
      if (!a.server) { reply.code(404); return { error: "no server" }; }
      // HARD age gate: no minor applications to an 18+ community either.
      if (a.server.isNsfw && !me.isAdult) {
        reply.code(403); return { error: tFor(me.locale, "errors:server.servers.adultsOnly"), code: "AGE_RESTRICTED" };
      }
      // No new applications to a suspended/banned server (only owner/staff may
      // touch it while under moderation). Expired bans read as inactive.
      if (isServerModerationActive(a.server) && !a.isMod) {
        const notice = serverModerationNotice(a.server);
        reply.code(403); return { error: notice?.message ?? tFor(me.locale, "errors:server.servers.unavailable"), code: notice?.code ?? null };
      }
      if (a.server.joinMode !== "application") {
        reply.code(409); return { error: tFor(me.locale, "errors:server.servers.notApplicationGated") };
      }
      if (a.ban) { reply.code(403); return { error: tFor(me.locale, "errors:server.servers.banned") }; }
      if (a.isMember) { reply.code(409); return { error: tFor(me.locale, "errors:server.membership.alreadyMember") }; }
      let body: z.infer<typeof applyBody>;
      try { body = applyBody.parse(req.body ?? {}); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const pending = (await db.select({ id: serverMembershipApplications.id })
        .from(serverMembershipApplications)
        .where(and(
          eq(serverMembershipApplications.serverId, a.server.id),
          eq(serverMembershipApplications.applicantUserId, me.id),
          eq(serverMembershipApplications.status, "pending"),
        )).limit(1))[0];
      if (pending) { reply.code(409); return { error: tFor(me.locale, "errors:server.applications.alreadyPending") }; }

      try {
        await db.insert(serverMembershipApplications).values({
          id: nanoid(),
          serverId: a.server.id,
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
    "/servers/:id/membership-applications/mine",
    async (req, reply) => {
      if (!(await serversLive(reply))) return { error: "not found" };
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      await db.update(serverMembershipApplications)
        .set({ status: "withdrawn", reviewedAt: new Date() })
        .where(and(
          eq(serverMembershipApplications.serverId, req.params.id),
          eq(serverMembershipApplications.applicantUserId, me.id),
          eq(serverMembershipApplications.status, "pending"),
        ));
      const still = (await db.select({ id: serverMembershipApplications.id })
        .from(serverMembershipApplications)
        .where(and(
          eq(serverMembershipApplications.serverId, req.params.id),
          eq(serverMembershipApplications.applicantUserId, me.id),
          eq(serverMembershipApplications.status, "pending"),
        )).limit(1))[0];
      if (still) { reply.code(500); return { error: "withdraw failed" }; }
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string } }>("/servers/:id/membership-applications", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_applications");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const wire = async (rows: Array<typeof serverMembershipApplications.$inferSelect>) => {
      const ids = [...new Set(rows.flatMap((r) => [r.applicantUserId, r.reviewedByUserId].filter((x): x is string => !!x)))];
      const names = ids.length
        ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ids))
        : [];
      const nameBy = new Map(names.map((n) => [n.id, n.username]));
      return rows.map((r) => ({
        id: r.id,
        serverId: r.serverId,
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
    const pending = await db.select().from(serverMembershipApplications)
      .where(and(eq(serverMembershipApplications.serverId, gate.server.id), eq(serverMembershipApplications.status, "pending")))
      .orderBy(serverMembershipApplications.submittedAt);
    const recent = await db.select().from(serverMembershipApplications)
      .where(and(eq(serverMembershipApplications.serverId, gate.server.id), sql`${serverMembershipApplications.status} != 'pending'`))
      .orderBy(desc(serverMembershipApplications.reviewedAt))
      .limit(20);
    return { pending: await wire(pending), recent: await wire(recent) };
  });

  const reviewMembershipBody = z.object({
    action: z.enum(["approve", "reject"]),
    reviewNote: z.string().trim().max(300).optional(),
  }).strict();

  app.patch<{ Params: { id: string; appId: string }; Body: unknown }>(
    "/servers/:id/membership-applications/:appId",
    async (req, reply) => {
      if (!(await serversLive(reply))) return { error: "not found" };
      const gate = await requireServerPermission(req, req.params.id, "manage_applications");
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      let body: z.infer<typeof reviewMembershipBody>;
      try { body = reviewMembershipBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const appRow = (await db.select().from(serverMembershipApplications)
        .where(and(
          eq(serverMembershipApplications.id, req.params.appId),
          eq(serverMembershipApplications.serverId, gate.server.id),
        )).limit(1))[0];
      if (!appRow) { reply.code(404); return { error: "application not found" }; }
      if (appRow.status !== "pending") {
        reply.code(409); return { error: `application already ${appRow.status}` };
      }
      const nextStatus = body.action === "approve" ? "approved" as const : "rejected" as const;
      let lostRace = false;
      db.transaction((tx) => {
        const updated = tx.update(serverMembershipApplications)
          .set({
            status: nextStatus,
            reviewedAt: new Date(),
            reviewedByUserId: gate.me.id,
            reviewNote: body.reviewNote ?? null,
          })
          .where(and(
            eq(serverMembershipApplications.id, appRow.id),
            eq(serverMembershipApplications.status, "pending"),
          ))
          .run();
        if (updated.changes === 0) { lostRace = true; return; }
        if (nextStatus === "approved") {
          tx.insert(serverMembers)
            .values({ serverId: gate.server.id, userId: appRow.applicantUserId, role: "member" })
            .onConflictDoNothing()
            .run();
        }
      });
      if (lostRace) { reply.code(409); return { error: "application was already decided" }; }
      await notifyUser(io, db, appRow.applicantUserId, {
        code: nextStatus === "approved" ? "SERVER_MEMBER_APPROVED" : "SERVER_MEMBER_REJECTED",
        message: nextStatus === "approved"
          ? `You're in - "${gate.server.name}" approved your application.`
          : `"${gate.server.name}" declined your application${body.reviewNote ? `: ${body.reviewNote}` : "."}`,
        persist: {
          category: "server",
          kind: nextStatus === "approved" ? "membership_approved" : "membership_rejected",
          serverId: gate.server.id,
          title: nextStatus === "approved" ? `Joined ${gate.server.name}` : `Application to ${gate.server.name} declined`,
          snippet: nextStatus === "approved"
            ? "Your membership was approved."
            : (body.reviewNote ? body.reviewNote : "Your application was declined."),
          ...(nextStatus === "approved" ? { target: { kind: "server", id: gate.server.id } } : {}),
        },
      });
      // Live-add the joined server to the new member's rail (fade-in) so they
      // don't have to refresh to see it.
      if (nextStatus === "approved") {
        await emitServersChanged(io, appRow.applicantUserId, gate.server.id);
      }
      return { ok: true };
    },
  );
}
