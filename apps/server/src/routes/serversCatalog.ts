/**
 * serversCatalog - catalog rail, discovery (browse/search/tags), the
 * anonymous popular list, per-user rail order, and server detail. Move-only
 * extraction from registerServerRoutes; behavior is byte-identical.
 */
import {
  RESERVED_SERVER_SLUGS,
  SERVER_MAX_AUTO_RULES,
  SERVER_MAX_OWNED_DEFAULT,
  SERVER_MAX_USERGROUPS,
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
  SERVER_USERGROUP_NAME_MAX,
  hasTag,
  isGrantableServerModPermission,
  isModeratorRole,
  isServerFeaturePermission,
  normalizeServerSlug,
  normalizeTheme,
  parseTagsJson,
  serializeTags,
  parseServerAutoRules,
  parseServerFeaturePermissions,
  parseServerModPermissions,
  serializeServerAutoRules,
  serializeServerFeaturePermissions,
  serializeServerModPermissions,
} from "@thekeep/shared";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  ServerAutoRule,
  ServerFeaturePermission,
  ServerModPermission,
  ServerPermission,
  ServerRole,
  ServerViewerState,
} from "@thekeep/shared";
import {
  accountMutes,
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
  siteSettings,
  users,
} from "../db/schema.js";
import { getSessionUser } from "./auth.js";
import { hasPermission } from "../auth/permissions.js";
import { serverAuthority, serverCan } from "../servers/authority.js";
import { isServerModerationActive, serverModerationNotice } from "../servers/moderation.js";
import { ensureDefaultUsergroup, serverRoomIds } from "../servers/usergroups.js";
import { notifyUser, emitServersChanged } from "../servers/notifications.js";
import { invalidateServerSettings } from "../settings.js";
import {
  broadcastPresence,
  broadcastRoomState,
  emitTreeChanged,
  findCanonicalLanding,
  findServerLanding,
  sendRoomBacklogTo,
} from "../realtime/broadcast.js";
import { deriveUniqueRoomSlug } from "../lib/roomSlug.js";
import { softHideUserMessages } from "../lib/purgeUserMessages.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import {
  auditServer,
  buildServerSummary,
  catalogRank,
  parseCrop,
  roomInServer,
  roomsOfServerWhere,
  SERVER_SUMMARY_COLUMNS,
} from "./serversShared.js";
import type { ServerRoutesCtx, ServerSummaryRow, SummaryViewerCtx } from "./serversShared.js";

