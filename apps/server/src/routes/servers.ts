/**
 * Servers — the multi-server registry routes (plan §4/§6, Phase 4). The
 * deliberate 1:1 mirror of `routes/forums.ts`, scoped to the OUTER container:
 *
 *   GET    /servers                       catalog rail (ServerSummary[])
 *   GET    /servers/slug-availability     live create-form check
 *   GET    /servers/:id                   detail + viewer state
 *   POST   /servers/applications          "register your server" (global key)
 *   GET    /servers/applications/mine     applicant's own history
 *   POST   /servers/:id/join | leave | visit
 *   POST   /servers/:id/membership-applications  + owner/mod review
 *   PATCH  /servers/:id                   owner console: appearance
 *   members list + role/permission updates, usergroups CRUD, bans CRUD,
 *   GET /servers/:id/mod-log, POST /servers/:id/transfer
 *
 * HARD RULE — flag-off is byte-identical to today: EVERY handler below first
 * checks `areServersEnabled(getSettings(db))` and 404s when off, so with the
 * feature disabled these routes behave exactly like a feature that was never
 * registered. Per-server gating goes through `serverAuthority`/`serverCan`;
 * the four PLATFORM keys (apply_create_server etc.) go through `hasPermission`.
 *
 * The admin review-queue + cross-server oversight routes live in
 * `admin/servers.ts` (registered alongside this from index.ts).
 */
