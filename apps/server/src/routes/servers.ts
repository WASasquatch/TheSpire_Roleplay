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
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import type {
  ClientToServerEvents,
  ServerAutoRule,
  ServerFeaturePermission,
  ServerModPermission,
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
  siteSettings,
  users,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";
import { hasPermission } from "../auth/permissions.js";
import { serverAuthority, serverCan } from "../servers/authority.js";
import { ensureDefaultUsergroup, serverRoomIds } from "../servers/usergroups.js";
import { resolveIdentityArg } from "../commands/identityArg.js";
import { notifyUser } from "../servers/notifications.js";
import { getSettings, areServersEnabled, invalidateServerSettings } from "../settings.js";
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
import type { CommandRegistry } from "../commands/registry.js";
// Per-server admin surfaces (Admin Partition — plan_ext.md). Each is a
// self-contained, self-gated module registered below.
import { registerServerReportRoutes } from "../servers/reports.js";
import { registerServerModCaseRoutes } from "../servers/modCases.js";
import { registerServerEmoticonRoutes } from "../servers/emoticons.js";
import { registerServerAnnouncementRoutes } from "../servers/announcements.js";
import { registerServerFaqRoutes } from "../servers/faqs.js";
import { registerServerCommandTitleRoutes } from "../servers/commandsTitles.js";
import { registerServerEarningRoutes } from "../servers/earning.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/* ----- Server identity images (icon / banner). Mirrors the forum image
 *  pipeline (routes/forums.ts): base64 data URL in, magic-byte sniffed,
 *  content-hashed, served from /uploads/servers/. Kept server-local because
 *  the forum helpers are private closures over the forums dir. ----- */
const SERVER_IMAGE_TYPES: Array<{ mime: string; ext: string; magic: number[] }> = [
  { mime: "image/png", ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/webp", ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
  { mime: "image/gif", ext: "gif", magic: [0x47, 0x49, 0x46, 0x38] },
];

function decodeServerDataUrl(dataUrl: string, maxBytes: number): Buffer | { error: string } {
  const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(dataUrl.trim());
  if (!m) return { error: "expected a base64 image data URL" };
  let bytes: Buffer;
  try { bytes = Buffer.from(m[1]!, "base64"); }
  catch { return { error: "bad base64 payload" }; }
  if (bytes.length === 0) return { error: "empty image" };
  if (bytes.length > maxBytes) return { error: `image too large (max ${Math.round(maxBytes / 1024)}KB)` };
  return bytes;
}

function sniffServerImage(bytes: Buffer): { mime: string; ext: string } | null {
  for (const t of SERVER_IMAGE_TYPES) {
    if (bytes.length >= t.magic.length && t.magic.every((b, i) => bytes[i] === b)) return t;
  }
  return null;
}

/** Parse a stored icon/banner crop (AvatarCrop JSON) to an object, or null when
 *  unset/malformed. Mirrors the {zoom,offsetX,offsetY} shape user avatars use. */
function parseCrop(json: string | null | undefined): { zoom: number; offsetX: number; offsetY: number } | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    if (o && typeof o.zoom === "number" && typeof o.offsetX === "number" && typeof o.offsetY === "number") {
      return { zoom: o.zoom, offsetX: o.offsetX, offsetY: o.offsetY };
    }
  } catch { /* malformed → treat as unset */ }
  return null;
}

/** Catalog sort: the system server first, then featured, then name A→Z. */
function catalogRank(s: { isSystem: boolean; status: string }): number {
  if (s.isSystem) return 0;
  if (s.status === "featured") return 1;
  return 2;
}

/** The servers-table columns every ServerSummary builder reads. Selected
 *  identically by the catalog, discover, search, and tags endpoints so they
 *  all hand back the exact same card shape. */
