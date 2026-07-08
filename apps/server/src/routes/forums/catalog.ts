/**
 * Forums catalog + discovery + curation routes.
 *
 *   GET   /forums                     ForumSummary[] (catalog rail)
 *   GET   /forums/discover            { popular, new } rails
 *   GET   /forums/discover/search     ?q / ?tag filtered summaries
 *   GET   /forums/tags                tag facet list
 *   GET   /forums/:idOrSlug           ForumDetail (content pane)
 *   GET   /me/forums                  forums the viewer owns / moderates
 *   POST  /forums/:id/visit           stamp a rail visit marker
 *   GET   /admin/forums               curation list (view_admin_forums)
 *   PATCH /admin/forums/:id           feature / archive / restore
 *
 * The browse endpoints are ANONYMOUS-TOLERANT by design: they expose only
 * public fields, and the public `/f/<slug>` page reuses them for logged-out
 * visitors (viewer: null).
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  hasTag,
  parseTagsJson,
  parsePrefixCategoryIds,
  parseForumModPermissions,
  FORUM_MOD_PERMISSIONS,
} from "@thekeep/shared";
import type {
  ForumBoardSummary,
  ForumCategoryRef,
  ForumDetail,
  ForumModPermission,
  ForumSummary,
  ForumViewerState,
} from "@thekeep/shared";
import {
  forumMembers,
  forumMembershipApplications,
  forumPrefixes,
  forums,
  messages,
  roomThreadCategories,
  rooms,
  servers,
  users,
  worlds,
} from "../../db/schema.js";
import type { Db } from "../../db/index.js";
import { getSessionUser } from "../auth.js";
import { hasPermission } from "../../auth/permissions.js";
import { forumAuthority } from "../../forums/authority.js";
import { catalogRank, type Io } from "./shared.js";

export async function registerForumCatalogRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  // Per-IP cap for the PUBLIC, DB-heavy browse/read routes (forum list,
  // discover, discover search, tags, forum detail). Click-driven, not
  // polled; 60/min is generous vs a human browsing while capping a
  // refetch/reconnect loop at 1/s. Bump to 120 if a busy shared IP trips it.
  const browseLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } } as const;

  app.get("/forums", browseLimit, async (req) => {
    // Session is optional (see file header). Signed-in viewers also get
    // the per-forum `unseen` flag from their visit markers.
    const me = await getSessionUser(req, db).catch(() => null);

    const rows = await db
      .select({
        id: forums.id,
        slug: forums.slug,
        name: forums.name,
        tagline: forums.tagline,
        logoUrl: forums.logoUrl,
        status: forums.status,
        postingMode: forums.postingMode,
        isSystem: forums.isSystem,
        ownerUserId: forums.ownerUserId,
        ownerUsername: users.username,
        tagsJson: forums.tagsJson,
        createdAt: forums.createdAt,
      })
      .from(forums)
      .leftJoin(users, eq(users.id, forums.ownerUserId))
      .where(sql`${forums.status} != 'archived'`);

    // Aggregates in three grouped queries (cheap at catalog scale) rather
    // than N+1 per forum.
    const boardCounts = await db
      .select({ forumId: rooms.forumId, n: sql<number>`count(*)` })
      .from(rooms)
      .where(and(isNotNull(rooms.forumId), isNull(rooms.archivedAt)))
      .groupBy(rooms.forumId);
    const memberCounts = await db
      .select({ forumId: forumMembers.forumId, n: sql<number>`count(*)` })
      .from(forumMembers)
      .groupBy(forumMembers.forumId);
    // Last topic/reply activity per forum: max over its boards' topic rows.
    // Topic rows carry last_activity_at (bumped by replies); created_at
    // covers topics that never got a reply.
    const activity = await db
      .select({
        forumId: rooms.forumId,
        last: sql<number | null>`max(coalesce(${messages.lastActivityAt}, ${messages.createdAt}))`,
      })
      .from(messages)
      .innerJoin(rooms, eq(rooms.id, messages.roomId))
      .where(and(isNotNull(rooms.forumId), isNotNull(messages.title), isNull(messages.deletedAt)))
      .groupBy(rooms.forumId);

    const boardsBy = new Map(boardCounts.map((r) => [r.forumId, r.n]));
    const membersBy = new Map(memberCounts.map((r) => [r.forumId, r.n]));
    const activityBy = new Map(activity.map((r) => [r.forumId, r.last]));

    // Visit markers → unseen dots. One indexed read for the whole rail.
    const { forumVisits } = await import("../../db/schema.js");
    const visitsBy = me
      ? new Map((await db
          .select({ forumId: forumVisits.forumId, at: forumVisits.lastVisitAt })
          .from(forumVisits)
          .where(eq(forumVisits.userId, me.id))).map((v) => [v.forumId, +v.at]))
      : null;

    // The viewer's own membership rows → role per forum (owner is always
    // a member row, see the creation transaction). Drives the Tools-menu
    // bookmark list (owned + joined forums) without a per-forum detail fetch.
    const rolesBy = me
      ? new Map((await db
          .select({ forumId: forumMembers.forumId, role: forumMembers.role })
          .from(forumMembers)
          .where(eq(forumMembers.userId, me.id))).map((r) => [r.forumId, r.role]))
      : null;

    const out: ForumSummary[] = rows.map((f) => ({
      id: f.id,
      slug: f.slug,
      name: f.name,
      tagline: f.tagline ?? null,
      logoUrl: f.logoUrl ?? null,
      status: f.status,
      postingMode: f.postingMode,
      isSystem: !!f.isSystem,
      ownerUserId: f.ownerUserId,
      ownerUsername: f.ownerUsername ?? "unknown",
      boardCount: boardsBy.get(f.id) ?? 0,
      memberCount: membersBy.get(f.id) ?? 0,
      tags: parseTagsJson(f.tagsJson),
      lastActivityAt: activityBy.get(f.id) ?? null,
      createdAt: +f.createdAt,
      ...(visitsBy
        ? {
            unseen: (() => {
              const last = activityBy.get(f.id);
              if (!last) return false;
              const seen = visitsBy.get(f.id);
              return !seen || last > seen;
            })(),
          }
        : {}),
      ...(me
        ? {
            viewerRole: rolesBy?.get(f.id) ?? (f.ownerUserId === me.id ? "owner" : null),
            visited: !!visitsBy?.has(f.id),
          }
        : {}),
    }));
    out.sort((a, b) =>
      catalogRank(a) - catalogRank(b) || a.name.localeCompare(b.name));
    return { forums: out };
  });

  /* =========================================================
   *  Forum DISCOVER (mirrors the chat-server discover UX 1:1)
   *
   *    GET /forums/discover         → { popular, new }   (rails)
   *    GET /forums/discover/search  → { items }          (?q, ?tag)
   *    GET /forums/tags             → { tags }            (facet list)
   *
   *  All three browse the same surface as the catalog: browsable =
   *  status != 'archived' AND visibility = 'public' (v1 forums are
   *  public-only; the explicit check future-proofs a hidden tier the
   *  same way the catalog will). Anonymous-tolerant like the catalog —
   *  they expose only public ForumSummary fields and carry none of the
   *  viewer-specific flags (unseen/viewerRole/visited).
   * ========================================================= */

  /** Build full ForumSummary[] for every browsable forum, with the same
   *  board/member/activity aggregates the catalog computes. Shared by the
   *  discover rails, search, and tag facets so they stay consistent. */
  async function browsableForumSummaries(): Promise<ForumSummary[]> {
    const rows = await db
      .select({
        id: forums.id,
        slug: forums.slug,
        name: forums.name,
        tagline: forums.tagline,
        logoUrl: forums.logoUrl,
        status: forums.status,
        postingMode: forums.postingMode,
        isSystem: forums.isSystem,
        ownerUserId: forums.ownerUserId,
        ownerUsername: users.username,
        tagsJson: forums.tagsJson,
        createdAt: forums.createdAt,
      })
      .from(forums)
      .leftJoin(users, eq(users.id, forums.ownerUserId))
      .where(and(sql`${forums.status} != 'archived'`, eq(forums.visibility, "public")));

    const boardCounts = await db
      .select({ forumId: rooms.forumId, n: sql<number>`count(*)` })
      .from(rooms)
      .where(and(isNotNull(rooms.forumId), isNull(rooms.archivedAt)))
      .groupBy(rooms.forumId);
    const memberCounts = await db
      .select({ forumId: forumMembers.forumId, n: sql<number>`count(*)` })
      .from(forumMembers)
      .groupBy(forumMembers.forumId);
    const activity = await db
      .select({
        forumId: rooms.forumId,
        last: sql<number | null>`max(coalesce(${messages.lastActivityAt}, ${messages.createdAt}))`,
      })
      .from(messages)
      .innerJoin(rooms, eq(rooms.id, messages.roomId))
      .where(and(isNotNull(rooms.forumId), isNotNull(messages.title), isNull(messages.deletedAt)))
      .groupBy(rooms.forumId);

    const boardsBy = new Map(boardCounts.map((r) => [r.forumId, r.n]));
    const membersBy = new Map(memberCounts.map((r) => [r.forumId, r.n]));
    const activityBy = new Map(activity.map((r) => [r.forumId, r.last]));

    return rows.map((f) => ({
      id: f.id,
      slug: f.slug,
      name: f.name,
      tagline: f.tagline ?? null,
      logoUrl: f.logoUrl ?? null,
      status: f.status,
      postingMode: f.postingMode,
      isSystem: !!f.isSystem,
      ownerUserId: f.ownerUserId,
      ownerUsername: f.ownerUsername ?? "unknown",
      boardCount: boardsBy.get(f.id) ?? 0,
      memberCount: membersBy.get(f.id) ?? 0,
      tags: parseTagsJson(f.tagsJson),
      lastActivityAt: activityBy.get(f.id) ?? null,
      createdAt: +f.createdAt,
    }));
  }

  app.get("/forums/discover", browseLimit, async () => {
    const all = await browsableForumSummaries();
    // popular: most members first, then most-recent activity (nulls last).
    const popular = [...all]
      .sort((a, b) =>
        b.memberCount - a.memberCount ||
        (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
      .slice(0, 12);
    // new: youngest forums first.
    const fresh = [...all]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 12);
    return { popular, new: fresh };
  });

  app.get<{ Querystring: { q?: string; tag?: string } }>(
    "/forums/discover/search",
    browseLimit,
    async (req) => {
      const q = (req.query.q ?? "").trim().toLowerCase();
      const tag = (req.query.tag ?? "").trim();
      const all = await browsableForumSummaries();
      const items = all.filter((f) => {
        const matchesQ =
          !q ||
          f.name.toLowerCase().includes(q) ||
          (f.tagline ?? "").toLowerCase().includes(q);
        const matchesTag = !tag || hasTag(f.tags, tag);
        return matchesQ && matchesTag;
      }).slice(0, 50);
      return { items };
    },
  );

  app.get("/forums/tags", browseLimit, async () => {
    const all = await browsableForumSummaries();
    const counts = new Map<string, number>();
    for (const f of all) {
      for (const t of f.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const tags = [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    return { tags };
  });

  app.get<{ Params: { idOrSlug: string } }>("/forums/:idOrSlug", browseLimit, async (req, reply) => {
    const me = await getSessionUser(req, db).catch(() => null);
    const key = req.params.idOrSlug;
    // Resolve id first (ids are nanoids, never collide with the lowercase
    // slug alphabet in practice; checking both keeps old links working).
    let forum = (await db.select().from(forums).where(eq(forums.id, key)).limit(1))[0];
    if (!forum) {
      forum = (await db.select().from(forums)
        .where(sql`lower(${forums.slug}) = lower(${key})`).limit(1))[0];
    }
    if (!forum) { reply.code(404); return { error: "no forum" }; }

    const owner = (await db.select({ username: users.username }).from(users)
      .where(eq(users.id, forum.ownerUserId)).limit(1))[0];

    const boardRows = await db
      .select()
      .from(rooms)
      .where(and(eq(rooms.forumId, forum.id), isNull(rooms.archivedAt)));
    const boardIds = boardRows.map((b) => b.id);

    // Per-board topic counts + last activity, two grouped queries.
    const topicCounts = boardIds.length
      ? await db
          .select({ roomId: messages.roomId, n: sql<number>`count(*)` })
          .from(messages)
          .where(and(inArray(messages.roomId, boardIds), isNotNull(messages.title), isNull(messages.deletedAt)))
          .groupBy(messages.roomId)
      : [];
    const boardActivity = boardIds.length
      ? await db
          .select({
            roomId: messages.roomId,
            last: sql<number | null>`max(coalesce(${messages.lastActivityAt}, ${messages.createdAt}))`,
          })
          .from(messages)
          .where(and(inArray(messages.roomId, boardIds), isNotNull(messages.title), isNull(messages.deletedAt)))
          .groupBy(messages.roomId)
      : [];
    const topicsBy = new Map(topicCounts.map((r) => [r.roomId, r.n]));
    const lastBy = new Map(boardActivity.map((r) => [r.roomId, r.last]));

    // Owner-set explicit ordering first, then createdAt for the rest.
    let order: string[] = [];
    try { order = JSON.parse(forum.boardOrderJson) as string[]; } catch { /* default */ }
    const orderIndex = new Map(order.map((id, i) => [id, i]));
    boardRows.sort((a, b) => {
      const ai = orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bi = orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi || +a.createdAt - +b.createdAt;
    });

    // Resolve the viewer's forum authority ONCE (reused by the board-lock
    // computation below and the viewer-state block further down). Anonymous
    // ⇒ null ⇒ never a member ⇒ every members-only board reads as locked.
    const viewerAuthority = me ? await forumAuthority(db, me, forum.id) : null;
    const viewerIsMember = viewerAuthority?.isMember ?? false;

    const boards: ForumBoardSummary[] = boardRows.map((b) => ({
      roomId: b.id,
      name: b.name,
      topic: b.topic,
      topicCount: topicsBy.get(b.id) ?? 0,
      lastActivityAt: lastBy.get(b.id) ?? null,
      archived: false,
      // Shown-but-locked: a private board still lists; `locked` withholds its
      // contents from non-members (and all anonymous viewers).
      membersOnly: !!b.forumMembersOnly,
      locked: !!b.forumMembersOnly && !viewerIsMember,
    }));

    // Landing-page statistics (traditional forum index numbers). Topics
    // reuse the per-board counts above; replies + distinct writers are
    // two aggregates over the same live-board scope. "Online" is SITE
    // presence (boards carry none by design): every connected account,
    // split into public-profile names (capped) and a hidden count for
    // private/incognito users.
    const repliesAgg = boardIds.length
      ? (await db
          .select({
            replies: sql<number>`count(case when ${messages.replyToId} is not null then 1 end)`,
            writers: sql<number>`count(distinct ${messages.userId})`,
          })
          .from(messages)
          .where(and(
            inArray(messages.roomId, boardIds),
            isNull(messages.deletedAt),
            sql`${messages.kind} not in ('system', 'announce')`,
          )))[0]
      : undefined;
    const onlineUserIds = [...new Set(
      (await io.fetchSockets())
        .map((s) => (s.data as { userId?: string }).userId)
        .filter((id): id is string => !!id),
    )];
    const onlineRows = onlineUserIds.length
      ? await db
          .select({ username: users.username, isPublic: users.isPublic, incognitoMode: users.incognitoMode })
          .from(users)
          .where(inArray(users.id, onlineUserIds))
      : [];
    const publicOnline = onlineRows
      .filter((u) => u.isPublic && !u.incognitoMode && u.username !== "system")
      .map((u) => u.username)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 24);
    // "Browsing this forum": visit markers stamped within the last 15
    // minutes — an honest "recently here" signal (boards carry no live
    // presence by design).
    const { forumVisits } = await import("../../db/schema.js");
    const browsing = (await db
      .select({ n: sql<number>`count(*)` })
      .from(forumVisits)
      .where(and(
        eq(forumVisits.forumId, forum.id),
        sql`${forumVisits.lastVisitAt} > ${Date.now() - 15 * 60_000}`,
      )))[0];
    const stats = {
      topics: [...topicsBy.values()].reduce((a, b) => a + b, 0),
      replies: repliesAgg?.replies ?? 0,
      writers: repliesAgg?.writers ?? 0,
      online: {
        publicNames: publicOnline,
        hiddenCount: Math.max(0, onlineRows.filter((u) => u.username !== "system").length - publicOnline.length),
        browsingRecently: browsing?.n ?? 0,
      },
    };

    const linkedWorld = forum.linkedWorldId
      ? await (async () => {
          const w = (await db
            .select({ id: worlds.id, name: worlds.name, ownerUserId: worlds.ownerUserId, description: worlds.description })
            .from(worlds).where(eq(worlds.id, forum.linkedWorldId!)).limit(1))[0];
          if (!w) return null;
          const wOwner = (await db.select({ username: users.username }).from(users)
            .where(eq(users.id, w.ownerUserId)).limit(1))[0];
          const desc = w.description?.trim() ?? "";
          return {
            id: w.id,
            name: w.name,
            ownerUsername: wOwner?.username ?? "unknown",
            description: desc ? (desc.length > 240 ? `${desc.slice(0, 237)}…` : desc) : null,
          };
        })()
      : null;

    // Affiliated chat server (Servers Lift): drives per-server topic-card
    // flair + the owner's "affiliate this forum" settings control. Null
    // when `forums.serverId` is unset.
    const affiliatedServer = forum.serverId
      ? await (async () => {
          const s = (await db.select({ id: servers.id, name: servers.name })
            .from(servers).where(eq(servers.id, forum.serverId!)).limit(1))[0];
          return s ? { id: s.id, name: s.name } : null;
        })()
      : null;

    // Viewer gates (advisory for the client; every mutation re-checks).
    let viewer: ForumViewerState | null = null;
    if (me && viewerAuthority) {
      const a = viewerAuthority;
      const pending = (await db
        .select({ id: forumMembershipApplications.id })
        .from(forumMembershipApplications)
        .where(and(
          eq(forumMembershipApplications.forumId, forum.id),
          eq(forumMembershipApplications.applicantUserId, me.id),
          eq(forumMembershipApplications.status, "pending"),
        ))
        .limit(1))[0];
      viewer = {
        role: a.role,
        isMember: a.isMember,
        ban: a.ban ? { until: a.ban.until ? +a.ban.until : null, reason: a.ban.reason } : null,
        membershipPending: !!pending,
        canParticipate: a.canParticipate,
        canManage: a.isOwner,
        permissions: a.permissions,
      };
    }

    const boardCount = boards.length;
    const lastActivityAt = boards.reduce<number | null>(
      (acc, b) => (b.lastActivityAt && (!acc || b.lastActivityAt > acc) ? b.lastActivityAt : acc),
      null,
    );
    const memberCount = (await db
      .select({ n: sql<number>`count(*)` })
      .from(forumMembers)
      .where(eq(forumMembers.forumId, forum.id)))[0]?.n ?? 0;

    const prefixRows = (await db
      .select({ id: forumPrefixes.id, label: forumPrefixes.label, color: forumPrefixes.color, tooltip: forumPrefixes.tooltip, sortOrder: forumPrefixes.sortOrder, categoryIdsJson: forumPrefixes.categoryIdsJson, staffOnly: forumPrefixes.staffOnly })
      .from(forumPrefixes)
      .where(eq(forumPrefixes.forumId, forum.id))
      .orderBy(asc(forumPrefixes.sortOrder), asc(forumPrefixes.createdAt)))
      .map((p) => ({ id: p.id, label: p.label, color: p.color, tooltip: p.tooltip ?? null, sortOrder: p.sortOrder, categoryIds: parsePrefixCategoryIds(p.categoryIdsJson), staffOnly: !!p.staffOnly }));

    // Every category across the forum's boards, for the prefix scope picker.
    // `boards` is already loaded (its roomId is the board's room id).
    const boardRoomIds = boards.map((b) => b.roomId);
    const categoryRefs: ForumCategoryRef[] = boardRoomIds.length
      ? (await db
          .select({ id: roomThreadCategories.id, name: roomThreadCategories.name, boardName: rooms.name, sortOrder: roomThreadCategories.sortOrder })
          .from(roomThreadCategories)
          .innerJoin(rooms, eq(rooms.id, roomThreadCategories.roomId))
          .where(inArray(roomThreadCategories.roomId, boardRoomIds))
          .orderBy(asc(rooms.name), asc(roomThreadCategories.sortOrder), asc(roomThreadCategories.name)))
          .map((c) => ({ id: c.id, name: c.name, boardName: c.boardName ?? "" }))
      : [];

    const detail: ForumDetail = {
      id: forum.id,
      slug: forum.slug,
      name: forum.name,
      tagline: forum.tagline ?? null,
      logoUrl: forum.logoUrl ?? null,
      status: forum.status,
      postingMode: forum.postingMode,
      isSystem: !!forum.isSystem,
      ownerUserId: forum.ownerUserId,
      ownerUsername: owner?.username ?? "unknown",
      boardCount,
      memberCount,
      tags: parseTagsJson(forum.tagsJson),
      lastActivityAt,
      createdAt: +forum.createdAt,
      descriptionHtml: forum.descriptionHtml ?? null,
      bannerImageUrl: forum.bannerImageUrl ?? null,
      bannerFocusY: forum.bannerFocusY ?? 50,
      themeJson: forum.themeJson ?? null,
      themeStyleKey: forum.themeStyleKey ?? null,
      applicationPrompt: forum.applicationPrompt ?? null,
      publicBrowsing: !!forum.publicBrowsing,
      allowCustomTags: !!forum.allowCustomTags,
      linkedWorld,
      affiliatedServer,
      boards,
      prefixes: prefixRows,
      categories: categoryRefs,
      viewer,
      stats,
    };
    return detail;
  });

  /**
   * GET /me/forums — the forums this signed-in user OWNS or MODERATES, each
   * with the user's effective permission set. Drives the profile "Ban from
   * forum" flow + its forum-picker (when they manage several). Site staff
   * with manage_any_forum are NOT enumerated here (they'd match every forum;
   * they ban via the admin tools), so this stays cheap + owner/mod-scoped.
   */
  app.get("/me/forums", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const owned = await db
      .select({ id: forums.id, slug: forums.slug, name: forums.name, logoUrl: forums.logoUrl })
      .from(forums).where(eq(forums.ownerUserId, me.id));
    const modRows = await db
      .select({ id: forums.id, slug: forums.slug, name: forums.name, logoUrl: forums.logoUrl, permissionsJson: forumMembers.permissionsJson })
      .from(forumMembers).innerJoin(forums, eq(forums.id, forumMembers.forumId))
      .where(and(eq(forumMembers.userId, me.id), eq(forumMembers.role, "mod")));
    const out = new Map<string, { id: string; slug: string; name: string; logoUrl: string | null; permissions: ForumModPermission[] }>();
    for (const f of owned) out.set(f.id, { id: f.id, slug: f.slug, name: f.name, logoUrl: f.logoUrl, permissions: [...FORUM_MOD_PERMISSIONS] });
    for (const f of modRows) if (!out.has(f.id)) {
      out.set(f.id, { id: f.id, slug: f.slug, name: f.name, logoUrl: f.logoUrl, permissions: parseForumModPermissions(f.permissionsJson) });
    }
    return { forums: [...out.values()] };
  });

  /* =========================================================
   *  Phase 8: visit markers + admin curation
   * ========================================================= */

  /** Stamp "this viewer looked at this forum now" — clears the rail's
   *  unseen dot. Fire-and-forget from the catalog on selection. */
  app.post<{ Params: { id: string } }>("/forums/:id/visit", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const { forumVisits } = await import("../../db/schema.js");
    const now = new Date();
    await db.insert(forumVisits)
      .values({ userId: me.id, forumId: req.params.id, lastVisitAt: now })
      .onConflictDoUpdate({
        target: [forumVisits.userId, forumVisits.forumId],
        set: { lastVisitAt: now },
      });
    return { ok: true };
  });

  /** Admin curation list — every forum INCLUDING archived (the public
   *  catalog filters those out), so staff can feature/unfeature/restore. */
  app.get("/admin/forums", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "view_admin_forums", db))) {
      reply.code(403); return { error: "forbidden" };
    }
    const rows = await db
      .select({
        id: forums.id,
        slug: forums.slug,
        name: forums.name,
        status: forums.status,
        isSystem: forums.isSystem,
        ownerUsername: users.username,
        createdAt: forums.createdAt,
      })
      .from(forums)
      .leftJoin(users, eq(users.id, forums.ownerUserId));
    return {
      forums: rows.map((f) => ({
        id: f.id,
        slug: f.slug,
        name: f.name,
        status: f.status,
        isSystem: !!f.isSystem,
        ownerUsername: f.ownerUsername ?? "unknown",
        createdAt: +f.createdAt,
      })),
    };
  });

  const adminStatusBody = z.object({
    status: z.enum(["active", "featured", "archived"]),
  }).strict();

  /** Feature (pins to the catalog top with a star), un-feature, archive
   *  (drops from the catalog; boards stay), or restore a forum. The
   *  system forum can't be archived — the catalog opens on it. */
  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/forums/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "manage_any_forum", db))) {
      reply.code(403); return { error: "forbidden" };
    }
    let body: z.infer<typeof adminStatusBody>;
    try { body = adminStatusBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const forum = (await db.select().from(forums).where(eq(forums.id, req.params.id)).limit(1))[0];
    if (!forum) { reply.code(404); return { error: "no forum" }; }
    if (forum.isSystem && body.status === "archived") {
      reply.code(409); return { error: "The system forum anchors the catalog and can't be archived." };
    }
    await db.update(forums).set({ status: body.status, updatedAt: new Date() })
      .where(eq(forums.id, forum.id));
    return { ok: true };
  });
}