import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { and, asc, desc, eq, inArray, isNull, isNotNull, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  RESERVED_SERVER_SLUGS,
  SERVER_MAX_OWNED_DEFAULT,
  SERVER_MOD_DEFAULT_PERMISSIONS,
  SERVER_MOD_PERMISSIONS,
  SERVER_NAME_MAX,
  SERVER_NAME_MIN,
  SERVER_PERMISSIONS,
  SERVER_PURPOSE_MAX,
  SERVER_PURPOSE_MIN,
  SERVER_REAPPLY_COOLDOWN_DAYS,
  SERVER_SLUG_RE,
  SERVER_TAGLINE_MAX,
  isModeratorRole,
  isServerModPermission,
  isServerPermission,
  normalizeServerSlug,
  normalizeTheme,
  parseServerModPermissions,
  parseServerPermissions,
  serializeServerModPermissions,
  serializeServerPermissions,
} from "@thekeep/shared";
import type {
  ClientToServerEvents,
  ServerPermission,
  ServerRole,
  ServerToClientEvents,
  ServerViewerState,
} from "@thekeep/shared";
import {
  auditLog,
  characters,
  messages,
  rooms,
  serverBans,
  serverCreationApplications,
  serverInvites,
  serverMembers,
  serverMembershipApplications,
  serverSettings,
  serverUsergroupMembers,
  serverUsergroups,
  serverVisits,
  servers,
  users,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";
import { hasPermission } from "../auth/permissions.js";
import { serverAuthority, serverCan } from "../servers/authority.js";
import { ensureDefaultUsergroup } from "../servers/usergroups.js";
import { resolveIdentityArg } from "../commands/identityArg.js";
import { notifyUser } from "../servers/notifications.js";
import { getSettings, areServersEnabled, invalidateServerSettings } from "../settings.js";
import {
  broadcastPresence,
  findServerLanding,
  sendRoomBacklogTo,
} from "../realtime/broadcast.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** Catalog sort: the system server first, then featured, then name A→Z. */
function catalogRank(s: { isSystem: boolean; status: string }): number {
  if (s.isSystem) return 0;
  if (s.status === "featured") return 1;
  return 2;
}

/**
 * Audit a server-scoped action. The global `AuditAction` union (owned by the
 * shared moderation module) carries no `server_*` members yet, so we write the
 * row directly rather than through `recordAudit` — using the auditLog's NATIVE
 * `serverId` column (migration 0278a) as the Mod Log's scope discriminator.
 * Best-effort, exactly like `recordAudit`: a logging failure never fails the
 * action it records.
 */
async function auditServer(
  db: Db,
  entry: {
    serverId: string;
    actorUserId: string;
    action: string;
    targetUserId?: string | null;
    targetRoomId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: nanoid(),
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetUserId: entry.targetUserId ?? null,
      targetRoomId: entry.targetRoomId ?? null,
      reason: entry.reason ?? null,
      metadataJson: entry.metadata ? JSON.stringify(entry.metadata) : null,
      serverId: entry.serverId,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[audit] failed to record server entry", { action: entry.action, err });
  }
}

export async function registerServerRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /** Single gate the top of every handler runs: when the feature is off the
   *  route 404s exactly like a disabled feature, keeping flag-off byte-
   *  identical to today. Returns false (and sets the 404) when off. */
  async function serversLive(reply: { code: (c: number) => unknown }): Promise<boolean> {
    if (!areServersEnabled(await getSettings(db))) {
      reply.code(404);
      return false;
    }
    return true;
  }

  /* =========================================================
   *  Catalog + detail
   * ========================================================= */

  app.get("/servers", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    // Session optional (mirrors the forum catalog): logged-in viewers also get
    // their per-server role + unseen flag.
    const me = await getSessionUser(req, db).catch(() => null);

    const rows = await db
      .select({
        id: servers.id,
        slug: servers.slug,
        name: servers.name,
        tagline: servers.tagline,
        logoUrl: servers.logoUrl,
        iconColor: servers.iconColor,
        isSystem: servers.isSystem,
        isDefault: servers.isDefault,
        status: servers.status,
        visibility: servers.visibility,
        joinMode: servers.joinMode,
        ownerUserId: servers.ownerUserId,
      })
      .from(servers)
      .where(sql`${servers.status} != 'archived'`);

    // Last activity per server: max over its rooms' message rows.
    const activity = await db
      .select({
        serverId: rooms.serverId,
        last: sql<number | null>`max(coalesce(${messages.lastActivityAt}, ${messages.createdAt}))`,
      })
      .from(messages)
      .innerJoin(rooms, eq(rooms.id, messages.roomId))
      .where(and(isNotNull(rooms.serverId), isNull(messages.deletedAt)))
      .groupBy(rooms.serverId);
    const activityBy = new Map(activity.map((r) => [r.serverId, r.last]));

    // The viewer's membership roles + visit markers (one indexed read each).
    const rolesBy = me
      ? new Map((await db
          .select({ serverId: serverMembers.serverId, role: serverMembers.role })
          .from(serverMembers)
          .where(eq(serverMembers.userId, me.id))).map((r) => [r.serverId, r.role]))
      : null;
    const visitsBy = me
      ? new Map((await db
          .select({ serverId: serverVisits.serverId, at: serverVisits.lastVisitAt })
          .from(serverVisits)
          .where(eq(serverVisits.userId, me.id))).map((v) => [v.serverId, +v.at]))
      : null;

    const out = rows.map((s) => {
      // viewerRole: the relational role, with the owner short-circuit, and the
      // system/default server treated as implicit-member for signed-in users
      // (mirrors serverAuthority.isMember) so the rail's owned/joined split
      // doesn't nag everyone to "join" The Spire.
      const role: ServerRole | null = me
        ? (rolesBy?.get(s.id)
            ?? (s.ownerUserId === me.id
              ? "owner"
              : s.isSystem
                ? "member"
                : null))
        : null;
      const last = activityBy.get(s.id) ?? null;
      const seen = visitsBy?.get(s.id);
      return {
        id: s.id,
        slug: s.slug,
        name: s.name,
        tagline: s.tagline ?? null,
        logoUrl: s.logoUrl ?? null,
        iconColor: s.iconColor ?? null,
        isSystem: !!s.isSystem,
        isDefault: !!s.isDefault,
        status: s.status,
        visibility: s.visibility,
        joinMode: s.joinMode,
        viewerRole: role,
        ...(me ? { hasUnseen: !!last && (!seen || last > seen) } : {}),
      };
    });
    out.sort((a, b) => catalogRank(a) - catalogRank(b) || a.name.localeCompare(b.name));
    return { servers: out };
  });

  app.get<{ Params: { id: string } }>("/servers/:id", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db).catch(() => null);
    const key = req.params.id;
    let server = (await db.select().from(servers).where(eq(servers.id, key)).limit(1))[0];
    if (!server) {
      server = (await db.select().from(servers)
        .where(sql`lower(${servers.slug}) = lower(${key})`).limit(1))[0];
    }
    if (!server) { reply.code(404); return { error: "no server" }; }

    const owner = (await db.select({ username: users.username }).from(users)
      .where(eq(users.id, server.ownerUserId)).limit(1))[0];

    const roomCount = (await db.select({ n: sql<number>`count(*)` }).from(rooms)
      .where(and(eq(rooms.serverId, server.id), isNull(rooms.archivedAt))))[0]?.n ?? 0;
    const memberCount = (await db.select({ n: sql<number>`count(*)` }).from(serverMembers)
      .where(eq(serverMembers.serverId, server.id)))[0]?.n ?? 0;
    const activity = (await db
      .select({ last: sql<number | null>`max(coalesce(${messages.lastActivityAt}, ${messages.createdAt}))` })
      .from(messages)
      .innerJoin(rooms, eq(rooms.id, messages.roomId))
      .where(and(eq(rooms.serverId, server.id), isNull(messages.deletedAt))))[0]?.last ?? null;

    const a = await serverAuthority(db, me, server.id);
    let viewer: ServerViewerState | null = null;
    if (me) {
      viewer = {
        role: a.role,
        isOwner: a.isOwner,
        isMod: a.isMod,
        isMember: a.isMember,
        permissions: a.permissions,
      };
    }
    // Pending-application flag so the client shows "applied" rather than a
    // fresh apply button (advisory; the apply route re-checks).
    const pending = me
      ? (await db.select({ id: serverMembershipApplications.id })
          .from(serverMembershipApplications)
          .where(and(
            eq(serverMembershipApplications.serverId, server.id),
            eq(serverMembershipApplications.applicantUserId, me.id),
            eq(serverMembershipApplications.status, "pending"),
          )).limit(1))[0]
      : null;

    return {
      server: {
        id: server.id,
        slug: server.slug,
        name: server.name,
        tagline: server.tagline ?? null,
        descriptionHtml: server.descriptionHtml ?? null,
        logoUrl: server.logoUrl ?? null,
        bannerImageUrl: server.bannerImageUrl ?? null,
        bannerFocusY: server.bannerFocusY ?? 50,
        bannerCoverCss: server.bannerCoverCss ?? null,
        iconColor: server.iconColor ?? null,
        themeJson: server.themeJson ?? null,
        themeStyleKey: server.themeStyleKey ?? null,
        isSystem: !!server.isSystem,
        isDefault: !!server.isDefault,
        status: server.status,
        visibility: server.visibility,
        joinMode: server.joinMode,
        publicBrowsing: !!server.publicBrowsing,
        applicationPrompt: server.applicationPrompt ?? null,
        ownerUserId: server.ownerUserId,
        ownerUsername: owner?.username ?? "unknown",
        roomCount,
        memberCount,
        lastActivityAt: activity,
        createdAt: +server.createdAt,
      },
      viewer,
      ban: a.ban ? { until: a.ban.until ? +a.ban.until : null, reason: a.ban.reason } : null,
      membershipPending: !!pending,
    };
  });

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
  }).strict();

  app.post<{ Body: unknown }>("/servers/applications", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "apply_create_server", db))) {
      reply.code(403); return { error: "Server creation applications aren't available to you." };
    }
    let body: z.infer<typeof submitBody>;
    try { body = submitBody.parse(req.body); }
    catch { reply.code(400); return { error: `Check the fields: name ${SERVER_NAME_MIN}-${SERVER_NAME_MAX} chars, purpose ${SERVER_PURPOSE_MIN}-${SERVER_PURPOSE_MAX} chars.` }; }

    const slug = normalizeServerSlug(body.requestedSlug);
    if (!slug) { reply.code(400); return { error: "That slug isn't usable - lowercase letters, numbers, and _ only (3-40), and not a reserved word." }; }
    const used = await slugInUse(slug);
    if (used) { reply.code(409); return { error: used === "taken" ? "That slug already belongs to a server." : "Another pending application already claims that slug." }; }

    const pendingMine = (await db.select({ id: serverCreationApplications.id })
      .from(serverCreationApplications)
      .where(and(
        eq(serverCreationApplications.applicantUserId, me.id),
        eq(serverCreationApplications.status, "pending"),
      )).limit(1))[0];
    if (pendingMine) { reply.code(409); return { error: "You already have an application pending review." }; }

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
        return { error: `Your last application was declined recently - you can re-apply in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.` };
      }
    }

    const owned = (await db.select({ n: sql<number>`count(*)` }).from(servers)
      .where(and(eq(servers.ownerUserId, me.id), sql`${servers.status} != 'archived'`, eq(servers.isSystem, false))))[0]?.n ?? 0;
    if (owned >= SERVER_MAX_OWNED_DEFAULT) {
      reply.code(409);
      return { error: `You already keep ${owned} servers - the limit is ${SERVER_MAX_OWNED_DEFAULT}.` };
    }

    const id = nanoid();
    try {
      await db.insert(serverCreationApplications).values({
        id,
        applicantUserId: me.id,
        requestedName: body.requestedName,
        requestedSlug: slug,
        purpose: body.purpose,
      });
    } catch {
      reply.code(409); return { error: "You already have an application pending review." };
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
    if (a.ban) { reply.code(403); return { error: "You are banned from this server." }; }
    if (a.server.joinMode === "application") {
      reply.code(409); return { error: "This server reviews applications — apply to join instead." };
    }
    if (a.server.joinMode === "invite") {
      if (a.role) return { ok: true }; // already enrolled (idempotent)
      let body: z.infer<typeof joinInviteBody>;
      try { body = joinInviteBody.parse(req.body ?? {}); }
      catch { reply.code(400); return { error: "An invite code is required to join this server." }; }
      const code = body.code.trim();
      // Validate: matches THIS server, live (not revoked/expired), under cap.
      // Claim the use inside a transaction so concurrent redemptions can't blow
      // past max_uses (the conditional UPDATE is the atomic gate).
      const invite = (await db.select().from(serverInvites)
        .where(and(eq(serverInvites.serverId, a.server.id), eq(serverInvites.code, code))).limit(1))[0];
      if (!invite) { reply.code(404); return { error: "That invite code isn't valid for this server." }; }
      if (invite.revokedAt) { reply.code(409); return { error: "That invite has been revoked." }; }
      if (invite.expiresAt && +invite.expiresAt <= Date.now()) {
        reply.code(409); return { error: "That invite has expired." };
      }
      if (invite.maxUses != null && invite.usedCount >= invite.maxUses) {
        reply.code(409); return { error: "That invite has reached its use limit." };
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
      if (!claimed) { reply.code(409); return { error: "That invite is no longer usable." }; }
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
      reply.code(409); return { error: "The owner can't leave their own server — transfer it first." };
    }
    if (a.server.isSystem) {
      reply.code(409); return { error: "You can't leave the home server." };
    }
    if (!a.role) { reply.code(409); return { error: "You're not a member here." }; }
    await db.delete(serverMembers)
      .where(and(eq(serverMembers.serverId, a.server.id), eq(serverMembers.userId, me.id)));
    return { ok: true };
  });

  /** Stamp "viewer looked at this server now" — clears the rail's unseen dot. */
  app.post<{ Params: { id: string } }>("/servers/:id/visit", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
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
    return { ok: true, landingRoomId: landing?.id ?? null };
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
      if (a.server.joinMode !== "application") {
        reply.code(409); return { error: "This server isn't application-gated." };
      }
      if (a.ban) { reply.code(403); return { error: "You are banned from this server." }; }
      if (a.isMember) { reply.code(409); return { error: "You're already a member here." }; }
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
      if (pending) { reply.code(409); return { error: "Your application is already pending." }; }

      try {
        await db.insert(serverMembershipApplications).values({
          id: nanoid(),
          serverId: a.server.id,
          applicantUserId: me.id,
          answer: body.answer?.trim() ? body.answer.trim() : null,
        });
      } catch {
        reply.code(409); return { error: "Your application is already pending." };
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
      await notifyUser(io, appRow.applicantUserId,
        nextStatus === "approved" ? "SERVER_MEMBER_APPROVED" : "SERVER_MEMBER_REJECTED",
        nextStatus === "approved"
          ? `You're in - "${gate.server.name}" approved your application.`
          : `"${gate.server.name}" declined your application${body.reviewNote ? `: ${body.reviewNote}` : "."}`);
      return { ok: true };
    },
  );

  /* =========================================================
   *  Invites (joinMode = "invite")
   * ========================================================= */

  /** Mint an unguessable invite code. Same alphabet/length nanoid the rest of
   *  the routes use for opaque ids — collision odds are negligible and the
   *  column's UNIQUE constraint is the backstop. */
  function mintInviteCode(): string {
    return nanoid(16);
  }

  const inviteWire = (r: typeof serverInvites.$inferSelect, origin?: string) => ({
    code: r.code,
    link: origin ? `${origin}/servers/join/${r.code}` : null,
    maxUses: r.maxUses ?? null,
    usedCount: r.usedCount,
    expiresAt: r.expiresAt ? +r.expiresAt : null,
    createdAt: +r.createdAt,
  });

  /** Origin for the shareable join link, derived from the request (mirrors how
   *  the export route builds absolute URLs); null when it can't be resolved. */
  function requestOrigin(req: { headers: Record<string, unknown>; protocol?: string }): string | null {
    const host = req.headers["x-forwarded-host"] ?? req.headers["host"];
    if (!host || typeof host !== "string") return null;
    const fwdProto = req.headers["x-forwarded-proto"];
    const proto = (typeof fwdProto === "string" ? fwdProto.split(",")[0] : null) ?? req.protocol ?? "https";
    return `${proto}://${host}`;
  }

  const createInviteBody = z.object({
    maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
    /** Lifetime in hours from now; null/omitted → never expires. */
    expiresInHours: z.number().int().min(1).max(24 * 365).nullable().optional(),
  }).strict();

  /** POST /servers/:id/invites — mint a fresh invite code (manage_invites). */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/invites", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_invites");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof createInviteBody>;
    try { body = createInviteBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const expiresAt = body.expiresInHours ? new Date(Date.now() + body.expiresInHours * 3_600_000) : null;
    const id = nanoid();
    const code = mintInviteCode();
    await db.insert(serverInvites).values({
      id,
      serverId: gate.server.id,
      code,
      createdByUserId: gate.me.id,
      maxUses: body.maxUses ?? null,
      expiresAt,
    });
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_invite_create",
      metadata: { slug: gate.server.slug, code, maxUses: body.maxUses ?? null, expiresAt: expiresAt ? +expiresAt : null },
    });
    const row = (await db.select().from(serverInvites).where(eq(serverInvites.id, id)).limit(1))[0]!;
    return { invite: inviteWire(row, requestOrigin(req) ?? undefined) };
  });

  /** GET /servers/:id/invites — list LIVE invites (non-revoked, non-expired)
   *  with usage counts (manage_invites). */
  app.get<{ Params: { id: string } }>("/servers/:id/invites", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_invites");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const now = Date.now();
    const rows = await db.select().from(serverInvites)
      .where(and(
        eq(serverInvites.serverId, gate.server.id),
        isNull(serverInvites.revokedAt),
        sql`(${serverInvites.expiresAt} is null or ${serverInvites.expiresAt} > ${now})`,
      ))
      .orderBy(desc(serverInvites.createdAt));
    const origin = requestOrigin(req) ?? undefined;
    return { invites: rows.map((r) => inviteWire(r, origin)) };
  });

  /** DELETE /servers/:id/invites/:code — revoke an invite (manage_invites). */
  app.delete<{ Params: { id: string; code: string } }>("/servers/:id/invites/:code", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_invites");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const existing = (await db.select().from(serverInvites)
      .where(and(
        eq(serverInvites.serverId, gate.server.id),
        eq(serverInvites.code, req.params.code),
        isNull(serverInvites.revokedAt),
      )).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "no such invite" }; }
    await db.update(serverInvites).set({ revokedAt: new Date() })
      .where(eq(serverInvites.id, existing.id));
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_invite_revoke",
      metadata: { slug: gate.server.slug, code: existing.code },
    });
    return { ok: true };
  });

  /* =========================================================
   *  Owner console gates
   * ========================================================= */

  /** Owner-or-staff gate (server owner, the admin lieutenant, or
   *  manage_any_server staff — i.e. authority.isOwner). */
  async function requireServerOwner(req: Parameters<typeof getSessionUser>[0], serverId: string) {
    const me = await getSessionUser(req, db);
    if (!me) return { fail: { code: 401 as const, error: "auth" } };
    const a = await serverAuthority(db, me, serverId);
    if (!a.server) return { fail: { code: 404 as const, error: "no server" } };
    if (!a.isOwner) return { fail: { code: 403 as const, error: "server owner only" } };
    return { me, server: a.server, authority: a };
  }

  /** Gate for an action a mod CAN be granted: passes for owner/staff (who hold
   *  every key) OR a mod/admin holding the specific granular permission. */
  async function requireServerPermission(
    req: Parameters<typeof getSessionUser>[0],
    serverId: string,
    key: ServerPermission,
  ) {
    const me = await getSessionUser(req, db);
    if (!me) return { fail: { code: 401 as const, error: "auth" } };
    const a = await serverAuthority(db, me, serverId);
    if (!a.server) return { fail: { code: 404 as const, error: "no server" } };
    if (!serverCan(a, key)) return { fail: { code: 403 as const, error: "you don't have that server permission" } };
    return { me, server: a.server, authority: a };
  }

  /** Resolve a mod/ban/group target to a user account (identity tokens + names). */
  async function resolveServerTarget(raw: string): Promise<
    | { ok: true; userId: string; username: string }
    | { ok: false; error: string }
  > {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, error: "Name or @id:/@cid: token required." };
    const res = await resolveIdentityArg(db, trimmed);
    if (res.kind === "none") return { ok: false, error: `No one matches "${trimmed}".` };
    if (res.kind === "ambiguous") {
      return { ok: false, error: `"${trimmed}" matches several identities - paste their @id: token from the profile.` };
    }
    return { ok: true, userId: res.target.userId, username: res.target.masterUsername };
  }

  /* =========================================================
   *  Owner console: appearance (PATCH /servers/:id)
   * ========================================================= */

  const patchServerBody = z.object({
    name: z.string().trim().min(SERVER_NAME_MIN).max(SERVER_NAME_MAX).optional(),
    tagline: z.string().trim().max(SERVER_TAGLINE_MAX).nullable().optional(),
    descriptionHtml: z.string().max(5000 * 4).nullable().optional(),
    logoUrl: z.string().trim().max(2048).nullable().optional(),
    iconColor: z.string().trim().max(32).nullable().optional(),
    themeJson: z.string().max(4000).nullable().optional(),
    themeStyleKey: z.string().trim().min(1).max(64).nullable().optional(),
    bannerFocusY: z.number().int().min(0).max(100).optional(),
    publicBrowsing: z.boolean().optional(),
    joinMode: z.enum(["open", "application", "invite"]).optional(),
    applicationPrompt: z.string().trim().max(300).nullable().optional(),
    /** Welcome + rules HTML live in the per-server settings row (Track owns
     *  that surface separately); appearance here is the servers-table slice. */
    roomOrder: z.array(z.string()).max(200).optional(),
  }).strict();

  app.patch<{ Params: { id: string }; Body: unknown }>("/servers/:id", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_appearance");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof patchServerBody>;
    try { body = patchServerBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const update: Partial<typeof servers.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.tagline !== undefined) update.tagline = body.tagline?.trim() ? body.tagline.trim() : null;
    if (body.descriptionHtml !== undefined) {
      const { sanitizeBio } = await import("../auth/html.js");
      update.descriptionHtml = body.descriptionHtml?.trim() ? sanitizeBio(body.descriptionHtml) : null;
    }
    if (body.logoUrl !== undefined) update.logoUrl = body.logoUrl?.trim() ? body.logoUrl.trim() : null;
    if (body.iconColor !== undefined) update.iconColor = body.iconColor?.trim() ? body.iconColor.trim() : null;
    if (body.themeJson !== undefined) {
      if (body.themeJson === null || !body.themeJson.trim()) {
        update.themeJson = null;
      } else {
        try { update.themeJson = JSON.stringify(normalizeTheme(JSON.parse(body.themeJson))); }
        catch { reply.code(400); return { error: "themeJson must be a JSON theme object" }; }
      }
    }
    if (body.themeStyleKey !== undefined) update.themeStyleKey = body.themeStyleKey;
    if (body.bannerFocusY !== undefined) update.bannerFocusY = body.bannerFocusY;
    if (body.publicBrowsing !== undefined) update.publicBrowsing = body.publicBrowsing;
    if (body.applicationPrompt !== undefined) {
      update.applicationPrompt = body.applicationPrompt?.trim() ? body.applicationPrompt.trim() : null;
    }
    // The system/default server is the platform home: its join mode stays open
    // (everyone is an implicit member) — refuse to gate it.
    if (body.joinMode !== undefined) {
      if (gate.server.isSystem && body.joinMode !== "open") {
        reply.code(409); return { error: "The home server can't be gated." };
      }
      update.joinMode = body.joinMode;
    }
    if (body.roomOrder !== undefined) {
      const own = new Set((await db.select({ id: rooms.id }).from(rooms)
        .where(eq(rooms.serverId, gate.server.id))).map((r) => r.id));
      update.roomOrderJson = JSON.stringify(body.roomOrder.filter((id) => own.has(id)));
    }
    await db.update(servers).set(update).where(eq(servers.id, gate.server.id));
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_appearance_update",
      metadata: { slug: gate.server.slug, fields: Object.keys(update).filter((k) => k !== "updatedAt") },
    });
    return { ok: true };
  });

  /* =========================================================
   *  Owner console: per-server settings (server_settings row)
   * ========================================================= */

  /** GET /servers/:id/settings — the RAW per-server overrides (migration 0276
   *  columns; NULL = inherit the platform default). Track 1 consumes this to
   *  render the settings form; the resolved/effective values live behind
   *  getServerSettings. Visible to any member/mod (read-only). */
  app.get<{ Params: { id: string } }>("/servers/:id/settings", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const a = await serverAuthority(db, me, req.params.id);
    if (!a.server) { reply.code(404); return { error: "no server" }; }
    if (!a.isMember && !a.isMod) { reply.code(403); return { error: "forbidden" }; }
    const row = (await db.select().from(serverSettings)
      .where(eq(serverSettings.serverId, a.server.id)).limit(1))[0];
    return {
      settings: {
        messageRetentionMs: row?.messageRetentionMs ?? null,
        maxRoomsPerOwner: row?.maxRoomsPerOwner ?? null,
        maxMessageLength: row?.maxMessageLength ?? null,
        editGraceMs: row?.editGraceMs ?? null,
        rulesHtml: row?.rulesHtml ?? null,
        securityNoticeHtml: row?.securityNoticeHtml ?? null,
        welcomeHtml: row?.welcomeHtml ?? null,
        newUserWelcomeHtml: row?.newUserWelcomeHtml ?? null,
        maxForumPostLength: row?.maxForumPostLength ?? null,
      },
    };
  });

  /** PATCH /servers/:id/settings — upsert the per-server overrides for the
   *  provided fields (NULL = clear the override, inherit the platform default).
   *  Gated on manage_appearance (same chair as the appearance slice). Numeric
   *  caps are positive ints; HTML copy is sanitized like the appearance
   *  description. Invalidates the getServerSettings cache after the write. */
  const patchSettingsBody = z.object({
    messageRetentionMs: z.number().int().positive().nullable().optional(),
    maxRoomsPerOwner: z.number().int().positive().max(10_000).nullable().optional(),
    maxMessageLength: z.number().int().positive().max(100_000).nullable().optional(),
    editGraceMs: z.number().int().min(0).nullable().optional(),
    maxForumPostLength: z.number().int().positive().max(1_000_000).nullable().optional(),
    rulesHtml: z.string().max(200_000).nullable().optional(),
    securityNoticeHtml: z.string().max(200_000).nullable().optional(),
    welcomeHtml: z.string().max(200_000).nullable().optional(),
    newUserWelcomeHtml: z.string().max(200_000).nullable().optional(),
  }).strict();

  app.patch<{ Params: { id: string }; Body: unknown }>("/servers/:id/settings", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_appearance");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof patchSettingsBody>;
    try { body = patchSettingsBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const update: Partial<typeof serverSettings.$inferInsert> = {
      updatedAt: new Date(),
      updatedById: gate.me.id,
    };
    if (body.messageRetentionMs !== undefined) update.messageRetentionMs = body.messageRetentionMs;
    if (body.maxRoomsPerOwner !== undefined) update.maxRoomsPerOwner = body.maxRoomsPerOwner;
    if (body.maxMessageLength !== undefined) update.maxMessageLength = body.maxMessageLength;
    if (body.editGraceMs !== undefined) update.editGraceMs = body.editGraceMs;
    if (body.maxForumPostLength !== undefined) update.maxForumPostLength = body.maxForumPostLength;
    if (body.rulesHtml !== undefined || body.securityNoticeHtml !== undefined
      || body.welcomeHtml !== undefined || body.newUserWelcomeHtml !== undefined) {
      const { sanitizeBio } = await import("../auth/html.js");
      const clean = (v: string | null | undefined) =>
        v === undefined ? undefined : (v?.trim() ? sanitizeBio(v) : null);
      if (body.rulesHtml !== undefined) update.rulesHtml = clean(body.rulesHtml) ?? null;
      if (body.securityNoticeHtml !== undefined) update.securityNoticeHtml = clean(body.securityNoticeHtml) ?? null;
      if (body.welcomeHtml !== undefined) update.welcomeHtml = clean(body.welcomeHtml) ?? null;
      if (body.newUserWelcomeHtml !== undefined) update.newUserWelcomeHtml = clean(body.newUserWelcomeHtml) ?? null;
    }

    await db.insert(serverSettings)
      .values({ serverId: gate.server.id, ...update })
      .onConflictDoUpdate({ target: serverSettings.serverId, set: update });
    invalidateServerSettings(gate.server.id);
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_settings_update",
      metadata: { slug: gate.server.slug, fields: Object.keys(update).filter((k) => k !== "updatedAt" && k !== "updatedById") },
    });
    return { ok: true };
  });

  /* =========================================================
   *  Members + roles
   * ========================================================= */

  app.get<{ Params: { id: string } }>("/servers/:id/members", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_members");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const owner = (await db.select({ username: users.username, avatarUrl: users.avatarUrl })
      .from(users).where(eq(users.id, gate.server.ownerUserId)).limit(1))[0];
    const rows = await db
      .select({
        userId: serverMembers.userId, username: users.username, avatarUrl: users.avatarUrl,
        role: serverMembers.role, permissionsJson: serverMembers.permissionsJson, joinedAt: serverMembers.joinedAt,
      })
      .from(serverMembers)
      .leftJoin(users, eq(users.id, serverMembers.userId))
      .where(eq(serverMembers.serverId, gate.server.id));
    const members = rows
      .filter((r) => r.userId !== gate.server.ownerUserId)
      .map((r) => ({
        userId: r.userId,
        username: r.username ?? "unknown",
        avatarUrl: r.avatarUrl ?? null,
        role: r.role,
        permissions: r.role === "mod" ? parseServerModPermissions(r.permissionsJson) : [],
        joinedAt: +r.joinedAt,
      }));
    return {
      managerPermissions: gate.authority.permissions,
      members: [
        { userId: gate.server.ownerUserId, username: owner?.username ?? "unknown", avatarUrl: owner?.avatarUrl ?? null, role: "owner" as const, permissions: [], joinedAt: +gate.server.createdAt },
        ...members,
      ],
    };
  });

  /** Clamp a requested mod grant to what the ACTOR may grant (no escalation). */
  function clampGrant(requested: ServerPermission[], actorPerms: ServerPermission[], isOwner: boolean): ServerPermission[] {
    if (isOwner) return requested;
    const allowed = new Set(actorPerms);
    return requested.filter((p) => allowed.has(p));
  }

  const setRoleBody = z.object({
    role: z.enum(["admin", "mod", "member"]),
    /** Only honored for role="mod"; omitted → the default janitor set. */
    permissions: z.array(z.string()).max(SERVER_MOD_PERMISSIONS.length + 5).optional(),
  }).strict();

  /** PUT /servers/:id/members/:userId/role — set a member's tier. Promoting to
   *  admin (the lieutenant) or assigning mods is OWNER-only; granting/editing a
   *  mod's granular keys needs manage_members. */
  app.put<{ Params: { id: string; userId: string }; Body: unknown }>(
    "/servers/:id/members/:userId/role",
    async (req, reply) => {
      if (!(await serversLive(reply))) return { error: "not found" };
      let body: z.infer<typeof setRoleBody>;
      try { body = setRoleBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      // Appointing the admin lieutenant tier is owner-only (matches the powers
      // matrix: "assign mods/admins" stays owner-tier); the mod chair + member
      // demote ride manage_members.
      const gate = body.role === "admin"
        ? await requireServerOwner(req, req.params.id)
        : await requireServerPermission(req, req.params.id, "manage_members");
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      if (req.params.userId === gate.server.ownerUserId) {
        reply.code(409); return { error: "The owner already holds every power." };
      }
      const ban = (await db.select().from(serverBans)
        .where(and(eq(serverBans.serverId, gate.server.id), eq(serverBans.userId, req.params.userId))).limit(1))[0];
      if (ban && (!ban.until || +ban.until > Date.now())) {
        reply.code(409); return { error: "That user is banned from this server - lift the ban first." };
      }
      const permsJson = body.role === "mod"
        ? serializeServerModPermissions(
            (clampGrant(
              (body.permissions ? body.permissions.filter(isServerModPermission) : SERVER_MOD_DEFAULT_PERMISSIONS) as ServerPermission[],
              gate.authority.permissions,
              gate.authority.isOwner,
            ).filter(isServerModPermission)),
          )
        : "[]";
      await db.insert(serverMembers)
        .values({ serverId: gate.server.id, userId: req.params.userId, role: body.role, permissionsJson: permsJson })
        .onConflictDoUpdate({
          target: [serverMembers.serverId, serverMembers.userId],
          set: { role: body.role, permissionsJson: permsJson },
        });
      await auditServer(db, {
        serverId: gate.server.id, actorUserId: gate.me.id, action: "server_role_set",
        targetUserId: req.params.userId, metadata: { slug: gate.server.slug, role: body.role },
      });
      return { ok: true, role: body.role };
    },
  );

  /** PATCH /servers/:id/members/:userId/permissions — edit an existing mod's
   *  granular keys (manage_members; clamped to the actor's own powers). */
  const setModPermsBody = z.object({ permissions: z.array(z.string()).max(SERVER_MOD_PERMISSIONS.length + 5) }).strict();
  app.patch<{ Params: { id: string; userId: string }; Body: unknown }>(
    "/servers/:id/members/:userId/permissions",
    async (req, reply) => {
      if (!(await serversLive(reply))) return { error: "not found" };
      const gate = await requireServerPermission(req, req.params.id, "manage_members");
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      let body: z.infer<typeof setModPermsBody>;
      try { body = setModPermsBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const row = (await db.select().from(serverMembers)
        .where(and(
          eq(serverMembers.serverId, gate.server.id),
          eq(serverMembers.userId, req.params.userId),
          eq(serverMembers.role, "mod"),
        )).limit(1))[0];
      if (!row) { reply.code(404); return { error: "not a mod here" }; }
      const requested = body.permissions.filter(isServerModPermission) as ServerPermission[];
      const perms = clampGrant(requested, gate.authority.permissions, gate.authority.isOwner).filter(isServerModPermission);
      await db.update(serverMembers).set({ permissionsJson: serializeServerModPermissions(perms) })
        .where(and(eq(serverMembers.serverId, gate.server.id), eq(serverMembers.userId, req.params.userId)));
      await auditServer(db, {
        serverId: gate.server.id, actorUserId: gate.me.id, action: "server_mod_perms",
        targetUserId: req.params.userId, metadata: { slug: gate.server.slug, permissions: perms },
      });
      return { ok: true, permissions: perms };
    },
  );

  /** DELETE /servers/:id/members/:userId — remove a member (or demote+remove a
   *  mod/admin) from the server. Owner can never be removed. */
  app.delete<{ Params: { id: string; userId: string } }>("/servers/:id/members/:userId", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_members");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    if (req.params.userId === gate.server.ownerUserId) { reply.code(409); return { error: "The owner can't be removed." }; }
    const row = (await db.select().from(serverMembers)
      .where(and(eq(serverMembers.serverId, gate.server.id), eq(serverMembers.userId, req.params.userId))).limit(1))[0];
    if (!row) { reply.code(404); return { error: "not a member here" }; }
    // Removing an admin lieutenant is an owner-only act (mirrors appointing).
    if (row.role === "admin" && !gate.authority.isOwner) {
      reply.code(403); return { error: "Only the owner can remove an admin." };
    }
    await db.delete(serverMembers)
      .where(and(eq(serverMembers.serverId, gate.server.id), eq(serverMembers.userId, req.params.userId)));
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_member_remove",
      targetUserId: req.params.userId, metadata: { slug: gate.server.slug },
    });
    return { ok: true };
  });

  /** GET /servers/:id/user-search?q= — typeahead for the role/ban/group
   *  pickers (manage_members OR ban_member). */
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>("/servers/:id/user-search", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const a = await serverAuthority(db, me, req.params.id);
    if (!a.server) { reply.code(404); return { error: "no server" }; }
    if (!(serverCan(a, "manage_members") || serverCan(a, "ban_member") || serverCan(a, "manage_usergroups"))) {
      reply.code(403); return { error: "forbidden" };
    }
    const q = (req.query.q ?? "").trim().toLowerCase();
    if (q.length < 2) return { hits: [] };
    const like = `${q.replace(/[%_]/g, "")}%`;
    const byName = await db
      .select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl })
      .from(users)
      .where(and(ne(users.username, "system"), sql`lower(${users.username}) LIKE ${like}`))
      .orderBy(asc(users.username)).limit(12);
    const byChar = await db
      .select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl })
      .from(characters).innerJoin(users, eq(users.id, characters.userId))
      .where(and(isNull(characters.deletedAt), sql`lower(${characters.name}) LIKE ${like}`))
      .limit(12);
    const map = new Map<string, { id: string; username: string; avatarUrl: string | null }>();
    for (const r of [...byName, ...byChar]) if (!map.has(r.id)) map.set(r.id, r);
    const ids = [...map.keys()].slice(0, 12);
    if (ids.length === 0) return { hits: [] };
    const roleRows = await db.select({ userId: serverMembers.userId, role: serverMembers.role })
      .from(serverMembers).where(and(eq(serverMembers.serverId, a.server.id), inArray(serverMembers.userId, ids)));
    const roleByUser = new Map(roleRows.map((r) => [r.userId, r.role] as const));
    const banRows = await db.select({ userId: serverBans.userId, until: serverBans.until })
      .from(serverBans).where(and(eq(serverBans.serverId, a.server.id), inArray(serverBans.userId, ids)));
    const bannedSet = new Set(banRows.filter((b) => !b.until || +b.until > Date.now()).map((b) => b.userId));
    const ownerId = a.server.ownerUserId;
    return {
      hits: ids.map((id) => {
        const u = map.get(id)!;
        return {
          userId: id,
          username: u.username,
          avatarUrl: u.avatarUrl ?? null,
          serverRole: id === ownerId ? "owner" as const : (roleByUser.get(id) ?? null),
          banned: bannedSet.has(id),
        };
      }),
    };
  });

  /* =========================================================
   *  Usergroups (the unified permission registry)
   * ========================================================= */

  function clampPerms(requested: ServerPermission[], actorPerms: ServerPermission[], isOwner: boolean): ServerPermission[] {
    if (isOwner) return requested;
    const allowed = new Set(actorPerms);
    return requested.filter((p) => allowed.has(p));
  }

  const groupBody = z.object({
    name: z.string().trim().min(1).max(60),
    color: z.string().trim().max(32).nullable().optional(),
    permissions: z.array(z.string()).max(SERVER_PERMISSIONS.length + 5).optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  }).strict();
  const patchGroupBody = z.object({
    name: z.string().trim().min(1).max(60).optional(),
    color: z.string().trim().max(32).nullable().optional(),
    permissions: z.array(z.string()).max(SERVER_PERMISSIONS.length + 5).optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  }).strict();

  app.get<{ Params: { id: string } }>("/servers/:id/usergroups", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    await ensureDefaultUsergroup(db, gate.server.id);
    const rows = await db.select().from(serverUsergroups)
      .where(eq(serverUsergroups.serverId, gate.server.id))
      .orderBy(desc(serverUsergroups.isDefault), asc(serverUsergroups.sortOrder), asc(serverUsergroups.createdAt));
    const ids = rows.map((g) => g.id);
    const counts = ids.length
      ? await db.select({ groupId: serverUsergroupMembers.groupId, n: sql<number>`count(*)` })
          .from(serverUsergroupMembers).where(inArray(serverUsergroupMembers.groupId, ids))
          .groupBy(serverUsergroupMembers.groupId)
      : [];
    const countMap = new Map(counts.map((c) => [c.groupId, Number(c.n)]));
    return {
      managerPermissions: gate.authority.permissions,
      groups: rows.map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color ?? null,
        permissions: parseServerPermissions(g.permissionsJson),
        isDefault: !!g.isDefault,
        sortOrder: g.sortOrder,
        memberCount: g.isDefault ? 0 : (countMap.get(g.id) ?? 0),
      })),
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/usergroups", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof groupBody>;
    try { body = groupBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const count = Number((await db.select({ n: sql<number>`count(*)` }).from(serverUsergroups).where(eq(serverUsergroups.serverId, gate.server.id)))[0]?.n ?? 0);
    if (count >= 25) { reply.code(409); return { error: "A server can have at most 25 usergroups." }; }
    const requested = (body.permissions ?? []).filter(isServerPermission) as ServerPermission[];
    const perms = clampPerms(requested, gate.authority.permissions, gate.authority.isOwner);
    const id = nanoid();
    await db.insert(serverUsergroups).values({
      id, serverId: gate.server.id, name: body.name, color: body.color ?? null,
      permissionsJson: serializeServerPermissions(perms),
      isDefault: false, sortOrder: body.sortOrder ?? count, autoRulesJson: "[]",
    });
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_usergroup_change",
      metadata: { slug: gate.server.slug, op: "create", group: body.name, permissions: perms },
    });
    return { ok: true, id };
  });

  app.patch<{ Params: { id: string; gid: string }; Body: unknown }>("/servers/:id/usergroups/:gid", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const group = (await db.select().from(serverUsergroups)
      .where(and(eq(serverUsergroups.id, req.params.gid), eq(serverUsergroups.serverId, gate.server.id))).limit(1))[0];
    if (!group) { reply.code(404); return { error: "no such usergroup" }; }
    let body: z.infer<typeof patchGroupBody>;
    try { body = patchGroupBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const update: Partial<typeof serverUsergroups.$inferInsert> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.color !== undefined) update.color = body.color ?? null;
    if (body.permissions !== undefined) {
      const requested = body.permissions.filter(isServerPermission) as ServerPermission[];
      const clamped = clampPerms(requested, gate.authority.permissions, gate.authority.isOwner);
      // Preserve perms the group already holds that a lesser manager can't
      // grant — they can only add/remove within their own powers.
      const preserved = gate.authority.isOwner
        ? []
        : parseServerPermissions(group.permissionsJson).filter((p) => !gate.authority.permissions.includes(p));
      update.permissionsJson = serializeServerPermissions([...new Set([...clamped, ...preserved])]);
    }
    if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
    if (Object.keys(update).length) {
      await db.update(serverUsergroups).set(update).where(eq(serverUsergroups.id, group.id));
      await auditServer(db, {
        serverId: gate.server.id, actorUserId: gate.me.id, action: "server_usergroup_change",
        metadata: { slug: gate.server.slug, op: "edit", group: update.name ?? group.name },
      });
    }
    return { ok: true };
  });

  app.delete<{ Params: { id: string; gid: string } }>("/servers/:id/usergroups/:gid", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const group = (await db.select().from(serverUsergroups)
      .where(and(eq(serverUsergroups.id, req.params.gid), eq(serverUsergroups.serverId, gate.server.id))).limit(1))[0];
    if (!group) { reply.code(404); return { error: "no such usergroup" }; }
    if (group.isDefault) { reply.code(400); return { error: "The default group can't be deleted." }; }
    await db.delete(serverUsergroups).where(eq(serverUsergroups.id, group.id)); // cascades members
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_usergroup_change",
      metadata: { slug: gate.server.slug, op: "delete", group: group.name },
    });
    return { ok: true };
  });

  app.get<{ Params: { id: string; gid: string } }>("/servers/:id/usergroups/:gid/members", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const group = (await db.select().from(serverUsergroups)
      .where(and(eq(serverUsergroups.id, req.params.gid), eq(serverUsergroups.serverId, gate.server.id))).limit(1))[0];
    if (!group) { reply.code(404); return { error: "no such usergroup" }; }
    if (group.isDefault) return { members: [] }; // everyone; not enumerated
    const rows = await db
      .select({ userId: serverUsergroupMembers.userId, username: users.username, avatarUrl: users.avatarUrl, isAuto: serverUsergroupMembers.isAuto, addedAt: serverUsergroupMembers.addedAt })
      .from(serverUsergroupMembers)
      .leftJoin(users, eq(users.id, serverUsergroupMembers.userId))
      .where(eq(serverUsergroupMembers.groupId, group.id))
      .orderBy(desc(serverUsergroupMembers.addedAt));
    return {
      members: rows.map((r) => ({
        userId: r.userId, username: r.username ?? "unknown", avatarUrl: r.avatarUrl ?? null, isAuto: !!r.isAuto, addedAt: +r.addedAt,
      })),
    };
  });

  const groupMemberBody = z.object({ target: z.string().trim().min(1).max(120) }).strict();
  app.put<{ Params: { id: string; gid: string }; Body: unknown }>("/servers/:id/usergroups/:gid/members", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const group = (await db.select().from(serverUsergroups)
      .where(and(eq(serverUsergroups.id, req.params.gid), eq(serverUsergroups.serverId, gate.server.id))).limit(1))[0];
    if (!group) { reply.code(404); return { error: "no such usergroup" }; }
    if (group.isDefault) { reply.code(400); return { error: "Everyone already belongs to the default group." }; }
    let body: z.infer<typeof groupMemberBody>;
    try { body = groupMemberBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const target = await resolveServerTarget(body.target);
    if (!target.ok) { reply.code(404); return { error: target.error }; }
    await db.insert(serverUsergroupMembers)
      .values({ groupId: group.id, userId: target.userId, addedBy: gate.me.id, isAuto: false })
      .onConflictDoNothing();
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_usergroup_change",
      targetUserId: target.userId, metadata: { slug: gate.server.slug, op: "add_member", group: group.name },
    });
    return { ok: true, username: target.username };
  });

  app.delete<{ Params: { id: string; gid: string; userId: string } }>("/servers/:id/usergroups/:gid/members/:userId", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const group = (await db.select().from(serverUsergroups)
      .where(and(eq(serverUsergroups.id, req.params.gid), eq(serverUsergroups.serverId, gate.server.id))).limit(1))[0];
    if (!group) { reply.code(404); return { error: "no such usergroup" }; }
    if (group.isDefault) { reply.code(400); return { error: "The default group has no removable members." }; }
    await db.delete(serverUsergroupMembers)
      .where(and(eq(serverUsergroupMembers.groupId, group.id), eq(serverUsergroupMembers.userId, req.params.userId)));
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_usergroup_change",
      targetUserId: req.params.userId, metadata: { slug: gate.server.slug, op: "remove_member", group: group.name },
    });
    return { ok: true };
  });

  /* =========================================================
   *  Bans
   * ========================================================= */

  app.get<{ Params: { id: string } }>("/servers/:id/bans", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "ban_member");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const rows = await db
      .select({
        userId: serverBans.userId, username: users.username,
        until: serverBans.until, reason: serverBans.reason, createdAt: serverBans.createdAt,
      })
      .from(serverBans)
      .leftJoin(users, eq(users.id, serverBans.userId))
      .where(eq(serverBans.serverId, gate.server.id));
    return {
      bans: rows.map((b) => ({
        userId: b.userId,
        username: b.username ?? "unknown",
        until: b.until ? +b.until : null,
        reason: b.reason ?? null,
        createdAt: +b.createdAt,
        expired: !!b.until && +b.until <= Date.now(),
      })),
    };
  });

  const banBody = z.object({
    target: z.string().trim().min(1).max(120),
    hours: z.number().int().min(1).max(24 * 365).nullable().optional(),
    reason: z.string().trim().max(300).optional(),
  }).strict();

  app.put<{ Params: { id: string }; Body: unknown }>("/servers/:id/bans", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "ban_member");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof banBody>;
    try { body = banBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const target = await resolveServerTarget(body.target);
    if (!target.ok) { reply.code(404); return { error: target.error }; }
    if (target.userId === gate.me.id) { reply.code(409); return { error: "You can't ban yourself." }; }
    if (target.userId === gate.server.ownerUserId) { reply.code(409); return { error: "The server owner can't be banned from their own server." }; }
    const targetUser = (await db.select({ role: users.role }).from(users)
      .where(eq(users.id, target.userId)).limit(1))[0];
    if (targetUser && isModeratorRole(targetUser.role)) {
      reply.code(409); return { error: `${target.username} is site staff and can't be server-banned.` };
    }

    const until = body.hours ? new Date(Date.now() + body.hours * 3_600_000) : null;
    await db.insert(serverBans)
      .values({
        serverId: gate.server.id, userId: target.userId, until,
        reason: body.reason?.trim() ? body.reason.trim() : null, issuedById: gate.me.id,
      })
      .onConflictDoUpdate({
        target: [serverBans.serverId, serverBans.userId],
        set: { until, reason: body.reason?.trim() ? body.reason.trim() : null, issuedById: gate.me.id, createdAt: new Date() },
      });
    // A banned member/mod/admin loses their chair with the ban.
    await db.delete(serverMembers)
      .where(and(eq(serverMembers.serverId, gate.server.id), eq(serverMembers.userId, target.userId)));

    // Evict live sockets from this server's rooms (mirrors the forum ban):
    // leave the room, notify, land them in the server's landing room (or none).
    const roomIds = (await db.select({ id: rooms.id }).from(rooms)
      .where(eq(rooms.serverId, gate.server.id))).map((r) => r.id);
    if (roomIds.length) {
      const roomSet = new Set(roomIds);
      const landing = await findServerLanding(db, gate.server.id);
      const affected = new Set<string>();
      const socks = await io.fetchSockets();
      for (const s of socks) {
        if ((s.data as { userId?: string }).userId !== target.userId) continue;
        const inRoom = (s.data as { roomId?: string }).roomId;
        if (!inRoom || !roomSet.has(inRoom)) continue;
        s.leave(`room:${inRoom}`);
        affected.add(inRoom);
        s.emit("error:notice", {
          code: "SERVER_BANNED",
          message: `You have been banned from "${gate.server.name}"${until ? ` until ${until.toISOString().slice(0, 10)}` : ""}.`,
        });
        if (landing && landing.id !== inRoom) {
          s.join(`room:${landing.id}`);
          (s.data as { roomId?: string }).roomId = landing.id;
          await sendRoomBacklogTo(s, db, landing.id, target.userId);
        }
      }
      for (const rid of affected) await broadcastPresence(io, db, rid);
      if (landing && affected.size) await broadcastPresence(io, db, landing.id);
    }

    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_ban",
      targetUserId: target.userId, reason: body.reason ?? null,
      metadata: { slug: gate.server.slug, until: until ? +until : null },
    });
    return { ok: true, userId: target.userId, username: target.username };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/servers/:id/bans/:userId", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "unban_member");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const existing = (await db.select().from(serverBans)
      .where(and(eq(serverBans.serverId, gate.server.id), eq(serverBans.userId, req.params.userId))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "no such ban" }; }
    await db.delete(serverBans)
      .where(and(eq(serverBans.serverId, gate.server.id), eq(serverBans.userId, req.params.userId)));
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_unban",
      targetUserId: req.params.userId, metadata: { slug: gate.server.slug },
    });
    return { ok: true };
  });

  /* =========================================================
   *  Mod Log + transfer
   * ========================================================= */

  /** GET /servers/:id/mod-log — the server's moderation history (audit rows
   *  scoped to this server via the native serverId column). Visible to the
   *  owner + any mod holding view_mod_log. */
  app.get<{ Params: { id: string } }>("/servers/:id/mod-log", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "view_mod_log");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const rows = await db
      .select({
        id: auditLog.id, action: auditLog.action, actorUserId: auditLog.actorUserId,
        targetUserId: auditLog.targetUserId, reason: auditLog.reason,
        metadataJson: auditLog.metadataJson, createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(eq(auditLog.serverId, gate.server.id))
      .orderBy(desc(auditLog.createdAt))
      .limit(150);
    const ids = [...new Set(rows.flatMap((r) => [r.actorUserId, r.targetUserId]).filter((x): x is string => !!x))];
    const names = new Map<string, string>();
    if (ids.length) {
      for (const u of await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ids))) {
        names.set(u.id, u.username);
      }
    }
    const parseMeta = (j: string | null): Record<string, unknown> | null => {
      if (!j) return null;
      try { const v = JSON.parse(j); return v && typeof v === "object" ? v : null; } catch { return null; }
    };
    return {
      entries: rows.map((r) => ({
        id: r.id,
        action: r.action,
        actorUsername: names.get(r.actorUserId) ?? "unknown",
        targetUsername: r.targetUserId ? (names.get(r.targetUserId) ?? "unknown") : null,
        reason: r.reason ?? null,
        metadata: parseMeta(r.metadataJson),
        createdAt: +r.createdAt,
      })),
    };
  });

  const transferBody = z.object({ target: z.string().trim().min(1).max(120) }).strict();
  /** POST /servers/:id/transfer — hand the server to another member. OWNER-only
   *  (the most sensitive act; the matrix keeps it owner/staff-tier). The new
   *  owner is enrolled as role="owner"; the old owner steps down to "admin"
   *  (the lieutenant) so they keep moderation reach but lose the owner-only
   *  acts. The system/default server can't be transferred. */
  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/transfer", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerOwner(req, req.params.id);
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    if (gate.server.isSystem) { reply.code(409); return { error: "The home server can't be transferred." }; }
    let body: z.infer<typeof transferBody>;
    try { body = transferBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const target = await resolveServerTarget(body.target);
    if (!target.ok) { reply.code(404); return { error: target.error }; }
    if (target.userId === gate.server.ownerUserId) { reply.code(409); return { error: "They already own this server." }; }
    const targetUser = (await db.select({ role: users.role }).from(users)
      .where(eq(users.id, target.userId)).limit(1))[0];
    if (!targetUser) { reply.code(404); return { error: "no such user" }; }
    const ban = (await db.select().from(serverBans)
      .where(and(eq(serverBans.serverId, gate.server.id), eq(serverBans.userId, target.userId))).limit(1))[0];
    if (ban && (!ban.until || +ban.until > Date.now())) {
      reply.code(409); return { error: "That user is banned from this server - lift the ban first." };
    }
    const oldOwnerId = gate.server.ownerUserId;
    db.transaction((tx) => {
      tx.update(servers).set({ ownerUserId: target.userId, updatedAt: new Date() })
        .where(eq(servers.id, gate.server.id)).run();
      // New owner row.
      tx.insert(serverMembers)
        .values({ serverId: gate.server.id, userId: target.userId, role: "owner" })
        .onConflictDoUpdate({
          target: [serverMembers.serverId, serverMembers.userId],
          set: { role: "owner", permissionsJson: "[]" },
        }).run();
      // Old owner steps down to admin (keeps a seat, loses owner-only powers).
      tx.insert(serverMembers)
        .values({ serverId: gate.server.id, userId: oldOwnerId, role: "admin" })
        .onConflictDoUpdate({
          target: [serverMembers.serverId, serverMembers.userId],
          set: { role: "admin", permissionsJson: "[]" },
        }).run();
    });
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_transfer",
      targetUserId: target.userId, metadata: { slug: gate.server.slug, from: oldOwnerId, to: target.userId },
    });
    await notifyUser(io, target.userId, "SERVER_TRANSFERRED",
      `You are now the owner of "${gate.server.name}".`);
    return { ok: true, ownerUserId: target.userId, ownerUsername: target.username };
  });
}