const SERVER_SUMMARY_COLUMNS = {
  id: servers.id,
  slug: servers.slug,
  name: servers.name,
  tagline: servers.tagline,
  logoUrl: servers.logoUrl,
  iconColor: servers.iconColor,
  borderColor: servers.borderColor,
  iconCrop: servers.iconCrop,
  // Banner + horizontal-logo fields ride the catalog so the chat shell can
  // rebrand its top bar to the current server's identity without a detail
  // fetch.
  bannerImageUrl: servers.bannerImageUrl,
  bannerCoverCss: servers.bannerCoverCss,
  bannerFocusY: servers.bannerFocusY,
  bannerCrop: servers.bannerCrop,
  bannerHeight: servers.bannerHeight,
  horizontalLogoUrl: servers.horizontalLogoUrl,
  isSystem: servers.isSystem,
  isDefault: servers.isDefault,
  status: servers.status,
  visibility: servers.visibility,
  joinMode: servers.joinMode,
  ownerUserId: servers.ownerUserId,
  tagsJson: servers.tagsJson,
  createdAt: servers.createdAt,
} as const;

type ServerSummaryRow = {
  [K in keyof typeof SERVER_SUMMARY_COLUMNS]: (typeof servers.$inferSelect)[K];
};

/** The viewer-relative enrichment the catalog/discover/search summaries layer
 *  on top of a row (one batched read each per request). Null `me` ⇒ anonymous
 *  viewer: viewerRole stays null and the favorite/unseen flags are omitted. */
interface SummaryViewerCtx {
  me: { id: string } | null;
  rolesBy: Map<string, ServerRole> | null;
  visitsBy: Map<string, number> | null;
  myDefaultServerId: string | null;
  activityBy: Map<string, number | null>;
}

/** Map ONE server row + viewer context to the ServerSummary wire shape. The
 *  single source of truth for the card shape — `tags` rides every surface. */
function buildServerSummary(s: ServerSummaryRow, ctx: SummaryViewerCtx) {
  const { me, rolesBy, visitsBy, myDefaultServerId, activityBy } = ctx;
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
    borderColor: s.borderColor ?? null,
    iconCrop: parseCrop(s.iconCrop),
    bannerImageUrl: s.bannerImageUrl ?? null,
    bannerCoverCss: s.bannerCoverCss ?? null,
    bannerFocusY: s.bannerFocusY ?? null,
    bannerCrop: parseCrop(s.bannerCrop),
    bannerHeight: s.bannerHeight ?? null,
    horizontalLogoUrl: s.horizontalLogoUrl ?? null,
    isSystem: !!s.isSystem,
    isDefault: !!s.isDefault,
    status: s.status,
    visibility: s.visibility,
    joinMode: s.joinMode,
    viewerRole: role,
    // Owner-set discovery tags (migration 0301); [] when unset.
    tags: parseTagsJson(s.tagsJson),
    // The viewer's chosen favorite/default server (users.default_server_id)
    // — the rail/discover surface marks it + offers the set/clear toggle.
    // Only meaningful for signed-in viewers.
    ...(me ? { isMyDefault: myDefaultServerId === s.id } : {}),
    ...(me ? { hasUnseen: !!last && (!seen || last > seen) } : {}),
  };
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