export function registerServerCatalogRoutes(ctx: ServerRoutesCtx): void {
  const { app, db, io, serversLive, requireServerOwner, requireServerPermission, resolveServerTarget, writeServerImage, unlinkServerImage } = ctx;

  /* =========================================================
   *  Catalog + detail
   * ========================================================= */

  /** Last activity per server: max over its rooms' message rows. Legacy
   *  NULL-serverId rooms are adopted into the default server (coalesced group
   *  key) so the default server's activity isn't dropped. Shared by the
   *  catalog + discover surfaces. */
  async function loadActivityBy(): Promise<Map<string, number | null>> {
    const activity = await db
      .select({
        serverId: sql<string>`coalesce(${rooms.serverId}, ${DEFAULT_SERVER_ID})`,
        last: sql<number | null>`max(coalesce(${messages.lastActivityAt}, ${messages.createdAt}))`,
      })
      .from(messages)
      .innerJoin(rooms, eq(rooms.id, messages.roomId))
      .where(isNull(messages.deletedAt))
      .groupBy(sql`coalesce(${rooms.serverId}, ${DEFAULT_SERVER_ID})`);
    return new Map(activity.map((r) => [r.serverId, r.last]));
  }

  /** Load the per-request viewer enrichment (roles, visit markers, favorite)
   *  that {@link buildServerSummary} layers onto each row. One indexed read
   *  each; all null/empty for an anonymous viewer. */
  async function loadSummaryViewerCtx(
    me: { id: string } | null,
    activityBy: Map<string, number | null>,
    rows: ServerSummaryRow[],
  ): Promise<SummaryViewerCtx> {
    const rolesBy = me
      ? new Map((await db
          .select({ serverId: serverMembers.serverId, role: serverMembers.role })
          .from(serverMembers)
          .where(eq(serverMembers.userId, me.id))).map((r) => [r.serverId, r.role] as const))
      : null;
    const visitsBy = me
      ? new Map((await db
          .select({ serverId: serverVisits.serverId, at: serverVisits.lastVisitAt })
          .from(serverVisits)
          .where(eq(serverVisits.userId, me.id))).map((v) => [v.serverId, +v.at] as const))
      : null;
    // The viewer's chosen favorite/default server (not on the session-user
    // shape, so read it once here for the per-row `isMyDefault` flag).
    const myDefaultServerId = me
      ? (await db.select({ d: users.defaultServerId }).from(users).where(eq(users.id, me.id)).limit(1))[0]?.d ?? null
      : null;
    // Owner display names for the cards (one batched read over the distinct
    // owner ids in this row set). Lets a viewer click "by <owner>" to open the
    // owner's profile and message them — e.g. to ask for an invite.
    const ownerIds = [...new Set(rows.map((r) => r.ownerUserId).filter((x): x is string => !!x))];
    const ownerNamesBy = new Map<string, string>();
    if (ownerIds.length) {
      const names = await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ownerIds));
      for (const n of names) ownerNamesBy.set(n.id, n.username);
    }
    return { me, rolesBy, visitsBy, myDefaultServerId, activityBy, ownerNamesBy };
  }

  app.get("/servers", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    // Session optional (mirrors the forum catalog): logged-in viewers also get
    // their per-server role + unseen flag.
    const me = await getSessionUser(req, db).catch(() => null);

    const rows = await db
      .select(SERVER_SUMMARY_COLUMNS)
      .from(servers)
      .where(sql`${servers.status} != 'archived'`);

    const activityBy = await loadActivityBy();
    const ctx = await loadSummaryViewerCtx(me, activityBy, rows);

    // Hide a MODERATED server (suspended, or banned with an unexpired until)
    // from the rail — EXCEPT for the people who need to enter and fix it: the
    // server's owner, the owner's admins/mods, and global staff. The system
    // server is never moderated (guarded at the admin endpoints). A ban past its
    // until is treated as 'none' (visible to all — lazy expiry). Non-moderated
    // servers pass through unchanged, so flag-off / clean-state is byte-identical.
    const manageAny = me ? await hasPermission(me, "manage_any_server", db) : false;
    const canSeeModerated = (s: ServerSummaryRow): boolean => {
      if (manageAny) return true;                       // global staff
      if (!me) return false;                            // anonymous
      if (s.ownerUserId === me.id) return true;         // owner
      const role = ctx.rolesBy?.get(s.id);              // owner's admin/mod
      return role === "owner" || role === "admin" || role === "mod";
    };
    const visible = rows.filter((s) => {
      // moderation active? (mirrors isServerModerationActive on the row subset)
      const active = s.moderationState === "suspended"
        || (s.moderationState === "banned"
            && (!s.moderationUntil || +s.moderationUntil > Date.now()));
      return !active || canSeeModerated(s);
    });

    const out = visible.map((s) => buildServerSummary(s, ctx));
    out.sort((a, b) => catalogRank(a) - catalogRank(b) || a.name.localeCompare(b.name));
    return { servers: out };
  });

  /* =========================================================
   *  Discovery: browse / search / tag cloud (migration 0301)
   *
   *  Public-facing surfaces for finding a community by activity, recency, name,
   *  or genre tag. Same flag gate + the SAME ServerSummary shape the catalog
   *  emits (so the discover cards reuse the rail card). Limited to JOINABLE,
   *  BROWSABLE servers: visibility 'public' and not archived.
   * ========================================================= */

  /** WHERE for the discover surfaces: public, non-archived, non-moderated
   *  servers only. Moderated = suspended (always) OR banned with an unexpired
   *  until (NULL until = indefinite). A ban past its until is treated as 'none'
   *  (still discoverable) — lazy expiry mirrors serverAuthority's ban check, so
   *  the row is filtered in SQL rather than deleted. Evaluated per-request with
   *  Date.now() so an expiring ban re-appears without a cron. */
  const discoverableWhere = and(
    eq(servers.visibility, "public"),
    sql`${servers.status} != 'archived'`,
    sql`${servers.moderationState} != 'suspended'`,
    sql`not (${servers.moderationState} = 'banned' and (${servers.moderationUntil} is null or ${servers.moderationUntil} > ${Date.now()}))`,
  );

  /** GET /servers/discover — { popular, new }. `popular` is member-count desc
   *  then most-recent-activity/createdAt desc; `new` is createdAt desc. Each
   *  capped at 12 and built with the full catalog summary shape. */
  app.get("/servers/discover", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db).catch(() => null);

    const rows = await db.select(SERVER_SUMMARY_COLUMNS).from(servers).where(discoverableWhere);
    const activityBy = await loadActivityBy();
    const ctx = await loadSummaryViewerCtx(me, activityBy, rows);

    // Member counts per discoverable server (one grouped read) — drives the
    // popular sort. Not part of the summary shape, used only for ordering.
    const ids = rows.map((r) => r.id);
    const memberCountBy = new Map<string, number>();
    if (ids.length) {
      const counts = await db
        .select({ serverId: serverMembers.serverId, n: sql<number>`count(*)` })
        .from(serverMembers)
        .where(inArray(serverMembers.serverId, ids))
        .groupBy(serverMembers.serverId);
      for (const c of counts) memberCountBy.set(c.serverId, Number(c.n));
    }
    const recencyOf = (s: ServerSummaryRow) => activityBy.get(s.id) ?? +s.createdAt;

    const popular = [...rows]
      .sort((a, b) =>
        (memberCountBy.get(b.id) ?? 0) - (memberCountBy.get(a.id) ?? 0)
        || recencyOf(b) - recencyOf(a))
      .slice(0, 12)
      .map((s) => buildServerSummary(s, ctx));
    const fresh = [...rows]
      .sort((a, b) => +b.createdAt - +a.createdAt)
      .slice(0, 12)
      .map((s) => buildServerSummary(s, ctx));
    return { popular, new: fresh };
  });

  /** GET /servers/popular — anonymous, lightweight "popular communities" list
   *  for the public homepage (no auth, no viewer context). Same discoverable
   *  filter as /discover (public, non-archived, non-moderated), ranked by member
   *  count. The system server (The Spire) is implicit-membership — everyone's a
   *  member without a `server_members` row — so its explicit count is ~1; we
   *  substitute the total registered-user count for it, so The Spire surfaces as
   *  the flagship community instead of ranking near-empty. Minimal shape; capped
   *  at 8. Gated on the servers flag like the rest of discovery.
   *
   *  LIVE social proof (B4): each row also carries `onlineCount` — the distinct
   *  roleplayers currently connected inside that community — and `lastActivityAt`
   *  — the most recent message across its rooms. Both are cheap:
   *    - onlineCount is derived from the in-memory socket registry, NOT the DB.
   *      Every socket caches its current room's server on `socket.data.serverId`
   *      (set on room-join in broadcast.ts, falling back to the default/home
   *      server for legacy NULL-serverId rooms), so one `fetchSockets()` pass +
   *      a group-by-serverId over distinct userIds gives the count with no query.
   *    - lastActivityAt reuses `loadActivityBy` (max message time per server),
   *      the same batched read the catalog/discover surfaces already run.
   *  Both are anonymous-safe (aggregate counts + a timestamp; no names). The
   *  numbers ride the wire raw — the homepage gates them behind
   *  `activityFeedsEnabled` and only renders a count when it is > 0, so a
   *  cold-start install never paints a dead "0 online". */
  app.get("/servers/popular", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const rows = await db
      .select({
        id: servers.id,
        slug: servers.slug,
        name: servers.name,
        tagline: servers.tagline,
        logoUrl: servers.logoUrl,
        iconColor: servers.iconColor,
        isSystem: servers.isSystem,
      })
      .from(servers)
      .where(discoverableWhere);
    if (!rows.length) return { servers: [] };

    const ids = rows.map((r) => r.id);
    const memberCountBy = new Map<string, number>();
    const counts = await db
      .select({ serverId: serverMembers.serverId, n: sql<number>`count(*)` })
      .from(serverMembers)
      .where(inArray(serverMembers.serverId, ids))
      .groupBy(serverMembers.serverId);
    for (const c of counts) memberCountBy.set(c.serverId, Number(c.n));

    // Only pay for the total-users count when a system server is actually in the
    // list (it always is on a normal install, but the query stays honest if not).
    let totalRegistered = 0;
    if (rows.some((r) => r.isSystem)) {
      const t = (await db
        .select({ n: sql<number>`count(*)` })
        .from(users)
        .where(isNull(users.disabledAt)))[0];
      totalRegistered = Number(t?.n ?? 0);
    }

    // Live online-per-server from the socket registry (no DB). One pass over the
    // connected sockets, grouping DISTINCT userIds by the server they're in
    // (socket.data.serverId, set on every room-join). A user with two tabs in
    // the same community counts once; a user with tabs in two communities counts
    // in each. Best-effort: a socket registry hiccup leaves onlineCount at 0.
    const onlineByServer = new Map<string, Set<string>>();
    try {
      const sockets = await io.fetchSockets();
      for (const s of sockets) {
        const uid = (s.data as { userId?: string }).userId;
        const sid = (s.data as { serverId?: string }).serverId;
        if (!uid || !sid) continue;
        let set = onlineByServer.get(sid);
        if (!set) { set = new Set(); onlineByServer.set(sid, set); }
        set.add(uid);
      }
    } catch { /* best-effort: fall through with empty counts */ }

    // Most-recent activity per server (max message time across its rooms) — the
    // same batched read the catalog/discover surfaces run. Cheap, one grouped
    // query. Legacy NULL-serverId rooms coalesce into the default server, so the
    // home server's activity isn't dropped.
    const activityBy = await loadActivityBy();

    const out = rows
      .map((s) => ({
        slug: s.slug,
        name: s.name,
        tagline: s.tagline ?? null,
        logoUrl: s.logoUrl ?? null,
        iconColor: s.iconColor ?? null,
        isSystem: !!s.isSystem,
        memberCount: s.isSystem ? totalRegistered : (memberCountBy.get(s.id) ?? 0),
        // Live signals (B4). onlineCount is the distinct connected roleplayers in
        // this community right now; lastActivityAt is the newest message across
        // its rooms (ms epoch, or null when the server has never had one).
        onlineCount: onlineByServer.get(s.id)?.size ?? 0,
        lastActivityAt: activityBy.get(s.id) ?? null,
      }))
      .sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name))
      .slice(0, 8);
    return { servers: out };
  });

  /**
   * Per-user server-rail ordering (Discord-style drag-to-reorder). GET returns
   * the caller's saved order (a JSON array of server ids); PUT persists a new
   * one. The arrangement is PRIVATE to the caller — servers not listed fall to
   * the rail's default order, so this never affects other members. Migration
   * 0326 (users.rail_order_json).
   */
  app.get("/me/server-order", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "not authenticated" }; }
    const row = (await db.select({ order: users.railOrderJson }).from(users).where(eq(users.id, me.id)).limit(1))[0];
    let order: string[] = [];
    if (row?.order) {
      try {
        const parsed: unknown = JSON.parse(row.order);
        if (Array.isArray(parsed)) order = parsed.filter((x): x is string => typeof x === "string");
      } catch { /* corrupt JSON → fall back to default order */ }
    }
    return { order };
  });
  app.put<{ Body: unknown }>("/me/server-order", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "not authenticated" }; }
    const body = z.object({ order: z.array(z.string().min(1)).max(500) }).parse(req.body);
    // De-dupe defensively; the client sends the full rail order on each drop.
    const order = [...new Set(body.order)];
    await db.update(users).set({ railOrderJson: JSON.stringify(order) }).where(eq(users.id, me.id));
    return { ok: true };
  });

  /** GET /servers/discover/search?q=&tag= — { items }. Public non-archived
   *  servers where (q empty OR name/tagline contains q, case-insensitive) AND
   *  (tag empty OR the server carries that tag). Capped at 50. */
  app.get<{ Querystring: { q?: string; tag?: string } }>("/servers/discover/search", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db).catch(() => null);

    const q = (req.query.q ?? "").trim().toLowerCase();
    const tag = (req.query.tag ?? "").trim();
    const rows = await db.select(SERVER_SUMMARY_COLUMNS).from(servers).where(discoverableWhere);
    const activityBy = await loadActivityBy();
    const ctx = await loadSummaryViewerCtx(me, activityBy, rows);

    const items = rows
      .filter((s) => {
        const textHit = !q
          || s.name.toLowerCase().includes(q)
          || (s.tagline ?? "").toLowerCase().includes(q);
        const tagHit = !tag || hasTag(parseTagsJson(s.tagsJson), tag);
        return textHit && tagHit;
      })
      .sort((a, b) => catalogRank(a) - catalogRank(b) || a.name.localeCompare(b.name))
      .slice(0, 50)
      .map((s) => buildServerSummary(s, ctx));
    return { items };
  });

  /** GET /servers/tags — { tags: [{ tag, count }] }. Distinct tags across
   *  public non-archived servers with their occurrence counts, count desc then
   *  tag asc. Tallied in JS from each server's parsed tags_json. */
  app.get("/servers/tags", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const rows = await db.select({ tagsJson: servers.tagsJson }).from(servers).where(discoverableWhere);
    const tally = new Map<string, number>();
    for (const r of rows) {
      for (const t of parseTagsJson(r.tagsJson)) tally.set(t, (tally.get(t) ?? 0) + 1);
    }
    const tags = [...tally.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    return { tags };
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
      .where(and(roomsOfServerWhere(server.id), isNull(rooms.archivedAt))))[0]?.n ?? 0;
    const memberCount = (await db.select({ n: sql<number>`count(*)` }).from(serverMembers)
      .where(eq(serverMembers.serverId, server.id)))[0]?.n ?? 0;
    const activity = (await db
      .select({ last: sql<number | null>`max(coalesce(${messages.lastActivityAt}, ${messages.createdAt}))` })
      .from(messages)
      .innerJoin(rooms, eq(rooms.id, messages.roomId))
      .where(and(roomsOfServerWhere(server.id), isNull(messages.deletedAt))))[0]?.last ?? null;

    const a = await serverAuthority(db, me, server.id);
    // Hide a moderated server's detail from non-staff, mirroring the rail-
    // catalog hide + /servers/by-slug: a suspended/banned server's card (name,
    // banner, counts, description) is only visible to its owner/staff and
    // global staff (isMod). Everyone else 404s so the server's existence and
    // metadata stay hidden — the "users can't see it" contract. Expired bans
    // read as inactive, so this no-ops there.
    if (isServerModerationActive(server) && !a.isMod) {
      reply.code(404); return { error: "no server" };
    }
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
        bannerCrop: parseCrop(server.bannerCrop),
        bannerHeight: server.bannerHeight ?? null,
        iconColor: server.iconColor ?? null,
        borderColor: server.borderColor ?? null,
        iconCrop: parseCrop(server.iconCrop),
        horizontalLogoUrl: server.horizontalLogoUrl ?? null,
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
}
