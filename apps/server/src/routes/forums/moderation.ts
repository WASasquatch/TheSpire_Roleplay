/**
 * Forum moderation surface: roles, member directory, mod-log, report queue,
 * topic prefixes, usergroups, moderator appointments, and per-forum bans.
 *
 *   GET    /forums/:id/roles | /forums/:id/user-search | /me... (no)
 *   GET    /forums/:id/mod-log | /forums/:id/members
 *   DELETE /forums/:id/members/:userId
 *   POST/GET/PATCH /forums/:id/reports[...]
 *   POST/PATCH/DELETE /forums/:id/prefixes[...]
 *   GET/POST/PATCH/DELETE /forums/:id/usergroups[...] + members
 *   PUT/PATCH/DELETE /forums/:id/mods[...]
 *   GET/PUT/DELETE /forums/:id/bans[...]
 *
 * All owner-or-granted-permission gated (forum owner / manage_any_forum staff
 * hold every key). Forum roles key on the USER account so moderation
 * authority doesn't flicker with character switches; owner actions are
 * audited for the site-staff Audit tab.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  isModeratorRole,
  FORUM_MAX_AUTO_RULES,
  FORUM_MAX_PREFIXES,
  FORUM_MAX_USERGROUPS,
  FORUM_MOD_DEFAULT_PERMISSIONS,
  FORUM_MOD_PERMISSIONS,
  FORUM_PERMISSIONS,
  FORUM_PREFIX_COLOR_RE,
  FORUM_PREFIX_LABEL_MAX,
  FORUM_PREFIX_TOOLTIP_MAX,
  FORUM_REPORT_REASON_MAX,
  FORUM_USERGROUP_NAME_MAX,
  isForumModPermission,
  isForumPermission,
  parseForumAutoRules,
  parseForumModPermissions,
  parseForumPermissions,
  serializeForumAutoRules,
  serializeForumModPermissions,
  serializeForumPermissions,
} from "@thekeep/shared";
import type {
  ForumAutoRule,
  ForumModPermission,
  ForumPermission,
  ForumUsergroupMemberWire,
  ForumUsergroupWire,
} from "@thekeep/shared";
import {
  auditLog,
  characters,
  forumBans,
  forumMembers,
  forumPrefixes,
  forumReports,
  forumUsergroupMembers,
  forumUsergroups,
  messages,
  roomThreadCategories,
  rooms,
  users,
} from "../../db/schema.js";
import type { Db } from "../../db/index.js";
import { getSessionUser } from "../auth.js";
import { forumAuthority, forumCan } from "../../forums/authority.js";
import { ensureDefaultUsergroup } from "../../forums/usergroups.js";
import { recordAudit } from "../../audit.js";
import { broadcastPresence, findCanonicalLanding, sendRoomBacklogTo } from "../../realtime/broadcast.js";
import {
  requireForumPermission as sharedRequireForumPermission,
  resolveForumTarget as sharedResolveForumTarget,
  type Io,
} from "./shared.js";

export async function registerForumModerationRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  const requireForumPermission = (
    req: Parameters<typeof getSessionUser>[0],
    forumId: string,
    key: ForumModPermission,
  ) => sharedRequireForumPermission(db, req, forumId, key);
  const resolveForumTarget = (raw: string) => sharedResolveForumTarget(db, raw);

  /* =========================================================
   *  Phase 4: Forum Moderators + roles/members/mod-log
   * ========================================================= */

  app.get<{ Params: { id: string } }>("/forums/:id/roles", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "manage_members");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const owner = (await db.select({ username: users.username, avatarUrl: users.avatarUrl }).from(users)
      .where(eq(users.id, gate.forum.ownerUserId)).limit(1))[0];
    const mods = await db
      .select({
        userId: forumMembers.userId,
        username: users.username,
        avatarUrl: users.avatarUrl,
        since: forumMembers.joinedAt,
        permissionsJson: forumMembers.permissionsJson,
      })
      .from(forumMembers)
      .leftJoin(users, eq(users.id, forumMembers.userId))
      .where(and(eq(forumMembers.forumId, gate.forum.id), eq(forumMembers.role, "mod")));
    return {
      owner: { userId: gate.forum.ownerUserId, username: owner?.username ?? "unknown", avatarUrl: owner?.avatarUrl ?? null },
      // The acting manager's own permission set, so a non-owner manager's UI
      // can disable granting keys they don't themselves hold (no escalation).
      managerPermissions: gate.authority.permissions,
      mods: mods.map((m) => ({
        userId: m.userId,
        username: m.username ?? "unknown",
        avatarUrl: m.avatarUrl ?? null,
        since: +m.since,
        permissions: parseForumModPermissions(m.permissionsJson),
      })),
    };
  });

  /**
   * GET /forums/:id/user-search?q= — typeahead for the mod/ban/member
   * pickers. Owner OR a mod holding manage_members / ban_users may search.
   * Matches a username OR character-name prefix, returns up to 12 hits
   * annotated with the account's character names + its role/ban in THIS
   * forum so the picker can disable already-mod / already-banned rows.
   */
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>("/forums/:id/user-search", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const a = await forumAuthority(db, me, req.params.id);
    if (!a.forum) { reply.code(404); return { error: "no forum" }; }
    if (!(forumCan(a, "manage_members") || forumCan(a, "ban_users"))) {
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
    const charRows = await db.select({ userId: characters.userId, name: characters.name })
      .from(characters).where(and(inArray(characters.userId, ids), isNull(characters.deletedAt)));
    const charsByUser = new Map<string, string[]>();
    for (const c of charRows) { const l = charsByUser.get(c.userId) ?? []; if (l.length < 4) l.push(c.name); charsByUser.set(c.userId, l); }
    const roleRows = await db.select({ userId: forumMembers.userId, role: forumMembers.role })
      .from(forumMembers).where(and(eq(forumMembers.forumId, a.forum.id), inArray(forumMembers.userId, ids)));
    const roleByUser = new Map(roleRows.map((r) => [r.userId, r.role] as const));
    const banRows = await db.select({ userId: forumBans.userId, until: forumBans.until })
      .from(forumBans).where(and(eq(forumBans.forumId, a.forum.id), inArray(forumBans.userId, ids)));
    const bannedSet = new Set(banRows.filter((b) => !b.until || +b.until > Date.now()).map((b) => b.userId));
    const ownerId = a.forum.ownerUserId;
    const hits = ids.map((id) => {
      const u = map.get(id)!;
      const forumRole = id === ownerId ? "owner" as const : (roleByUser.get(id) ?? null);
      return {
        userId: id,
        username: u.username,
        avatarUrl: u.avatarUrl ?? null,
        characterNames: charsByUser.get(id) ?? [],
        forumRole,
        banned: bannedSet.has(id),
      };
    });
    return { hits };
  });

  /**
   * GET /forums/:id/mod-log — the forum's moderation history. Reads audit
   * rows stamped with this forum's id (mod grants/perms/bans + topic
   * lock/sticky/move/post-delete + member removals). Visible to the owner
   * and ANY forum mod (transparency among the mod team); the server already
   * gates who can perform each action.
   */
  app.get<{ Params: { id: string } }>("/forums/:id/mod-log", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const a = await forumAuthority(db, me, req.params.id);
    if (!a.forum) { reply.code(404); return { error: "no forum" }; }
    if (!a.isMod) { reply.code(403); return { error: "forum mods only" }; }
    const rows = await db
      .select({
        id: auditLog.id, action: auditLog.action, actorUserId: auditLog.actorUserId,
        targetUserId: auditLog.targetUserId, reason: auditLog.reason,
        metadataJson: auditLog.metadataJson, createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(sql`json_extract(${auditLog.metadataJson}, '$.forumId') = ${a.forum.id}`)
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

  /**
   * GET /forums/:id/members — the Members directory (owner + mods + members).
   * Gated on manage_members. Mods carry their granular permissions so the
   * directory can show "moderator (5 powers)"; owner/members carry none.
   */
  app.get<{ Params: { id: string } }>("/forums/:id/members", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "manage_members");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const owner = (await db.select({ username: users.username, avatarUrl: users.avatarUrl })
      .from(users).where(eq(users.id, gate.forum.ownerUserId)).limit(1))[0];
    const rows = await db
      .select({
        userId: forumMembers.userId, username: users.username, avatarUrl: users.avatarUrl,
        role: forumMembers.role, permissionsJson: forumMembers.permissionsJson, joinedAt: forumMembers.joinedAt,
      })
      .from(forumMembers)
      .leftJoin(users, eq(users.id, forumMembers.userId))
      .where(eq(forumMembers.forumId, gate.forum.id));
    const members = rows
      .filter((r) => r.userId !== gate.forum.ownerUserId)
      .map((r) => ({
        userId: r.userId,
        username: r.username ?? "unknown",
        avatarUrl: r.avatarUrl ?? null,
        role: r.role,
        permissions: r.role === "mod" ? parseForumModPermissions(r.permissionsJson) : [],
        joinedAt: +r.joinedAt,
      }));
    return {
      members: [
        { userId: gate.forum.ownerUserId, username: owner?.username ?? "unknown", avatarUrl: owner?.avatarUrl ?? null, role: "owner" as const, permissions: [], joinedAt: +gate.forum.createdAt },
        ...members,
      ],
    };
  });

  /**
   * DELETE /forums/:id/members/:userId — remove a plain MEMBER from the
   * forum (manage_members). Mods must be demoted via the Roles tab first;
   * the owner can never be removed. Open-posting forums let the person
   * re-join freely; application forums make them re-apply.
   */
  app.delete<{ Params: { id: string; userId: string } }>("/forums/:id/members/:userId", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "manage_members");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    if (req.params.userId === gate.forum.ownerUserId) { reply.code(409); return { error: "The owner can't be removed." }; }
    const row = (await db.select().from(forumMembers)
      .where(and(eq(forumMembers.forumId, gate.forum.id), eq(forumMembers.userId, req.params.userId))).limit(1))[0];
    if (!row) { reply.code(404); return { error: "not a member here" }; }
    if (row.role === "mod") { reply.code(409); return { error: "Demote this moderator from the Roles tab first." }; }
    await db.delete(forumMembers)
      .where(and(eq(forumMembers.forumId, gate.forum.id), eq(forumMembers.userId, req.params.userId)));
    await recordAudit(db, {
      actorUserId: gate.me.id,
      action: "forum_member_remove",
      targetUserId: req.params.userId,
      metadata: { forumId: gate.forum.id, slug: gate.forum.slug },
    });
    return { ok: true };
  });

  /* ============================================================
   * Report queue (Phase 4)
   * ============================================================ */

  const reportBody = z.object({
    messageId: z.string().min(1).max(64),
    reason: z.string().trim().min(1).max(FORUM_REPORT_REASON_MAX),
  }).strict();

  app.post<{ Params: { id: string }; Body: unknown }>("/forums/:id/reports", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const a = await forumAuthority(db, me, req.params.id);
    if (!a.forum) { reply.code(404); return { error: "no forum" }; }
    if (a.ban) { reply.code(403); return { error: "You are banned from this forum." }; }
    let body: z.infer<typeof reportBody>;
    try { body = reportBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const msg = (await db.select().from(messages).where(eq(messages.id, body.messageId)).limit(1))[0];
    if (!msg || msg.deletedAt) { reply.code(404); return { error: "That post no longer exists." }; }
    // The post must live on a board of THIS forum.
    const room = (await db.select({ forumId: rooms.forumId }).from(rooms).where(eq(rooms.id, msg.roomId)).limit(1))[0];
    if (room?.forumId !== a.forum.id) { reply.code(400); return { error: "That post isn't in this forum." }; }
    // Don't let someone report their own post (use edit/delete), and dedupe
    // an existing OPEN report by this reporter for this post.
    if (msg.userId === me.id) { reply.code(409); return { error: "You can't report your own post." }; }
    const existing = (await db.select({ id: forumReports.id }).from(forumReports)
      .where(and(
        eq(forumReports.forumId, a.forum.id),
        eq(forumReports.messageId, msg.id),
        eq(forumReports.reporterUserId, me.id),
        eq(forumReports.status, "open"),
      )).limit(1))[0];
    if (existing) return { ok: true, already: true };
    try {
      await db.insert(forumReports).values({
        id: nanoid(),
        forumId: a.forum.id,
        messageId: msg.id,
        boardRoomId: msg.roomId,
        topicId: msg.replyToId ?? msg.id,
        reporterUserId: me.id,
        reason: body.reason,
      });
    } catch (err) {
      // The pre-check above handles the sequential re-report; this catches the
      // CONCURRENT race where two requests both pass it. The partial unique
      // index (migration 0265: one OPEN report per forum+message+reporter) is
      // the DB backstop — treat its violation as the same graceful "already
      // reported" rather than letting it surface as a 500.
      if (err instanceof Error && /unique/i.test(err.message)) return { ok: true, already: true };
      throw err;
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>("/forums/:id/reports", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "handle_reports");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const status = req.query.status === "resolved" || req.query.status === "dismissed" ? req.query.status : "open";
    const rows = await db.select().from(forumReports)
      .where(and(eq(forumReports.forumId, gate.forum.id), eq(forumReports.status, status)))
      .orderBy(desc(forumReports.createdAt))
      .limit(100);
    // Batch-resolve reporter/resolver usernames, post author + body, topic titles.
    const userIds = [...new Set(rows.flatMap((r) => [r.reporterUserId, r.resolvedByUserId]).filter((x): x is string => !!x))];
    const msgIds = [...new Set(rows.flatMap((r) => [r.messageId, r.topicId]).filter((x): x is string => !!x))];
    const names = new Map<string, string>();
    if (userIds.length) for (const u of await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds))) names.set(u.id, u.username);
    const msgMap = new Map<string, { displayName: string; body: string; title: string | null; deletedAt: Date | null }>();
    if (msgIds.length) for (const m of await db.select({ id: messages.id, displayName: messages.displayName, body: messages.body, title: messages.title, deletedAt: messages.deletedAt }).from(messages).where(inArray(messages.id, msgIds))) {
      msgMap.set(m.id, { displayName: m.displayName, body: m.body, title: m.title, deletedAt: m.deletedAt });
    }
    return {
      reports: rows.map((r) => {
        const post = msgMap.get(r.messageId);
        const topic = r.topicId ? msgMap.get(r.topicId) : null;
        const snippet = post ? (post.deletedAt ? "[deleted]" : post.body.replace(/\s+/g, " ").slice(0, 160)) : "[gone]";
        return {
          id: r.id,
          status: r.status,
          reason: r.reason,
          reporterUsername: names.get(r.reporterUserId) ?? "unknown",
          reportedAuthorName: post?.displayName ?? "unknown",
          reportedSnippet: snippet,
          messageId: r.messageId,
          topicId: r.topicId ?? null,
          topicTitle: topic?.title ?? null,
          boardRoomId: r.boardRoomId ?? null,
          createdAt: +r.createdAt,
          resolvedByUsername: r.resolvedByUserId ? (names.get(r.resolvedByUserId) ?? "unknown") : null,
          resolutionNote: r.resolutionNote ?? null,
          resolvedAt: r.resolvedAt ? +r.resolvedAt : null,
        };
      }),
    };
  });

  const resolveReportBody = z.object({
    action: z.enum(["resolve", "dismiss"]),
    note: z.string().trim().max(300).optional(),
  }).strict();
  app.patch<{ Params: { id: string; reportId: string }; Body: unknown }>("/forums/:id/reports/:reportId", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "handle_reports");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof resolveReportBody>;
    try { body = resolveReportBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const row = (await db.select().from(forumReports)
      .where(and(eq(forumReports.id, req.params.reportId), eq(forumReports.forumId, gate.forum.id))).limit(1))[0];
    if (!row) { reply.code(404); return { error: "no such report" }; }
    await db.update(forumReports).set({
      status: body.action === "resolve" ? "resolved" : "dismissed",
      resolvedByUserId: gate.me.id,
      resolutionNote: body.note ?? null,
      resolvedAt: new Date(),
    }).where(eq(forumReports.id, row.id));
    await recordAudit(db, {
      actorUserId: gate.me.id,
      action: "forum_report_resolve",
      targetMessageId: row.messageId,
      reason: body.note ?? null,
      metadata: { forumId: gate.forum.id, slug: gate.forum.slug, outcome: body.action },
    });
    return { ok: true };
  });

  /* ============================================================
   * Topic prefixes (Phase 5) — owner-curated chip catalog
   * ============================================================ */
  /** Keep only the ids that are real categories under THIS forum's boards —
   *  a stale/foreign category id can't be smuggled into a tag's scope. */
  async function validPrefixCategoryIds(forumId: string, ids: string[] | undefined): Promise<string[]> {
    if (!ids || ids.length === 0) return [];
    const boardIds = (await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.forumId, forumId))).map((r) => r.id);
    if (!boardIds.length) return [];
    const valid = new Set(
      (await db.select({ id: roomThreadCategories.id }).from(roomThreadCategories)
        .where(inArray(roomThreadCategories.roomId, boardIds))).map((c) => c.id),
    );
    return [...new Set(ids)].filter((id) => valid.has(id));
  }

  /** Who may CREATE a tag: a full curator (manage_prefixes) always, OR — when
   *  the forum allows custom tags — a mod with create_tags (who only gets to
   *  mint a GLOBAL tag, no category scoping or recolor of the catalog). */
  async function gateCreatePrefix(req: Parameters<typeof getSessionUser>[0], forumId: string) {
    const me = await getSessionUser(req, db);
    if (!me) return { fail: { code: 401 as const, error: "auth" } };
    const a = await forumAuthority(db, me, forumId);
    if (!a.forum) return { fail: { code: 404 as const, error: "no forum" } };
    const canManage = forumCan(a, "manage_prefixes");
    const canCustom = !!a.forum.allowCustomTags && forumCan(a, "create_tags");
    if (!canManage && !canCustom) return { fail: { code: 403 as const, error: "you can't add tags to this forum" } };
    return { me, forum: a.forum, authority: a, canManage };
  }

  const prefixBody = z.object({
    label: z.string().trim().min(1).max(FORUM_PREFIX_LABEL_MAX),
    color: z.string().regex(FORUM_PREFIX_COLOR_RE),
    tooltip: z.string().trim().max(FORUM_PREFIX_TOOLTIP_MAX).nullable().optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
    categoryIds: z.array(z.string().min(1)).max(100).optional(),
    staffOnly: z.boolean().optional(),
  }).strict();

  app.post<{ Params: { id: string }; Body: unknown }>("/forums/:id/prefixes", async (req, reply) => {
    const gate = await gateCreatePrefix(req, req.params.id);
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof prefixBody>;
    try { body = prefixBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const count = Number((await db.select({ n: sql<number>`count(*)` }).from(forumPrefixes).where(eq(forumPrefixes.forumId, gate.forum.id)))[0]?.n ?? 0);
    if (count >= FORUM_MAX_PREFIXES) { reply.code(409); return { error: `A forum can have at most ${FORUM_MAX_PREFIXES} prefixes.` }; }
    // Category scope + staff-only only honored for full curators; a create_tags
    // mint is always a plain, member-assignable global tag.
    const categoryIds = gate.canManage ? await validPrefixCategoryIds(gate.forum.id, body.categoryIds) : [];
    const staffOnly = gate.canManage ? !!body.staffOnly : false;
    const tooltip = body.tooltip?.trim() ? body.tooltip.trim() : null;
    const id = nanoid();
    await db.insert(forumPrefixes).values({ id, forumId: gate.forum.id, label: body.label, color: body.color, tooltip, sortOrder: body.sortOrder ?? count, categoryIdsJson: JSON.stringify(categoryIds), staffOnly });
    return { ok: true, id };
  });

  const patchPrefixBody = z.object({
    label: z.string().trim().min(1).max(FORUM_PREFIX_LABEL_MAX).optional(),
    color: z.string().regex(FORUM_PREFIX_COLOR_RE).optional(),
    tooltip: z.string().trim().max(FORUM_PREFIX_TOOLTIP_MAX).nullable().optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
    categoryIds: z.array(z.string().min(1)).max(100).optional(),
    staffOnly: z.boolean().optional(),
  }).strict();
  app.patch<{ Params: { id: string; prefixId: string }; Body: unknown }>("/forums/:id/prefixes/:prefixId", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "manage_prefixes");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof patchPrefixBody>;
    try { body = patchPrefixBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const row = (await db.select({ id: forumPrefixes.id }).from(forumPrefixes)
      .where(and(eq(forumPrefixes.id, req.params.prefixId), eq(forumPrefixes.forumId, gate.forum.id))).limit(1))[0];
    if (!row) { reply.code(404); return { error: "no such prefix" }; }
    await db.update(forumPrefixes).set({
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.color !== undefined ? { color: body.color } : {}),
      ...(body.tooltip !== undefined ? { tooltip: body.tooltip?.trim() ? body.tooltip.trim() : null } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      ...(body.categoryIds !== undefined ? { categoryIdsJson: JSON.stringify(await validPrefixCategoryIds(gate.forum.id, body.categoryIds)) } : {}),
      ...(body.staffOnly !== undefined ? { staffOnly: body.staffOnly } : {}),
    }).where(eq(forumPrefixes.id, row.id));
    return { ok: true };
  });

  app.delete<{ Params: { id: string; prefixId: string } }>("/forums/:id/prefixes/:prefixId", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "manage_prefixes");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    await db.delete(forumPrefixes)
      .where(and(eq(forumPrefixes.id, req.params.prefixId), eq(forumPrefixes.forumId, gate.forum.id)));
    return { ok: true };
  });

  /* ============================================================
   * Usergroups (migration 0270) — the unified permission registry
   * ============================================================ */

  /** Clamp a group's permission set to what the actor may grant (anti-
   *  escalation). Owner/staff grant anything. */
  function clampForumPerms(requested: ForumPermission[], actorPerms: ForumPermission[], isOwner: boolean): ForumPermission[] {
    if (isOwner) return requested;
    const allowed = new Set(actorPerms);
    return requested.filter((p) => allowed.has(p));
  }

  /** Drop posted_in_category rules whose category isn't in this forum. */
  async function validAutoRules(forumId: string, rules: ForumAutoRule[]): Promise<ForumAutoRule[]> {
    const catIds = rules.flatMap((r) => (r.kind === "posted_in_category" ? [r.categoryId] : []));
    if (!catIds.length) return rules;
    const valid = new Set(await validPrefixCategoryIds(forumId, catIds));
    return rules.filter((r) => r.kind !== "posted_in_category" || valid.has(r.categoryId));
  }

  const groupBody = z.object({
    name: z.string().trim().min(1).max(FORUM_USERGROUP_NAME_MAX),
    color: z.string().regex(FORUM_PREFIX_COLOR_RE).nullable().optional(),
    permissions: z.array(z.string()).max(FORUM_PERMISSIONS.length + 5).optional(),
    autoRules: z.array(z.unknown()).max(FORUM_MAX_AUTO_RULES + 2).optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  }).strict();
  const patchGroupBody = z.object({
    name: z.string().trim().min(1).max(FORUM_USERGROUP_NAME_MAX).optional(),
    color: z.string().regex(FORUM_PREFIX_COLOR_RE).nullable().optional(),
    permissions: z.array(z.string()).max(FORUM_PERMISSIONS.length + 5).optional(),
    autoRules: z.array(z.unknown()).max(FORUM_MAX_AUTO_RULES + 2).optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  }).strict();

  app.get<{ Params: { id: string } }>("/forums/:id/usergroups", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    await ensureDefaultUsergroup(db, gate.forum.id);
    const rows = await db.select().from(forumUsergroups)
      .where(eq(forumUsergroups.forumId, gate.forum.id))
      .orderBy(desc(forumUsergroups.isDefault), asc(forumUsergroups.sortOrder), asc(forumUsergroups.createdAt));
    const ids = rows.map((g) => g.id);
    const counts = ids.length
      ? await db.select({ groupId: forumUsergroupMembers.groupId, n: sql<number>`count(*)` })
          .from(forumUsergroupMembers).where(inArray(forumUsergroupMembers.groupId, ids))
          .groupBy(forumUsergroupMembers.groupId)
      : [];
    const countMap = new Map(counts.map((c) => [c.groupId, Number(c.n)]));
    const groups: ForumUsergroupWire[] = rows.map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color ?? null,
      permissions: parseForumPermissions(g.permissionsJson),
      isDefault: !!g.isDefault,
      sortOrder: g.sortOrder,
      autoRules: parseForumAutoRules(g.autoRulesJson),
      memberCount: g.isDefault ? 0 : (countMap.get(g.id) ?? 0),
    }));
    // managerPermissions lets the client grey out keys the manager can't grant.
    return { groups, managerPermissions: gate.authority.permissions };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/forums/:id/usergroups", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof groupBody>;
    try { body = groupBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const count = Number((await db.select({ n: sql<number>`count(*)` }).from(forumUsergroups).where(eq(forumUsergroups.forumId, gate.forum.id)))[0]?.n ?? 0);
    if (count >= FORUM_MAX_USERGROUPS) { reply.code(409); return { error: `A forum can have at most ${FORUM_MAX_USERGROUPS} usergroups.` }; }
    const requested = (body.permissions ?? []).filter(isForumPermission) as ForumPermission[];
    const perms = clampForumPerms(requested, gate.authority.permissions, gate.authority.isOwner);
    const rules = await validAutoRules(gate.forum.id, parseForumAutoRules(JSON.stringify(body.autoRules ?? [])));
    const id = nanoid();
    await db.insert(forumUsergroups).values({
      id, forumId: gate.forum.id, name: body.name, color: body.color ?? null,
      permissionsJson: serializeForumPermissions(perms),
      isDefault: false, sortOrder: body.sortOrder ?? count,
      autoRulesJson: serializeForumAutoRules(rules),
    });
    await recordAudit(db, { actorUserId: gate.me.id, action: "forum_usergroup_change",
      metadata: { forumId: gate.forum.id, slug: gate.forum.slug, op: "create", group: body.name, permissions: perms } });
    return { ok: true, id };
  });

  app.patch<{ Params: { id: string; gid: string }; Body: unknown }>("/forums/:id/usergroups/:gid", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const group = (await db.select().from(forumUsergroups)
      .where(and(eq(forumUsergroups.id, req.params.gid), eq(forumUsergroups.forumId, gate.forum.id))).limit(1))[0];
    if (!group) { reply.code(404); return { error: "no such usergroup" }; }
    let body: z.infer<typeof patchGroupBody>;
    try { body = patchGroupBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const update: Partial<typeof forumUsergroups.$inferInsert> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.color !== undefined) update.color = body.color ?? null;
    if (body.permissions !== undefined) {
      const requested = body.permissions.filter(isForumPermission) as ForumPermission[];
      const clamped = clampForumPerms(requested, gate.authority.permissions, gate.authority.isOwner);
      // Preserve perms the group already has that the actor can't grant — a
      // lesser manager (who sees those as checked-but-disabled) must not strip
      // them just by saving. They can only add/remove WITHIN their own powers.
      const preserved = gate.authority.isOwner
        ? []
        : parseForumPermissions(group.permissionsJson).filter((p) => !gate.authority.permissions.includes(p));
      update.permissionsJson = serializeForumPermissions([...new Set([...clamped, ...preserved])]);
    }
    // The default group is "everyone", so auto-rules are meaningless on it.
    if (body.autoRules !== undefined && !group.isDefault) {
      update.autoRulesJson = serializeForumAutoRules(await validAutoRules(gate.forum.id, parseForumAutoRules(JSON.stringify(body.autoRules))));
    }
    if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
    if (Object.keys(update).length) {
      await db.update(forumUsergroups).set(update).where(eq(forumUsergroups.id, group.id));
      await recordAudit(db, { actorUserId: gate.me.id, action: "forum_usergroup_change",
        metadata: { forumId: gate.forum.id, slug: gate.forum.slug, op: "edit", group: update.name ?? group.name } });
    }
    return { ok: true };
  });

  app.delete<{ Params: { id: string; gid: string } }>("/forums/:id/usergroups/:gid", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const group = (await db.select().from(forumUsergroups)
      .where(and(eq(forumUsergroups.id, req.params.gid), eq(forumUsergroups.forumId, gate.forum.id))).limit(1))[0];
    if (!group) { reply.code(404); return { error: "no such usergroup" }; }
    if (group.isDefault) { reply.code(400); return { error: "The default group can't be deleted." }; }
    await db.delete(forumUsergroups).where(eq(forumUsergroups.id, group.id)); // cascades members
    await recordAudit(db, { actorUserId: gate.me.id, action: "forum_usergroup_change",
      metadata: { forumId: gate.forum.id, slug: gate.forum.slug, op: "delete", group: group.name } });
    return { ok: true };
  });

  app.get<{ Params: { id: string; gid: string } }>("/forums/:id/usergroups/:gid/members", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const group = (await db.select().from(forumUsergroups)
      .where(and(eq(forumUsergroups.id, req.params.gid), eq(forumUsergroups.forumId, gate.forum.id))).limit(1))[0];
    if (!group) { reply.code(404); return { error: "no such usergroup" }; }
    if (group.isDefault) return { members: [] as ForumUsergroupMemberWire[] }; // everyone; not enumerated
    const rows = await db
      .select({ userId: forumUsergroupMembers.userId, username: users.username, avatarUrl: users.avatarUrl, isAuto: forumUsergroupMembers.isAuto, addedAt: forumUsergroupMembers.addedAt })
      .from(forumUsergroupMembers)
      .leftJoin(users, eq(users.id, forumUsergroupMembers.userId))
      .where(eq(forumUsergroupMembers.groupId, group.id))
      .orderBy(desc(forumUsergroupMembers.addedAt));
    const members: ForumUsergroupMemberWire[] = rows.map((r) => ({
      userId: r.userId, username: r.username ?? "unknown", avatarUrl: r.avatarUrl ?? null, isAuto: !!r.isAuto, addedAt: +r.addedAt,
    }));
    return { members };
  });

  const groupMemberBody = z.object({ target: z.string().trim().min(1).max(120) }).strict();
  app.put<{ Params: { id: string; gid: string }; Body: unknown }>("/forums/:id/usergroups/:gid/members", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const group = (await db.select().from(forumUsergroups)
      .where(and(eq(forumUsergroups.id, req.params.gid), eq(forumUsergroups.forumId, gate.forum.id))).limit(1))[0];
    if (!group) { reply.code(404); return { error: "no such usergroup" }; }
    if (group.isDefault) { reply.code(400); return { error: "Everyone already belongs to the default group." }; }
    let body: z.infer<typeof groupMemberBody>;
    try { body = groupMemberBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const target = await resolveForumTarget(body.target);
    if (!target.ok) { reply.code(404); return { error: target.error }; }
    await db.insert(forumUsergroupMembers)
      .values({ groupId: group.id, userId: target.userId, addedBy: gate.me.id, isAuto: false })
      .onConflictDoNothing();
    await recordAudit(db, { actorUserId: gate.me.id, action: "forum_usergroup_change", targetUserId: target.userId,
      metadata: { forumId: gate.forum.id, slug: gate.forum.slug, op: "add_member", group: group.name } });
    return { ok: true, username: target.username };
  });

  app.delete<{ Params: { id: string; gid: string; userId: string } }>("/forums/:id/usergroups/:gid/members/:userId", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "manage_usergroups");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const group = (await db.select().from(forumUsergroups)
      .where(and(eq(forumUsergroups.id, req.params.gid), eq(forumUsergroups.forumId, gate.forum.id))).limit(1))[0];
    if (!group) { reply.code(404); return { error: "no such usergroup" }; }
    if (group.isDefault) { reply.code(400); return { error: "The default group has no removable members." }; }
    await db.delete(forumUsergroupMembers)
      .where(and(eq(forumUsergroupMembers.groupId, group.id), eq(forumUsergroupMembers.userId, req.params.userId)));
    await recordAudit(db, { actorUserId: gate.me.id, action: "forum_usergroup_change", targetUserId: req.params.userId,
      metadata: { forumId: gate.forum.id, slug: gate.forum.slug, op: "remove_member", group: group.name } });
    return { ok: true };
  });

  /* ============================================================
   * Forum moderators — appoint / edit perms / revoke
   * ============================================================ */

  /** Optional explicit grant list on appoint/edit; bad/unknown keys dropped.
   *  Omitted on appoint → the default "topic janitor" set. */
  const modPermsSchema = z.array(z.string()).max(FORUM_MOD_PERMISSIONS.length + 5).optional();
  const modBody = z.object({
    target: z.string().trim().min(1).max(120),
    permissions: modPermsSchema,
  }).strict();

  /** Clamp a requested permission set to what the ACTOR may grant: a
   *  non-owner manager can never grant a key they don't hold themselves
   *  (prevents a `manage_members` mod from escalating a peer past their
   *  own powers). The owner/staff hold every key so they clamp to nothing. */
  function clampGrant(requested: ForumModPermission[], actorPerms: ForumPermission[], isOwner: boolean): ForumModPermission[] {
    if (isOwner) return requested;
    const allowed = new Set(actorPerms);
    return requested.filter((p) => allowed.has(p));
  }

  app.put<{ Params: { id: string }; Body: unknown }>("/forums/:id/mods", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "manage_members");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof modBody>;
    try { body = modBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const target = await resolveForumTarget(body.target);
    if (!target.ok) { reply.code(404); return { error: target.error }; }
    if (target.userId === gate.forum.ownerUserId) {
      reply.code(409); return { error: "The owner already holds every power - no mod chair needed." };
    }
    const ban = (await db.select().from(forumBans)
      .where(and(eq(forumBans.forumId, gate.forum.id), eq(forumBans.userId, target.userId))).limit(1))[0];
    if (ban && (!ban.until || +ban.until > Date.now())) {
      reply.code(409); return { error: `${target.username} is banned from this forum - lift the ban first.` };
    }
    const requested = body.permissions
      ? (body.permissions.filter(isForumModPermission) as ForumModPermission[])
      : FORUM_MOD_DEFAULT_PERMISSIONS;
    const perms = clampGrant(requested, gate.authority.permissions, gate.authority.isOwner);
    await db.insert(forumMembers)
      .values({ forumId: gate.forum.id, userId: target.userId, role: "mod", permissionsJson: serializeForumModPermissions(perms) })
      .onConflictDoUpdate({
        target: [forumMembers.forumId, forumMembers.userId],
        set: { role: "mod", permissionsJson: serializeForumModPermissions(perms) },
      });
    await recordAudit(db, {
      actorUserId: gate.me.id,
      action: "forum_mod_grant",
      targetUserId: target.userId,
      metadata: { forumId: gate.forum.id, slug: gate.forum.slug, permissions: perms },
    });
    return { ok: true, userId: target.userId, username: target.username, permissions: perms };
  });

  /** Edit an existing mod's granular permissions (Roles tab checkboxes). */
  const setModPermsBody = z.object({ permissions: z.array(z.string()).max(FORUM_MOD_PERMISSIONS.length + 5) }).strict();
  app.patch<{ Params: { id: string; userId: string }; Body: unknown }>("/forums/:id/mods/:userId", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "manage_members");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof setModPermsBody>;
    try { body = setModPermsBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const row = (await db.select().from(forumMembers)
      .where(and(
        eq(forumMembers.forumId, gate.forum.id),
        eq(forumMembers.userId, req.params.userId),
        eq(forumMembers.role, "mod"),
      )).limit(1))[0];
    if (!row) { reply.code(404); return { error: "not a mod here" }; }
    const requested = body.permissions.filter(isForumModPermission) as ForumModPermission[];
    const perms = clampGrant(requested, gate.authority.permissions, gate.authority.isOwner);
    await db.update(forumMembers).set({ permissionsJson: serializeForumModPermissions(perms) })
      .where(and(eq(forumMembers.forumId, gate.forum.id), eq(forumMembers.userId, req.params.userId)));
    await recordAudit(db, {
      actorUserId: gate.me.id,
      action: "forum_mod_perms",
      targetUserId: req.params.userId,
      metadata: { forumId: gate.forum.id, slug: gate.forum.slug, permissions: perms },
    });
    return { ok: true, permissions: perms };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/forums/:id/mods/:userId", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "manage_members");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const row = (await db.select().from(forumMembers)
      .where(and(
        eq(forumMembers.forumId, gate.forum.id),
        eq(forumMembers.userId, req.params.userId),
        eq(forumMembers.role, "mod"),
      )).limit(1))[0];
    if (!row) { reply.code(404); return { error: "not a mod here" }; }
    // Application forums keep the person as a plain member (they were
    // approved once); open forums don't need the row at all.
    if (gate.forum.postingMode === "application") {
      await db.update(forumMembers).set({ role: "member" })
        .where(and(eq(forumMembers.forumId, gate.forum.id), eq(forumMembers.userId, req.params.userId)));
    } else {
      await db.delete(forumMembers)
        .where(and(eq(forumMembers.forumId, gate.forum.id), eq(forumMembers.userId, req.params.userId)));
    }
    await recordAudit(db, {
      actorUserId: gate.me.id,
      action: "forum_mod_revoke",
      targetUserId: req.params.userId,
      metadata: { forumId: gate.forum.id, slug: gate.forum.slug },
    });
    return { ok: true };
  });

  /* ============================================================
   * Per-forum bans
   * ============================================================ */

  app.get<{ Params: { id: string } }>("/forums/:id/bans", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "ban_users");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const rows = await db
      .select({
        userId: forumBans.userId,
        username: users.username,
        until: forumBans.until,
        reason: forumBans.reason,
        createdAt: forumBans.createdAt,
      })
      .from(forumBans)
      .leftJoin(users, eq(users.id, forumBans.userId))
      .where(eq(forumBans.forumId, gate.forum.id));
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
    /** Hours until the ban lifts; null/omitted = permanent. */
    hours: z.number().int().min(1).max(24 * 365).nullable().optional(),
    reason: z.string().trim().max(300).optional(),
  }).strict();

  app.put<{ Params: { id: string }; Body: unknown }>("/forums/:id/bans", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "ban_users");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof banBody>;
    try { body = banBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const target = await resolveForumTarget(body.target);
    if (!target.ok) { reply.code(404); return { error: target.error }; }
    if (target.userId === gate.me.id) { reply.code(409); return { error: "You can't ban yourself." }; }
    if (target.userId === gate.forum.ownerUserId) { reply.code(409); return { error: "The forum owner can't be banned from their own forum." }; }
    const targetUser = (await db.select({ role: users.role }).from(users)
      .where(eq(users.id, target.userId)).limit(1))[0];
    if (targetUser && isModeratorRole(targetUser.role)) {
      // Mirrors the block feature's posture: site staff can't be walled
      // out of public surfaces they may need to moderate.
      reply.code(409); return { error: `${target.username} is site staff and can't be forum-banned.` };
    }

    const until = body.hours ? new Date(Date.now() + body.hours * 3_600_000) : null;
    await db.insert(forumBans)
      .values({
        forumId: gate.forum.id,
        userId: target.userId,
        until,
        reason: body.reason?.trim() ? body.reason.trim() : null,
        issuedById: gate.me.id,
      })
      .onConflictDoUpdate({
        target: [forumBans.forumId, forumBans.userId],
        set: {
          until,
          reason: body.reason?.trim() ? body.reason.trim() : null,
          issuedById: gate.me.id,
          createdAt: new Date(),
        },
      });
    // A banned mod/member loses their chair with the ban.
    await db.delete(forumMembers)
      .where(and(eq(forumMembers.forumId, gate.forum.id), eq(forumMembers.userId, target.userId)));

    // Evict live sockets from this forum's boards (mirrors /kick): leave
    // the board room, notify, land them in the canonical landing room.
    const boardIds = (await db.select({ id: rooms.id }).from(rooms)
      .where(eq(rooms.forumId, gate.forum.id))).map((r) => r.id);
    if (boardIds.length) {
      const boardSet = new Set(boardIds);
      const landing = await findCanonicalLanding(db);
      const affectedRooms = new Set<string>();
      const socks = await io.fetchSockets();
      for (const s of socks) {
        if ((s.data as { userId?: string }).userId !== target.userId) continue;
        const inRoom = (s.data as { roomId?: string }).roomId;
        if (!inRoom || !boardSet.has(inRoom)) continue;
        s.leave(`room:${inRoom}`);
        affectedRooms.add(inRoom);
        s.emit("error:notice", {
          code: "FORUM_BANNED",
          message: `You have been banned from the "${gate.forum.name}" forum${until ? ` until ${until.toISOString().slice(0, 10)}` : ""}.`,
        });
        if (landing) {
          s.join(`room:${landing.id}`);
          (s.data as { roomId?: string }).roomId = landing.id;
          await sendRoomBacklogTo(s, db, landing.id, target.userId);
        }
      }
      for (const rid of affectedRooms) await broadcastPresence(io, db, rid);
      if (landing && affectedRooms.size) await broadcastPresence(io, db, landing.id);
    }

    await recordAudit(db, {
      actorUserId: gate.me.id,
      action: "forum_ban",
      targetUserId: target.userId,
      reason: body.reason ?? null,
      metadata: { forumId: gate.forum.id, slug: gate.forum.slug, until: until ? +until : null },
    });
    return { ok: true, userId: target.userId, username: target.username };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/forums/:id/bans/:userId", async (req, reply) => {
    const gate = await requireForumPermission(req, req.params.id, "ban_users");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const existing = (await db.select().from(forumBans)
      .where(and(eq(forumBans.forumId, gate.forum.id), eq(forumBans.userId, req.params.userId))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "no such ban" }; }
    await db.delete(forumBans)
      .where(and(eq(forumBans.forumId, gate.forum.id), eq(forumBans.userId, req.params.userId)));
    await recordAudit(db, {
      actorUserId: gate.me.id,
      action: "forum_unban",
      targetUserId: req.params.userId,
      metadata: { forumId: gate.forum.id, slug: gate.forum.slug },
    });
    return { ok: true };
  });
}