export async function registerServerRoutes(app: FastifyInstance, db: Db, io: Io, uploadsRoot: string, registry: CommandRegistry): Promise<void> {
  // Per-server admin surfaces (Admin Partition — plan_ext.md §7). Self-contained
  // modules, each gated on its own SERVER_MOD_PERMISSION via serverAuthority.
  await registerServerReportRoutes(app, db, io);
  await registerServerModCaseRoutes(app, db, io);
  await registerServerEmoticonRoutes(app, db, io, uploadsRoot);
  await registerServerAnnouncementRoutes(app, db, io);
  await registerServerFaqRoutes(app, db, io);
  await registerServerCommandTitleRoutes(app, db, io, registry);
  await registerServerEarningRoutes(app, db, io, uploadsRoot);

  const serversImgDir = join(uploadsRoot, "servers");

  /** Write a content-hashed server image; returns its public URL. */
  async function writeServerImage(
    prefix: string,
    dataUrl: string,
    maxBytes: number,
  ): Promise<{ url: string } | { error: string; status: number }> {
    const decoded = decodeServerDataUrl(dataUrl, maxBytes);
    if ("error" in decoded) return { error: decoded.error, status: 400 };
    const detected = sniffServerImage(decoded);
    if (!detected) return { error: "unsupported image type (png, jpg, webp, gif only)", status: 415 };
    const hash = createHash("sha256").update(decoded).digest("hex").slice(0, 16);
    const filename = `${prefix}-${hash}.${detected.ext}`;
    await mkdir(serversImgDir, { recursive: true });
    await writeFile(join(serversImgDir, filename), decoded);
    return { url: `/uploads/servers/${filename}` };
  }

  /** Best-effort removal of a replaced /uploads/servers/ file. */
  function unlinkServerImage(url: string | null | undefined): void {
    if (!url?.startsWith("/uploads/servers/")) return;
    const filename = url.slice("/uploads/servers/".length);
    if (filename) unlink(join(serversImgDir, filename)).catch(() => { /* best-effort */ });
  }

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
    return { me, rolesBy, visitsBy, myDefaultServerId, activityBy };
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
    const ctx = await loadSummaryViewerCtx(me, activityBy);

    const out = rows.map((s) => buildServerSummary(s, ctx));
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

  /** WHERE for the discover surfaces: public, non-archived servers only. */
  const discoverableWhere = and(
    eq(servers.visibility, "public"),
    sql`${servers.status} != 'archived'`,
  );

  /** GET /servers/discover — { popular, new }. `popular` is member-count desc
   *  then most-recent-activity/createdAt desc; `new` is createdAt desc. Each
   *  capped at 12 and built with the full catalog summary shape. */
  app.get("/servers/discover", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const me = await getSessionUser(req, db).catch(() => null);

    const rows = await db.select(SERVER_SUMMARY_COLUMNS).from(servers).where(discoverableWhere);
    const activityBy = await loadActivityBy();
    const ctx = await loadSummaryViewerCtx(me, activityBy);

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
    const ctx = await loadSummaryViewerCtx(me, activityBy);

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
      reply.code(403); return { error: "Server creation applications aren't available to you." };
    }
    let body: z.infer<typeof submitBody>;
    try { body = submitBody.parse(req.body); }
    catch { reply.code(400); return { error: `Check the fields: name ${SERVER_NAME_MIN}-${SERVER_NAME_MAX} chars, purpose ${SERVER_PURPOSE_MIN}-${SERVER_PURPOSE_MAX} chars.` }; }

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
      reply.code(400); return { error: "Please read and agree to the server registration rules before applying." };
    }

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
        // Record the moment of agreement only when rules were actually in force
        // at submit; NULL otherwise (legacy / no gate).
        agreedAt: rulesInForce ? new Date() : null,
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
    if (!a.isMember) { reply.code(403); return { error: "You can only set a server you belong to as your default." }; }
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

  // Pan/zoom focus for the icon + banner — the same AvatarCrop shape user
  // avatars use ({zoom,offsetX,offsetY}); persisted as JSON.
  const cropSchema = z.object({
    zoom: z.number().min(1).max(4),
    offsetX: z.number().min(0).max(100),
    offsetY: z.number().min(0).max(100),
  }).strict();

  const patchServerBody = z.object({
    name: z.string().trim().min(SERVER_NAME_MIN).max(SERVER_NAME_MAX).optional(),
    tagline: z.string().trim().max(SERVER_TAGLINE_MAX).nullable().optional(),
    descriptionHtml: z.string().max(5000 * 4).nullable().optional(),
    logoUrl: z.string().trim().max(2048).nullable().optional(),
    iconColor: z.string().trim().max(32).nullable().optional(),
    borderColor: z.string().trim().max(32).nullable().optional(),
    iconCrop: cropSchema.nullable().optional(),
    bannerCrop: cropSchema.nullable().optional(),
    themeJson: z.string().max(4000).nullable().optional(),
    themeStyleKey: z.string().trim().min(1).max(64).nullable().optional(),
    bannerFocusY: z.number().int().min(0).max(100).optional(),
    bannerHeight: z.number().int().min(48).max(240).nullable().optional(),
    publicBrowsing: z.boolean().optional(),
    joinMode: z.enum(["open", "application", "invite"]).optional(),
    applicationPrompt: z.string().trim().max(300).nullable().optional(),
    /** Owner-set discovery tags (migration 0301). normalizeTags/serializeTags
     *  do the real sanitizing on persist — the loose array bound just rejects
     *  absurd payloads before we touch the normalizer. */
    tags: z.array(z.string()).max(64).optional(),
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
    if (body.borderColor !== undefined) update.borderColor = body.borderColor?.trim() ? body.borderColor.trim() : null;
    if (body.iconCrop !== undefined) update.iconCrop = body.iconCrop ? JSON.stringify(body.iconCrop) : null;
    if (body.bannerCrop !== undefined) update.bannerCrop = body.bannerCrop ? JSON.stringify(body.bannerCrop) : null;
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
    if (body.bannerHeight !== undefined) update.bannerHeight = body.bannerHeight;
    if (body.publicBrowsing !== undefined) update.publicBrowsing = body.publicBrowsing;
    if (body.applicationPrompt !== undefined) {
      update.applicationPrompt = body.applicationPrompt?.trim() ? body.applicationPrompt.trim() : null;
    }
    // serializeTags normalizes (lowercase/dedupe/clamp) and returns NULL when
    // the list is empty, so an empty array clears the column.
    if (body.tags !== undefined) update.tagsJson = serializeTags(body.tags);
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
        .where(roomsOfServerWhere(gate.server.id))).map((r) => r.id));
      update.roomOrderJson = JSON.stringify(body.roomOrder.filter((id) => own.has(id)));
    }
    await db.update(servers).set(update).where(eq(servers.id, gate.server.id));
    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_appearance_update",
      metadata: { slug: gate.server.slug, fields: Object.keys(update).filter((k) => k !== "updatedAt") },
    });
    return { ok: true };
  });

  /* ---------- Identity images: icon (logo) / banner upload ---------- */

  const serverImageBody = z.union([
    z.object({ imageDataUrl: z.string().min(32).max(4_000_000) }).strict(),
    z.object({ clear: z.literal(true) }).strict(),
  ]);

  // POST /servers/:id/{logo,banner,horizontal-logo} — upload (or clear) the
  // server's round icon / header banner / wide top-bar wordmark. Mirrors the
  // forum image endpoints; gated on manage_appearance (the same key the
  // appearance PATCH uses).
  const IMAGE_COLUMN = { logo: "logoUrl", banner: "bannerImageUrl", "horizontal-logo": "horizontalLogoUrl" } as const;
  for (const kind of ["logo", "banner", "horizontal-logo"] as const) {
    const maxBytes = kind === "logo" ? 512 * 1024 : kind === "horizontal-logo" ? 1024 * 1024 : 2 * 1024 * 1024;
    const column = IMAGE_COLUMN[kind];
    app.post<{ Params: { id: string }; Body: unknown }>(`/servers/:id/${kind}`, async (req, reply) => {
      if (!(await serversLive(reply))) return { error: "not found" };
      const gate = await requireServerPermission(req, req.params.id, "manage_appearance");
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      let body: z.infer<typeof serverImageBody>;
      try { body = serverImageBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const prev = gate.server[column];
      if ("clear" in body) {
        await db.update(servers).set({ [column]: null, updatedAt: new Date() }).where(eq(servers.id, gate.server.id));
        unlinkServerImage(prev);
      } else {
        const written = await writeServerImage(`${gate.server.id}-${kind}`, body.imageDataUrl, maxBytes);
        if ("error" in written) { reply.code(written.status); return { error: written.error }; }
        await db.update(servers).set({ [column]: written.url, updatedAt: new Date() }).where(eq(servers.id, gate.server.id));
        if (prev !== written.url) unlinkServerImage(prev);
        await auditServer(db, {
          serverId: gate.server.id, actorUserId: gate.me.id, action: "server_appearance_update",
          metadata: { slug: gate.server.slug, fields: [column] },
        });
        return { ok: true, url: written.url };
      }
      await auditServer(db, {
        serverId: gate.server.id, actorUserId: gate.me.id, action: "server_appearance_update",
        metadata: { slug: gate.server.slug, fields: [column], cleared: true },
      });
      return { ok: true, url: null };
    });
  }

  /* =========================================================
   *  Owner console: per-server ROOM admin (manage_rooms)
   *  The per-server analog of /admin/rooms — a server owner/mod manages THIS
   *  server's rooms (create/edit/delete) from the console instead of the global
   *  admin panel (plan.md §4 partition: "Rooms are a server's content").
   * ========================================================= */

  const serverRoomCreateBody = z.object({
    name: z.string().trim().min(1).max(40),
    type: z.enum(["public", "private"]).default("public"),
    password: z.string().min(1).max(128).optional(),
    topic: z.string().max(200).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    replyMode: z.enum(["flat", "nested"]).optional(),
    // A server channel persists when empty by default (Discord-like); the owner
    // can untick this to make an ephemeral, park-when-empty room instead.
    persistent: z.boolean().default(true),
  }).strict();

  /** Does this room belong to the gated server? NULL serverId is adopted by the
   *  default/system server (the documented contract), so the default server's
   *  console manages legacy NULL rooms too. */
  function roomInServer(room: { serverId: string | null }, serverId: string): boolean {
    return (room.serverId ?? DEFAULT_SERVER_ID) === serverId;
  }

  /** SQL WHERE counterpart of {@link roomInServer}: matches a server's rooms,
   *  adopting legacy NULL-serverId rooms into the default/system server so the
   *  default server's counts/activity/eviction/reorder/clear queries don't
   *  silently drop un-homed rooms (the prior "lost rooms" bug class). */
  function roomsOfServerWhere(serverId: string) {
    return serverId === DEFAULT_SERVER_ID
      ? or(eq(rooms.serverId, serverId), isNull(rooms.serverId))
      : eq(rooms.serverId, serverId);
  }

  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/rooms", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_rooms");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof serverRoomCreateBody>;
    try { body = serverRoomCreateBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    if (body.type === "private" && !body.password) { reply.code(400); return { error: "a private room needs a password" }; }
    const dup = (await db.select({ id: rooms.id }).from(rooms)
      .where(sql`lower(${rooms.name}) = ${body.name.toLowerCase()}`).limit(1))[0];
    if (dup) { reply.code(409); return { error: "a room with that name already exists" }; }
    const id = nanoid();
    const argon2 = (await import("argon2")).default;
    await db.insert(rooms).values({
      id,
      name: body.name,
      slug: await deriveUniqueRoomSlug(db, body.name),
      type: body.type,
      passwordHash: body.type === "private" && body.password ? await argon2.hash(body.password) : null,
      topic: body.topic?.trim() ? body.topic.trim() : null,
      description: body.description?.trim() ? body.description : null,
      ownerId: gate.me.id,
      originalOwnerUserId: gate.me.id,
      lastOwnerUserId: gate.me.id,
      replyMode: body.replyMode ?? "flat",
      serverId: gate.server.id,
      // Channels persist when empty so the server's structure survives a quiet
      // moment; without this the zombie sweep parks them within ~60s.
      persistent: body.persistent,
    });
    await auditServer(db, { serverId: gate.server.id, actorUserId: gate.me.id, action: "server_room_create", targetRoomId: id, metadata: { name: body.name } });
    emitTreeChanged(io, gate.server.id);
    return { ok: true, id };
  });

  const serverRoomPatchBody = z.object({
    name: z.string().trim().min(1).max(40).optional(),
    topic: z.string().max(200).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    type: z.enum(["public", "private"]).optional(),
    password: z.string().max(128).nullable().optional(),
    replyMode: z.enum(["flat", "nested"]).optional(),
    messageExpiryMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
    isDefault: z.boolean().optional(),
    persistent: z.boolean().optional(),
  }).strict();

  app.patch<{ Params: { id: string; roomId: string }; Body: unknown }>("/servers/:id/rooms/:roomId", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_rooms");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.roomId)).limit(1))[0];
    if (!room || !roomInServer(room, gate.server.id)) { reply.code(404); return { error: "no such room in this server" }; }
    let body: z.infer<typeof serverRoomPatchBody>;
    try { body = serverRoomPatchBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    if (body.name && body.name.toLowerCase() !== room.name.toLowerCase()) {
      const dup = (await db.select({ id: rooms.id }).from(rooms)
        .where(and(sql`lower(${rooms.name}) = ${body.name.toLowerCase()}`, ne(rooms.id, room.id))).limit(1))[0];
      if (dup) { reply.code(409); return { error: "a room with that name already exists" }; }
    }
    const update: Partial<typeof rooms.$inferInsert> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.topic !== undefined) update.topic = body.topic?.trim() ? body.topic.trim() : null;
    if (body.description !== undefined) update.description = body.description?.trim() ? body.description : null;
    if (body.replyMode !== undefined) update.replyMode = body.replyMode;
    if (body.persistent !== undefined) update.persistent = body.persistent;
    if (body.messageExpiryMinutes !== undefined) update.messageExpiryMinutes = body.messageExpiryMinutes;
    // One default room PER server (rooms_one_default_per_server). Flag-on first
    // clears whichever room in THIS server currently holds it.
    if (body.isDefault === true && !room.isDefault) {
      await db.update(rooms).set({ isDefault: false })
        .where(and(roomsOfServerWhere(gate.server.id), eq(rooms.isDefault, true)));
      update.isDefault = true;
    } else if (body.isDefault === false) {
      update.isDefault = false;
    }
    if (body.type !== undefined && body.type !== room.type) {
      update.type = body.type;
      const argon2 = (await import("argon2")).default;
      if (body.type === "private") {
        if (body.password) update.passwordHash = await argon2.hash(body.password);
        else if (!room.passwordHash) { reply.code(400); return { error: "switching to private requires a password" }; }
      } else { update.passwordHash = null; }
    } else if (body.password !== undefined) {
      const argon2 = (await import("argon2")).default;
      update.passwordHash = body.password ? await argon2.hash(body.password) : null;
    }
    await db.update(rooms).set(update).where(eq(rooms.id, room.id));
    await auditServer(db, { serverId: gate.server.id, actorUserId: gate.me.id, action: "server_room_update", targetRoomId: room.id, metadata: { fields: Object.keys(update) } });
    await broadcastRoomState(io, db, room.id);
    emitTreeChanged(io, gate.server.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string; roomId: string } }>("/servers/:id/rooms/:roomId", async (req, reply) => {
    if (!(await serversLive(reply))) return { error: "not found" };
    const gate = await requireServerPermission(req, req.params.id, "manage_rooms");
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.roomId)).limit(1))[0];
    if (!room || !roomInServer(room, gate.server.id)) { reply.code(404); return { error: "no such room in this server" }; }
    if (room.isSystem) { reply.code(400); return { error: "this room is the server's system room and can't be deleted" }; }
    // Relocate live occupants to this server's landing (then canonical), mirror
    // the global admin hatchet; cascade FKs clean up members/messages/bans.
    const landing = (await findServerLanding(db, gate.server.id)) ?? (await findCanonicalLanding(db));
    const remoteSockets = await io.in(`room:${room.id}`).fetchSockets();
    for (const s of remoteSockets) {
      s.leave(`room:${room.id}`);
      s.emit("error:notice", { code: "ROOM_DELETED", message: `Room "${room.name}" was removed.` });
      if (landing) {
        s.join(`room:${landing.id}`);
        (s.data as { roomId?: string }).roomId = landing.id;
        const uid = (s.data as { userId?: string }).userId;
        if (uid) await sendRoomBacklogTo(s, db, landing.id, uid);
      }
    }
    await db.delete(rooms).where(eq(rooms.id, room.id));
    await auditServer(db, { serverId: gate.server.id, actorUserId: gate.me.id, action: "server_room_delete", metadata: { roomId: room.id, roomName: room.name } });
    if (landing && remoteSockets.length > 0) await broadcastRoomState(io, db, landing.id);
    emitTreeChanged(io, gate.server.id);
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
      // A mod's grant excludes owner-only keys (manage_appearance) — appearance
      // stays owner-only, so even the owner can't hand it to a mod here.
      const permsJson = body.role === "mod"
        ? serializeServerModPermissions(
            (clampGrant(
              (body.permissions ? body.permissions.filter(isGrantableServerModPermission) : SERVER_MOD_DEFAULT_PERMISSIONS) as ServerPermission[],
              gate.authority.permissions,
              gate.authority.isOwner,
            ).filter(isGrantableServerModPermission)),
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
      // Owner-only keys (manage_appearance) are never grantable to a mod.
      const requested = body.permissions.filter(isGrantableServerModPermission) as ServerPermission[];
      const clamped = clampGrant(requested, gate.authority.permissions, gate.authority.isOwner).filter(isGrantableServerModPermission);
      // Preserve grantable powers the mod already holds that a lesser manager
      // can't grant — like the usergroup PATCH, a non-owner manager can only
      // add/remove within their OWN powers, never strip a power the owner gave.
      const preserved = gate.authority.isOwner
        ? []
        : parseServerModPermissions(row.permissionsJson).filter((p) => isGrantableServerModPermission(p) && !gate.authority.permissions.includes(p));
      const perms = [...new Set<ServerModPermission>([...clamped, ...preserved])];
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
   *  Usergroups (member-feature bundles + auto-join rules)
   *  Moderation power comes from the role tier, never a group.
   * ========================================================= */

  /** Usergroups grant MEMBER-FEATURE perms only — moderation power comes from
   *  the role tier, never from a group (so a group can't silently mint a mod).
   *  Clamp the request to the feature half AND to the actor's own powers. */
  function clampFeaturePerms(requested: ServerFeaturePermission[], actorPerms: ServerPermission[], isOwner: boolean): ServerFeaturePermission[] {
    const featureOnly = requested.filter(isServerFeaturePermission);
    if (isOwner) return featureOnly;
    const allowed = new Set(actorPerms);
    return featureOnly.filter((p) => allowed.has(p));
  }

  /** Validate a group's auto-join rules against THIS server: parse to the
   *  canonical shape (floor min:1, cap) and drop `posted_in_room` rules whose
   *  room isn't one of this server's rooms. */
  async function validServerAutoRules(serverId: string, raw: unknown): Promise<ServerAutoRule[]> {
    const parsed = parseServerAutoRules(JSON.stringify(raw ?? []));
    const roomRuleIds = parsed.filter((r) => r.kind === "posted_in_room").map((r) => (r as { roomId: string }).roomId);
    let validRooms = new Set<string>();
    if (roomRuleIds.length) {
      // Reuse serverRoomIds so room validation adopts legacy NULL-serverId rooms
      // on the default server identically to the auto-group evaluator.
      validRooms = new Set(await serverRoomIds(db, serverId));
    }
    return parsed.filter((r) => r.kind !== "posted_in_room" || validRooms.has((r as { roomId: string }).roomId)).slice(0, SERVER_MAX_AUTO_RULES);
  }

  const groupBody = z.object({
    name: z.string().trim().min(1).max(SERVER_USERGROUP_NAME_MAX),
    color: z.string().trim().max(32).nullable().optional(),
    permissions: z.array(z.string()).max(SERVER_PERMISSIONS.length + 5).optional(),
    autoRules: z.array(z.unknown()).max(SERVER_MAX_AUTO_RULES + 4).optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  }).strict();
  const patchGroupBody = z.object({
    name: z.string().trim().min(1).max(SERVER_USERGROUP_NAME_MAX).optional(),
    color: z.string().trim().max(32).nullable().optional(),
    permissions: z.array(z.string()).max(SERVER_PERMISSIONS.length + 5).optional(),
    autoRules: z.array(z.unknown()).max(SERVER_MAX_AUTO_RULES + 4).optional(),
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
        permissions: parseServerFeaturePermissions(g.permissionsJson),
        isDefault: !!g.isDefault,
        sortOrder: g.sortOrder,
        autoRules: parseServerAutoRules(g.autoRulesJson),
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
    if (count >= SERVER_MAX_USERGROUPS) { reply.code(409); return { error: `A server can have at most ${SERVER_MAX_USERGROUPS} usergroups.` }; }
    const requested = (body.permissions ?? []).filter(isServerFeaturePermission) as ServerFeaturePermission[];
    const perms = clampFeaturePerms(requested, gate.authority.permissions, gate.authority.isOwner);
    const autoRules = await validServerAutoRules(gate.server.id, body.autoRules);
    const id = nanoid();
    await db.insert(serverUsergroups).values({
      id, serverId: gate.server.id, name: body.name, color: body.color ?? null,
      permissionsJson: serializeServerFeaturePermissions(perms),
      isDefault: false, sortOrder: body.sortOrder ?? count, autoRulesJson: serializeServerAutoRules(autoRules),
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
      const requested = body.permissions.filter(isServerFeaturePermission) as ServerFeaturePermission[];
      const clamped = clampFeaturePerms(requested, gate.authority.permissions, gate.authority.isOwner);
      // Preserve feature perms the group already holds that a lesser manager
      // can't grant — they can only add/remove within their own powers.
      const preserved = gate.authority.isOwner
        ? []
        : parseServerFeaturePermissions(group.permissionsJson).filter((p) => !gate.authority.permissions.includes(p));
      update.permissionsJson = serializeServerFeaturePermissions([...new Set([...clamped, ...preserved])]);
    }
    // Auto-rules are meaningless on the default group (its membership is
    // everyone) — only honored on named groups.
    if (body.autoRules !== undefined && !group.isDefault) {
      update.autoRulesJson = serializeServerAutoRules(await validServerAutoRules(gate.server.id, body.autoRules));
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
    // Optional anti-spam sweep: hide the user's posts IN THIS SERVER'S ROOMS —
    // a lookback window in ms, or "all". Scoped, so the rest of the Spire is
    // untouched (mirrors the server-ban's room-only blast radius).
    purgePosts: z.union([z.number().int().positive().max(366 * 24 * 3_600_000), z.literal("all")]).optional(),
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
      .where(roomsOfServerWhere(gate.server.id))).map((r) => r.id);
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

    // Optional anti-spam sweep: soft-hide their posts, scoped to THIS server's
    // rooms only. Kept as tombstones for admin audit, removed live for others.
    let postsHidden = 0;
    if (body.purgePosts != null && roomIds.length) {
      try {
        postsHidden = await softHideUserMessages(db, io, {
          targetUserId: target.userId,
          window: body.purgePosts,
          actor: { userId: gate.me.id, displayName: gate.me.username },
          roomIds,
        });
      } catch { /* best-effort; the ban already committed */ }
    }

    await auditServer(db, {
      serverId: gate.server.id, actorUserId: gate.me.id, action: "server_ban",
      targetUserId: target.userId, reason: body.reason ?? null,
      metadata: {
        slug: gate.server.slug, until: until ? +until : null,
        ...(body.purgePosts != null ? { purgePosts: body.purgePosts, postsHidden } : {}),
      },
    });
    return { ok: true, userId: target.userId, username: target.username, postsHidden };
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
    await notifyUser(io, db, target.userId, {
      code: "SERVER_TRANSFERRED",
      message: `You are now the owner of "${gate.server.name}".`,
      persist: {
        category: "server",
        kind: "system",
        serverId: gate.server.id,
        title: `You now own ${gate.server.name}`,
        snippet: "Ownership was transferred to you.",
        target: { kind: "server", id: gate.server.id },
      },
    });
    return { ok: true, ownerUserId: target.userId, ownerUsername: target.username };
  });
}
