/**
 * Forums Catalog routes (Forums revamp, Phase 1).
 *
 *   GET /forums              → ForumSummary[] (catalog rail)
 *   GET /forums/:idOrSlug    → ForumDetail (content pane: header + boards +
 *                              viewer gates)
 *
 * Both endpoints are ANONYMOUS-TOLERANT by design: they only expose public
 * fields, and the Phase-7 public `/f/<slug>` page reuses them verbatim for
 * logged-out visitors (viewer: null). Forum mutation routes (Phase 2+) will
 * require sessions like everything else.
 */
import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { and, asc, desc, eq, inArray, isNull, isNotNull, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, unlink, writeFile } from "node:fs/promises";
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
import type {
  ClientToServerEvents,
  ForumBoardSummary,
  ForumCreationApplicationWire,
  ForumDetail,
  ForumSummary,
  ForumViewerState,
  ServerToClientEvents,
} from "@thekeep/shared";
import { auditLog, characters, forumBans, forumCreationApplications, forumMembers, forumMembershipApplications, forumPrefixes, forumReports, forumUsergroupMembers, forumUsergroups, forums, messages, roomThreadCategories, rooms, users, worlds } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";
import { hasPermission } from "../auth/permissions.js";
import { forumAuthority, forumCan } from "../forums/authority.js";
import { ensureDefaultUsergroup } from "../forums/usergroups.js";
import { resolveIdentityArg } from "../commands/identityArg.js";
import { recordAudit } from "../audit.js";
import { isModeratorRole, normalizeTheme } from "@thekeep/shared";
import {
  FORUM_FEATURE_PERMISSIONS,
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
  parsePrefixCategoryIds,
  serializeForumAutoRules,
  serializeForumModPermissions,
  serializeForumPermissions,
  type ForumAutoRule,
  type ForumCategoryRef,
  type ForumModPermission,
  type ForumPermission,
  type ForumUsergroupMemberWire,
  type ForumUsergroupWire,
} from "@thekeep/shared";
import { broadcastPresence, findCanonicalLanding, sendRoomBacklogTo } from "../realtime/broadcast.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** Sort: the system forum first, then featured, then name A→Z. The rail
 *  reads top-to-bottom as "home, curated picks, everything else". */
function catalogRank(f: { isSystem: boolean; status: string }): number {
  if (f.isSystem) return 0;
  if (f.status === "featured") return 1;
  return 2;
}

/* =====================================================================
 *  Image upload helpers — same posture as the emoticon pipeline: base64
 *  data-URL bodies, a small magic-byte whitelist, per-purpose byte caps,
 *  content-hashed filenames under /uploads/forums/ so re-uploads dedupe
 *  and replacements bust caches with a fresh URL.
 * ===================================================================== */
const FORUM_IMAGE_TYPES: Array<{ mime: string; ext: string; magic: number[] }> = [
  { mime: "image/png", ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/webp", ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
  { mime: "image/gif", ext: "gif", magic: [0x47, 0x49, 0x46, 0x38] },
];

function decodeForumDataUrl(dataUrl: string, maxBytes: number): Buffer | { error: string } {
  const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(dataUrl.trim());
  if (!m) return { error: "expected a base64 image data URL" };
  let bytes: Buffer;
  try { bytes = Buffer.from(m[1]!, "base64"); }
  catch { return { error: "bad base64 payload" }; }
  if (bytes.length === 0) return { error: "empty image" };
  if (bytes.length > maxBytes) return { error: `image too large (max ${Math.round(maxBytes / 1024)}KB)` };
  return bytes;
}

function sniffForumImage(bytes: Buffer): { mime: string; ext: string } | null {
  for (const t of FORUM_IMAGE_TYPES) {
    if (bytes.length >= t.magic.length && t.magic.every((b, i) => bytes[i] === b)) return t;
  }
  return null;
}

export async function registerForumRoutes(app: FastifyInstance, db: Db, io: Io, uploadsRoot: string): Promise<void> {
  const forumsDir = join(uploadsRoot, "forums");

  /** Write a content-hashed forum image; returns its public URL. */
  async function writeForumImage(
    prefix: string,
    dataUrl: string,
    maxBytes: number,
  ): Promise<{ url: string } | { error: string; status: number }> {
    const decoded = decodeForumDataUrl(dataUrl, maxBytes);
    if ("error" in decoded) return { error: decoded.error, status: 400 };
    const detected = sniffForumImage(decoded);
    if (!detected) return { error: "unsupported image type (png, jpg, webp, gif only)", status: 415 };
    const hash = createHash("sha256").update(decoded).digest("hex").slice(0, 16);
    const filename = `${prefix}-${hash}.${detected.ext}`;
    await mkdir(forumsDir, { recursive: true });
    await writeFile(join(forumsDir, filename), decoded);
    return { url: `/uploads/forums/${filename}` };
  }

  /** Best-effort removal of a replaced /uploads/forums/ file. */
  function unlinkForumImage(url: string | null | undefined): void {
    if (!url?.startsWith("/uploads/forums/")) return;
    const filename = url.slice("/uploads/forums/".length);
    if (filename) unlink(join(forumsDir, filename)).catch(() => { /* best-effort */ });
  }

  app.get("/forums", async (req) => {
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
    const { forumVisits } = await import("../db/schema.js");
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

  app.get<{ Params: { idOrSlug: string } }>("/forums/:idOrSlug", async (req, reply) => {
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
    const { forumVisits } = await import("../db/schema.js");
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
      boards,
      prefixes: prefixRows,
      categories: categoryRefs,
      viewer,
      stats,
    };
    return detail;
  });

  /* =========================================================
   *  "Create your Forum" applications (Phase 2)
   *
   *  GET   /forums/slug-availability?slug=…  live form check
   *  POST  /forums/applications               submit (apply_create_forum)
   *  GET   /forums/applications/mine          applicant's own history
   *  GET   /admin/forums/applications         review queue (view_admin_forums)
   *  PATCH /admin/forums/applications/:id     approve/reject (review_forum_applications)
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
  }).strict();

  app.post<{ Body: unknown }>("/forums/applications", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "apply_create_forum", db))) {
      reply.code(403); return { error: "Forum creation applications aren't available to you." };
    }
    let body: z.infer<typeof submitBody>;
    try { body = submitBody.parse(req.body); }
    catch { reply.code(400); return { error: `Check the fields: name ${FORUM_NAME_MIN}-${FORUM_NAME_MAX} chars, purpose ${FORUM_PURPOSE_MIN}-${FORUM_PURPOSE_MAX} chars.` }; }

    const slug = normalizeForumSlug(body.slug);
    if (!slug) { reply.code(400); return { error: "That slug isn't usable - lowercase letters, numbers, and _ only (3-40), and not a reserved word." }; }
    const used = await slugInUse(slug);
    if (used) { reply.code(409); return { error: used === "taken" ? "That slug already belongs to a forum." : "Another pending application already claims that slug." }; }

    // One pending application per applicant (partial unique index backs this;
    // the pre-check keeps the error friendly).
    const pendingMine = (await db.select({ id: forumCreationApplications.id })
      .from(forumCreationApplications)
      .where(and(
        eq(forumCreationApplications.applicantUserId, me.id),
        eq(forumCreationApplications.status, "pending"),
      )).limit(1))[0];
    if (pendingMine) { reply.code(409); return { error: "You already have an application pending review." }; }

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
        return { error: `Your last application was declined recently - you can re-apply in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.` };
      }
    }

    // Owned-forums ceiling (archived forums don't count against it).
    const owned = (await db.select({ n: sql<number>`count(*)` }).from(forums)
      .where(and(eq(forums.ownerUserId, me.id), sql`${forums.status} != 'archived'`)))[0]?.n ?? 0;
    if (owned >= FORUM_MAX_OWNED_DEFAULT) {
      reply.code(409);
      return { error: `You already keep ${owned} forums - the limit is ${FORUM_MAX_OWNED_DEFAULT}.` };
    }

    const id = nanoid();
    try {
      await db.insert(forumCreationApplications).values({
        id,
        applicantUserId: me.id,
        requestedName: body.name,
        requestedSlug: slug,
        purpose: body.purpose,
      });
    } catch {
      // UNIQUE race on the partial pending index - same friendly 409.
      reply.code(409); return { error: "You already have an application pending review." };
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
        if (taken) { reply.code(409); return { error: "That slug was claimed since the application was filed. Reject with a note so the applicant can pick another." }; }
        const owned = (await db.select({ n: sql<number>`count(*)` }).from(forums)
          .where(and(eq(forums.ownerUserId, appRow.applicantUserId), sql`${forums.status} != 'archived'`)))[0]?.n ?? 0;
        if (owned >= FORUM_MAX_OWNED_DEFAULT) {
          reply.code(409); return { error: "The applicant is already at the owned-forums limit." };
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
        tx.insert(rooms).values({
          id: boardId,
          name: boardName,
          type: "public",
          ownerId: appRow.applicantUserId,
          originalOwnerUserId: appRow.applicantUserId,
          lastOwnerUserId: appRow.applicantUserId,
          topic: "General discussion",
          replyMode: "nested",
          forumId,
        }).run();
        tx.insert(messages).values({
          id: nanoid(),
          roomId: boardId,
          userId: "system",
          characterId: null,
          displayName: "The Spire",
          kind: "say",
          title: "Welcome, Keeper - your forum stands",
          body: [
            `${appRow.requestedName} is yours to tend. As its Keeper you can:`,
            "",
            "• Raise boards and shape categories from your forum settings (coming online in the next update).",
            "• Sticky and lock topics, and appoint Forum Moderators to help you tend the boards.",
            "• Welcome everyone, or gate posting behind an application - your call.",
            "• Set your forum's banner, sigil, and colors so the place feels like yours.",
            "",
            `Your forum lives at /forums - share the word. Pin this topic or sweep it away; the hall is yours.`,
          ].join("\n"),
          isSticky: true,
          lastActivityAt: new Date(),
        }).run();
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
        reply.code(409); return { error: "A room already uses this forum's board name - reject with a note so the applicant picks another slug." };
      }

      // Live toast to the applicant's open tabs (offline applicants see the
      // status in the Create-Forum modal next time).
      try {
        const sockets = await io.fetchSockets();
        for (const s of sockets) {
          if ((s.data as { userId?: string }).userId !== appRow.applicantUserId) continue;
          s.emit("error:notice", nextStatus === "approved"
            ? { code: "FORUM_APP_APPROVED", message: `Your forum "${appRow.requestedName}" was approved - find it in the Forums Catalog!` }
            : { code: "FORUM_APP_REJECTED", message: `Your forum application "${appRow.requestedName}" was declined${body.reviewNote ? `: ${body.reviewNote}` : "."}` });
        }
      } catch { /* notification is best-effort */ }

      const rows = await db.select().from(forumCreationApplications)
        .where(eq(forumCreationApplications.id, appRow.id)).limit(1);
      return { application: (await toAppWire(rows))[0] };
    },
  );

  /* =========================================================
   *  In-modal board reading (Phase 1B)
   *
   *  GET /forums/boards/:roomId/topics?before=<ms>&limit=<n>
   *
   *  Topic cards for a board, stickies pinned to the first page, the
   *  rest in lastActivity DESC order with cursor pagination. Forum
   *  gates apply (ban / members-only); the viewer's ignore + block
   *  filters mirror the chat backlog so hidden authors stay hidden.
   *  Reading a single topic reuses the existing
   *  GET /rooms/:roomId/messages/:messageId/thread route.
   * ========================================================= */
  app.get<{
    Params: { roomId: string };
    Querystring: { before?: string; limit?: string };
  }>("/forums/boards/:roomId/topics", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const room = (await db.select().from(rooms).where(eq(rooms.id, req.params.roomId)).limit(1))[0];
    if (!room || !room.forumId || room.archivedAt) { reply.code(404); return { error: "no board" }; }
    const { forumGateForBoard } = await import("../forums/authority.js");
    const gate = await forumGateForBoard(db, me, room.forumId);
    if (!gate.ok) { reply.code(403); return { error: gate.message, code: gate.code }; }
    const isMember = gate.authority.isMember;
    // Private board: only owner/mods/members may read it (migration 0239).
    // The board still LISTS in the detail route (shown-but-locked); this
    // refuses its contents so the client renders the lock state.
    if (room.forumMembersOnly && !isMember) {
      reply.code(403);
      return { error: "This board is for forum members only.", code: "FORUM_BOARD_MEMBERS_ONLY" };
    }

    const before = req.query.before ? parseInt(req.query.before, 10) : NaN;
    const hasCursor = Number.isFinite(before) && before > 0;
    const limit = Math.min(50, Math.max(5, parseInt(req.query.limit ?? "30", 10) || 30));

    // Same hide set the chat backlog uses (one-way ignores + mutual blocks).
    const { blockedUserIdsFor } = await import("../auth/blocks.js");
    const { ignores } = await import("../db/schema.js");
    const hidden = new Set(
      (await db.select({ ignoredUserId: ignores.ignoredUserId })
        .from(ignores).where(eq(ignores.userId, me.id))).map((r) => r.ignoredUserId),
    );
    for (const b of await blockedUserIdsFor(db, me.id)) hidden.add(b);

    const activityExpr = sql<number>`coalesce(${messages.lastActivityAt}, ${messages.createdAt})`;
    const baseWhere = and(
      eq(messages.roomId, room.id),
      isNotNull(messages.title),
      isNull(messages.deletedAt),
    );

    // Stickies ride the FIRST page only (capped; they're furniture, not a
    // feed). Cursored pages are non-sticky history.
    const stickies = hasCursor ? [] : await db.select().from(messages)
      .where(and(baseWhere, eq(messages.isSticky, true)))
      .orderBy(desc(activityExpr))
      .limit(20);
    const pageRows = await db.select().from(messages)
      .where(and(
        baseWhere,
        eq(messages.isSticky, false),
        hasCursor ? sql`${activityExpr} < ${before}` : undefined,
      ))
      .orderBy(desc(activityExpr))
      .limit(limit + 1);
    const hasMore = pageRows.length > limit;
    const rows = [...stickies, ...(hasMore ? pageRows.slice(0, limit) : pageRows)]
      .filter((m) => !hidden.has(m.userId));

    const ids = rows.map((r) => r.id);
    const replyCounts = ids.length
      ? await db.select({ parentId: messages.replyToId, n: sql<number>`count(*)` })
          .from(messages)
          .where(and(inArray(messages.replyToId, ids), isNull(messages.deletedAt)))
          .groupBy(messages.replyToId)
      : [];
    const repliesBy = new Map(replyCounts.map((r) => [r.parentId, r.n]));

    const { roomThreadCategories } = await import("../db/schema.js");
    const cats = await db.select().from(roomThreadCategories)
      .where(eq(roomThreadCategories.roomId, room.id))
      .orderBy(roomThreadCategories.sortOrder, roomThreadCategories.createdAt);

    // Private categories: their chips still render (shown-but-locked) but a
    // non-member never sees the topics filed under them. The board itself is
    // open here (board-level gate above already passed).
    const lockedCatIds = new Set(
      isMember ? [] : cats.filter((c) => c.membersOnly).map((c) => c.id),
    );
    const visibleTopics = rows.filter(
      (m) => !(m.threadCategoryId && lockedCatIds.has(m.threadCategoryId)),
    );

    return {
      boardName: room.name,
      categories: cats.map((c) => ({
        id: c.id, name: c.name, iconUrl: c.iconUrl ?? null, sortOrder: c.sortOrder,
        membersOnly: !!c.membersOnly,
        locked: !!c.membersOnly && !isMember,
      })),
      topics: visibleTopics.map((m) => ({
        id: m.id,
        title: m.title ?? "",
        snippet: m.body.replace(/\s+/g, " ").slice(0, 200),
        authorUserId: m.userId,
        authorDisplayName: m.displayName,
        authorAvatarUrl: m.avatarUrl ?? null,
        authorColor: m.color ?? null,
        characterId: m.characterId ?? null,
        categoryId: m.threadCategoryId ?? null,
        prefixId: m.prefixId ?? null,
        isSticky: !!m.isSticky,
        locked: !!m.lockedAt,
        replyCount: repliesBy.get(m.id) ?? 0,
        createdAt: +m.createdAt,
        lastActivityAt: +(m.lastActivityAt ?? m.createdAt),
      })),
      hasMore,
    };
  });

  /* =========================================================
   *  Owner console (Phase 3): forum settings + board management
   *
   *  PATCH /forums/:id                          name/tagline/description/board order
   *  POST  /forums/:id/boards                   raise a board (cap enforced)
   *  PATCH /forums/:id/boards/:roomId           rename / set topic
   *  POST  /forums/:id/boards/:roomId/archive   retire a board (keep-but-hide)
   *
   *  All gated by forumAuthority.isOwner (the forum owner, or site staff
   *  holding manage_any_forum). Forum MODS deliberately fail these —
   *  the powers matrix gives them topic-level tools only. Category CRUD
   *  needs no new endpoints: boards carry rooms.ownerId = forum owner,
   *  so the existing /admin/rooms/:id/thread-categories routes (gated on
   *  room ownership) already serve the console.
   * ========================================================= */

  /** Owner-or-staff gate shared by the console endpoints. */
  async function requireForumOwner(req: Parameters<typeof getSessionUser>[0], forumId: string) {
    const me = await getSessionUser(req, db);
    if (!me) return { fail: { code: 401 as const, error: "auth" } };
    const a = await forumAuthority(db, me, forumId);
    if (!a.forum) return { fail: { code: 404 as const, error: "no forum" } };
    if (!a.isOwner) return { fail: { code: 403 as const, error: "forum owner only" } };
    return { me, forum: a.forum, authority: a };
  }

  /** Gate for an action a mod CAN be granted: passes for the owner/staff
   *  (who hold every key) OR a mod holding the specific granular permission.
   *  Returns the resolved authority so the handler can reason further. */
  async function requireForumPermission(
    req: Parameters<typeof getSessionUser>[0],
    forumId: string,
    key: ForumModPermission,
  ) {
    const me = await getSessionUser(req, db);
    if (!me) return { fail: { code: 401 as const, error: "auth" } };
    const a = await forumAuthority(db, me, forumId);
    if (!a.forum) return { fail: { code: 404 as const, error: "no forum" } };
    if (!forumCan(a, key)) return { fail: { code: 403 as const, error: "you don't have that forum permission" } };
    return { me, forum: a.forum, authority: a };
  }

  const FORUM_BOARD_NAME_RX = /^[\p{L}\p{N}_\-' ]{1,40}$/u;
  const patchForumBody = z.object({
    name: z.string().trim().min(FORUM_NAME_MIN).max(FORUM_NAME_MAX).optional(),
    tagline: z.string().trim().max(200).nullable().optional(),
    descriptionHtml: z.string().max(5000 * 4).nullable().optional(),
    boardOrder: z.array(z.string()).max(100).optional(),
    /** Phase 5 access gating: who may post. Flipping to "application"
     *  gates non-members on the next board open/post; existing members
     *  keep their rows. Flipping back to "open" simply stops consulting
     *  membership. */
    postingMode: z.enum(["open", "application"]).optional(),
    applicationPrompt: z.string().trim().max(300).nullable().optional(),
    /** Anonymous read access on /f/<slug> (posting still needs login). */
    publicBrowsing: z.boolean().optional(),
    /** Allow mods with create_tags to mint tags on the fly while tagging. */
    allowCustomTags: z.boolean().optional(),
    /** Phase 6 identity: per-forum theme (JSON string, normalized before
     *  storage; null clears) + linked world (must belong to the FORUM
     *  OWNER and not be private; null unlinks). */
    themeJson: z.string().max(4000).nullable().optional(),
    /** Design style key (ornaments/chrome — "glass" etc.). Stored as-is;
     *  the client's buildOrnamentStyle falls back to the site default for
     *  unknown keys, same loose posture as users.style_key. Null clears. */
    themeStyleKey: z.string().trim().min(1).max(64).nullable().optional(),
    /** Vertical banner focus, 0-100 (percent down the image). */
    bannerFocusY: z.number().int().min(0).max(100).optional(),
    linkedWorldId: z.string().nullable().optional(),
  }).strict();

  app.patch<{ Params: { id: string }; Body: unknown }>("/forums/:id", async (req, reply) => {
    const gate = await requireForumOwner(req, req.params.id);
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof patchForumBody>;
    try { body = patchForumBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const update: Partial<typeof forums.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.tagline !== undefined) update.tagline = body.tagline?.trim() ? body.tagline.trim() : null;
    if (body.descriptionHtml !== undefined) {
      // Same sanitizer profile bios run through; the description renders
      // inside the catalog + the future /f/ page.
      const { sanitizeBio } = await import("../auth/html.js");
      update.descriptionHtml = body.descriptionHtml?.trim() ? sanitizeBio(body.descriptionHtml) : null;
    }
    if (body.boardOrder !== undefined) {
      // Persist only ids that are actually this forum's boards — a stale
      // client list can't smuggle foreign room ids into the ordering.
      const own = new Set((await db.select({ id: rooms.id }).from(rooms)
        .where(eq(rooms.forumId, gate.forum.id))).map((r) => r.id));
      update.boardOrderJson = JSON.stringify(body.boardOrder.filter((id) => own.has(id)));
    }
    if (body.postingMode !== undefined) update.postingMode = body.postingMode;
    if (body.publicBrowsing !== undefined) update.publicBrowsing = body.publicBrowsing;
    if (body.allowCustomTags !== undefined) update.allowCustomTags = body.allowCustomTags;
    if (body.applicationPrompt !== undefined) {
      update.applicationPrompt = body.applicationPrompt?.trim() ? body.applicationPrompt.trim() : null;
    }
    if (body.themeJson !== undefined) {
      if (body.themeJson === null || !body.themeJson.trim()) {
        update.themeJson = null;
      } else {
        // normalizeTheme clamps every slot to a sane hex; storing the
        // NORMALIZED form means readers never re-validate.
        try {
          update.themeJson = JSON.stringify(normalizeTheme(JSON.parse(body.themeJson)));
        } catch {
          reply.code(400); return { error: "themeJson must be a JSON theme object" };
        }
      }
    }
    if (body.themeStyleKey !== undefined) {
      update.themeStyleKey = body.themeStyleKey;
    }
    if (body.bannerFocusY !== undefined) {
      update.bannerFocusY = body.bannerFocusY;
    }
    if (body.linkedWorldId !== undefined) {
      if (body.linkedWorldId === null) {
        update.linkedWorldId = null;
      } else {
        // "Link one of the OWNER's worlds" — validated against the forum
        // owner (not the caller) so managing staff can't attach their own
        // world to someone's forum, and private worlds never leak via the
        // public strip.
        const w = (await db.select({ id: worlds.id, ownerUserId: worlds.ownerUserId, visibility: worlds.visibility })
          .from(worlds).where(eq(worlds.id, body.linkedWorldId)).limit(1))[0];
        if (!w || w.ownerUserId !== gate.forum.ownerUserId) {
          reply.code(404); return { error: "That world isn't one of the forum owner's." };
        }
        if (w.visibility === "private") {
          reply.code(409); return { error: "Private worlds can't be linked - the strip would expose them." };
        }
        update.linkedWorldId = w.id;
      }
    }
    await db.update(forums).set(update).where(eq(forums.id, gate.forum.id));
    return { ok: true };
  });

  /* ---------- Phase 6: identity images (logo / banner / category icons) ---------- */

  const imageBody = z.union([
    z.object({ imageDataUrl: z.string().min(32).max(4_000_000) }).strict(),
    z.object({ clear: z.literal(true) }).strict(),
  ]);

  for (const kind of ["logo", "banner"] as const) {
    const maxBytes = kind === "logo" ? 512 * 1024 : 2 * 1024 * 1024;
    app.post<{ Params: { id: string }; Body: unknown }>(`/forums/:id/${kind}`, async (req, reply) => {
      const gate = await requireForumOwner(req, req.params.id);
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      let body: z.infer<typeof imageBody>;
      try { body = imageBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const column = kind === "logo" ? "logoUrl" as const : "bannerImageUrl" as const;
      const prev = gate.forum[column];
      if ("clear" in body) {
        await db.update(forums).set({ [column]: null, updatedAt: new Date() }).where(eq(forums.id, gate.forum.id));
        unlinkForumImage(prev);
        return { ok: true, url: null };
      }
      const written = await writeForumImage(`${gate.forum.id}-${kind}`, body.imageDataUrl, maxBytes);
      if ("error" in written) { reply.code(written.status); return { error: written.error }; }
      await db.update(forums).set({ [column]: written.url, updatedAt: new Date() }).where(eq(forums.id, gate.forum.id));
      if (prev !== written.url) unlinkForumImage(prev);
      return { ok: true, url: written.url };
    });
  }

  app.post<{ Params: { id: string; roomId: string; catId: string }; Body: unknown }>(
    "/forums/:id/boards/:roomId/categories/:catId/icon",
    async (req, reply) => {
      const gate = await requireForumOwner(req, req.params.id);
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      const board = (await db.select({ id: rooms.id }).from(rooms)
        .where(and(eq(rooms.id, req.params.roomId), eq(rooms.forumId, gate.forum.id))).limit(1))[0];
      if (!board) { reply.code(404); return { error: "no board" }; }
      const { roomThreadCategories } = await import("../db/schema.js");
      const cat = (await db.select().from(roomThreadCategories)
        .where(and(eq(roomThreadCategories.id, req.params.catId), eq(roomThreadCategories.roomId, board.id))).limit(1))[0];
      if (!cat) { reply.code(404); return { error: "no category" }; }
      let body: z.infer<typeof imageBody>;
      try { body = imageBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }
      if ("clear" in body) {
        await db.update(roomThreadCategories).set({ iconUrl: null }).where(eq(roomThreadCategories.id, cat.id));
        unlinkForumImage(cat.iconUrl);
        return { ok: true, url: null };
      }
      const written = await writeForumImage(`cat-${cat.id}`, body.imageDataUrl, 128 * 1024);
      if ("error" in written) { reply.code(written.status); return { error: written.error }; }
      await db.update(roomThreadCategories).set({ iconUrl: written.url }).where(eq(roomThreadCategories.id, cat.id));
      if (cat.iconUrl !== written.url) unlinkForumImage(cat.iconUrl);
      return { ok: true, url: written.url };
    },
  );

  const createBoardBody = z.object({
    name: z.string().trim().min(1).max(40),
    topic: z.string().trim().max(200).optional(),
  }).strict();

  app.post<{ Params: { id: string }; Body: unknown }>("/forums/:id/boards", async (req, reply) => {
    const gate = await requireForumOwner(req, req.params.id);
    if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
    let body: z.infer<typeof createBoardBody>;
    try { body = createBoardBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    if (!FORUM_BOARD_NAME_RX.test(body.name)) {
      reply.code(400); return { error: "Board name must be 1-40 chars: letters, numbers, spaces, _ - '" };
    }
    const activeBoards = (await db.select({ n: sql<number>`count(*)` }).from(rooms)
      .where(and(eq(rooms.forumId, gate.forum.id), isNull(rooms.archivedAt))))[0]?.n ?? 0;
    if (activeBoards >= 10) {
      reply.code(409); return { error: "This forum is at its 10-board limit. Archive a board to raise another." };
    }
    // Room names are GLOBALLY unique (a board is a room); friendly 409
    // instead of a UNIQUE explosion.
    const clash = (await db.select({ id: rooms.id }).from(rooms)
      .where(sql`lower(${rooms.name}) = ${body.name.toLowerCase()}`).limit(1))[0];
    if (clash) { reply.code(409); return { error: "A room already uses that name - try a more specific one (board names are site-wide)." }; }

    const boardId = nanoid();
    await db.insert(rooms).values({
      id: boardId,
      name: body.name,
      type: "public",
      ownerId: gate.forum.ownerUserId,
      originalOwnerUserId: gate.forum.ownerUserId,
      lastOwnerUserId: gate.forum.ownerUserId,
      topic: body.topic?.trim() ? body.topic.trim() : null,
      replyMode: "nested",
      forumId: gate.forum.id,
    });
    io.emit("rooms:tree-changed");
    await recordAudit(db, {
      actorUserId: gate.me.id,
      action: "forum_board_create",
      targetRoomId: boardId,
      metadata: { forumId: gate.forum.id, slug: gate.forum.slug, boardName: body.name },
    });
    return { roomId: boardId };
  });

  const patchBoardBody = z.object({
    name: z.string().trim().min(1).max(40).optional(),
    topic: z.string().trim().max(200).nullable().optional(),
    /** Private board (migration 0239): owner/mods/members only. */
    membersOnly: z.boolean().optional(),
  }).strict();

  app.patch<{ Params: { id: string; roomId: string }; Body: unknown }>(
    "/forums/:id/boards/:roomId",
    async (req, reply) => {
      const gate = await requireForumOwner(req, req.params.id);
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      const board = (await db.select().from(rooms)
        .where(and(eq(rooms.id, req.params.roomId), eq(rooms.forumId, gate.forum.id))).limit(1))[0];
      if (!board || board.archivedAt) { reply.code(404); return { error: "no board" }; }
      let body: z.infer<typeof patchBoardBody>;
      try { body = patchBoardBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const update: Partial<typeof rooms.$inferInsert> = {};
      if (body.name !== undefined && body.name !== board.name) {
        if (!FORUM_BOARD_NAME_RX.test(body.name)) {
          reply.code(400); return { error: "Board name must be 1-40 chars: letters, numbers, spaces, _ - '" };
        }
        const clash = (await db.select({ id: rooms.id }).from(rooms)
          .where(and(sql`lower(${rooms.name}) = ${body.name.toLowerCase()}`, sql`${rooms.id} != ${board.id}`)).limit(1))[0];
        if (clash) { reply.code(409); return { error: "A room already uses that name." }; }
        update.name = body.name;
      }
      if (body.topic !== undefined) update.topic = body.topic?.trim() ? body.topic.trim() : null;
      if (body.membersOnly !== undefined) update.forumMembersOnly = body.membersOnly;
      if (Object.keys(update).length === 0) return { ok: true };
      await db.update(rooms).set(update).where(eq(rooms.id, board.id));
      io.emit("rooms:tree-changed");
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string; roomId: string } }>(
    "/forums/:id/boards/:roomId/archive",
    async (req, reply) => {
      const gate = await requireForumOwner(req, req.params.id);
      if ("fail" in gate) { reply.code(gate.fail.code); return { error: gate.fail.error }; }
      const board = (await db.select().from(rooms)
        .where(and(eq(rooms.id, req.params.roomId), eq(rooms.forumId, gate.forum.id))).limit(1))[0];
      if (!board) { reply.code(404); return { error: "no board" }; }
      if (board.archivedAt) return { ok: true };
      // Keep-but-hide: topics stay in the messages table; the board just
      // leaves the catalog. Site admins can resurrect via the admin Rooms
      // tools if a community changes its mind.
      await db.update(rooms).set({ archivedAt: new Date() }).where(eq(rooms.id, board.id));
      io.emit("rooms:tree-changed");
      await recordAudit(db, {
        actorUserId: gate.me.id,
        action: "forum_board_archive",
        targetRoomId: board.id,
        metadata: { forumId: gate.forum.id, slug: gate.forum.slug, boardName: board.name },
      });
      return { ok: true };
    },
  );

  /* =========================================================
   *  Phase 4: Forum Moderators + per-forum bans
   *
   *  GET    /forums/:id/roles          owner console Roles tab
   *  PUT    /forums/:id/mods           appoint a mod (identity token or name)
   *  DELETE /forums/:id/mods/:userId   remove a mod
   *  GET    /forums/:id/bans           owner console Bans tab
   *  PUT    /forums/:id/bans           ban (timed or permanent)
   *  DELETE /forums/:id/bans/:userId   lift a ban
   *
   *  All owner-gated (forum owner or manage_any_forum staff). Forum roles
   *  key on the USER account — moderation authority shouldn't flicker
   *  with character switches. Owner actions are audited so site staff
   *  can adjudicate disputes from the Audit tab ("Forums" group).
   * ========================================================= */

  /** Resolve a mod/ban target to a user account. Accepts `@id:`/`@cid:`
   *  tokens and bare names (the same resolver every command uses);
   *  ambiguous names get a "paste the token" message. */
  async function resolveForumTarget(raw: string): Promise<
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
   *  POST   /forums/:id/reports               flag a post (members)
   *  GET    /forums/:id/reports?status=open   queue (handle_reports)
   *  PATCH  /forums/:id/reports/:reportId     resolve / dismiss
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
   *  POST   /forums/:id/prefixes            create
   *  PATCH  /forums/:id/prefixes/:prefixId  edit (label/color/sort)
   *  DELETE /forums/:id/prefixes/:prefixId  delete (clears off topics)
   * (the catalog is read back via the forum detail endpoint)
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
   *  GET    /forums/:id/usergroups                  list (seeds default)
   *  POST   /forums/:id/usergroups                  create
   *  PATCH  /forums/:id/usergroups/:gid             edit
   *  DELETE /forums/:id/usergroups/:gid             delete (not the default)
   *  GET    /forums/:id/usergroups/:gid/members     roster
   *  PUT    /forums/:id/usergroups/:gid/members     add a member (manual)
   *  DELETE /forums/:id/usergroups/:gid/members/:userId  remove
   * All gated on manage_usergroups (owner/staff implicit). A non-owner
   * manager can't grant a permission they don't themselves hold (clamp).
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

  /* =========================================================
   *  Phase 5: membership applications (postingMode = "application")
   *
   *  POST   /forums/:id/membership-applications        apply (one pending)
   *  DELETE /forums/:id/membership-applications/mine   withdraw
   *  GET    /forums/:id/membership-applications        owner + forum mods
   *  PATCH  /forums/:id/membership-applications/:appId approve / deny
   *  POST   /forums/:id/leave                          member walks away
   *
   *  Mirrors the world-applications lifecycle: terminal rows stay as
   *  audit trail, the partial unique index enforces one PENDING per
   *  (forum, applicant), rejects leave the applicant free to re-apply.
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
      if (a.forum.postingMode !== "application") {
        reply.code(409); return { error: "This forum is open - no application needed, just post." };
      }
      if (a.ban) { reply.code(403); return { error: "You are banned from this forum." }; }
      if (a.isMember) { reply.code(409); return { error: "You're already a member here." }; }
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
      if (pending) { reply.code(409); return { error: "Your application is already pending." }; }

      try {
        await db.insert(forumMembershipApplications).values({
          id: nanoid(),
          forumId: a.forum.id,
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
      try {
        const sockets = await io.fetchSockets();
        for (const s of sockets) {
          if ((s.data as { userId?: string }).userId !== appRow.applicantUserId) continue;
          s.emit("error:notice", nextStatus === "approved"
            ? { code: "FORUM_MEMBER_APPROVED", message: `You're in - "${gate.forum.name}" approved your application.` }
            : { code: "FORUM_MEMBER_REJECTED", message: `"${gate.forum.name}" declined your application${body.reviewNote ? `: ${body.reviewNote}` : "."}` });
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
      reply.code(409); return { error: "The keeper can't leave their own forum." };
    }
    if (!a.role) { reply.code(409); return { error: "You're not a member here." }; }
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
    if (a.ban) { reply.code(403); return { error: "You are banned from this forum." }; }
    if (a.forum.postingMode === "application") {
      reply.code(409); return { error: "This forum reviews applications — apply to join instead." };
    }
    // Idempotent: owner/mods/existing members already have access.
    if (a.isMember) return { ok: true };
    await db.insert(forumMembers)
      .values({ forumId: a.forum.id, userId: me.id, role: "member" })
      .onConflictDoNothing();
    return { ok: true };
  });

  /* =========================================================
   *  Phase 8: visit markers + admin curation
   * ========================================================= */

  /** Stamp "this viewer looked at this forum now" — clears the rail's
   *  unseen dot. Fire-and-forget from the catalog on selection. */
  app.post<{ Params: { id: string } }>("/forums/:id/visit", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const { forumVisits } = await import("../db/schema.js");
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

  /* =========================================================
   *  Notification center: inbox + watches + topic reads
   * ========================================================= */

  /** Resolve a topic id to a live forum topic (board room + title row).
   *  Used by the watch + read endpoints so they can't mark arbitrary
   *  messages. */
  async function resolveForumTopic(topicId: string) {
    const m = (await db.select().from(messages).where(eq(messages.id, topicId)).limit(1))[0];
    if (!m || m.deletedAt || m.replyToId || !m.title) return null;
    const room = (await db.select().from(rooms).where(eq(rooms.id, m.roomId)).limit(1))[0];
    if (!room || !room.forumId) return null;
    return { topic: m, room };
  }

  app.get<{ Querystring: { limit?: string } }>("/forums/notifications", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
    const { listForumNotifications, unreadForumNotifications } = await import("../forums/notifications.js");
    const rows = await listForumNotifications(db, me.id, limit);
    return {
      unread: await unreadForumNotifications(db, me.id),
      notifications: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        forumId: n.forumId,
        boardRoomId: n.boardRoomId,
        topicId: n.topicId,
        messageId: n.messageId,
        actorName: n.actorName,
        topicTitle: n.topicTitle,
        snippet: n.snippet,
        createdAt: +n.createdAt,
        read: n.readAt != null,
      })),
    };
  });

  const notifReadBody = z.union([
    z.object({ ids: z.array(z.string()).min(1).max(200) }).strict(),
    z.object({ all: z.literal(true) }).strict(),
  ]);
  app.post<{ Body: unknown }>("/forums/notifications/read", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof notifReadBody>;
    try { body = notifReadBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const { markForumNotificationsRead, unreadForumNotifications } = await import("../forums/notifications.js");
    await markForumNotificationsRead(db, me.id, "all" in body ? "all" : body.ids);
    return { ok: true, unread: await unreadForumNotifications(db, me.id) };
  });

  /**
   * Resolve any message id (topic OR reply) to its forum coordinates —
   * { forumId, forumSlug, boardRoomId, topicId } — for permalink
   * navigation (`/f/<slug>/t/<topicId>#p-<postId>`). Anonymous callers
   * are allowed only when the forum has public browsing on.
   */
  app.get<{ Params: { topicId: string } }>("/forums/topics/:topicId/locate", async (req, reply) => {
    const me = await getSessionUser(req, db).catch(() => null);
    const m = (await db.select().from(messages).where(eq(messages.id, req.params.topicId)).limit(1))[0];
    if (!m || m.deletedAt) { reply.code(404); return { error: "not found" }; }
    const room = (await db.select().from(rooms).where(eq(rooms.id, m.roomId)).limit(1))[0];
    if (!room?.forumId) { reply.code(404); return { error: "not found" }; }
    const forum = (await db.select().from(forums).where(eq(forums.id, room.forumId)).limit(1))[0];
    if (!forum) { reply.code(404); return { error: "not found" }; }
    if (!me && !forum.publicBrowsing) { reply.code(401); return { error: "auth" }; }
    // Don't resolve a permalink into a private board/category for someone who
    // can't read it (migration 0239) — that would leak its existence and let
    // the client try (and fail) to open it. Replies inherit their topic's
    // category, so resolve the category off the TOPIC, not the hit.
    const { forumBoardReadGate } = await import("../forums/authority.js");
    const readGate = await forumBoardReadGate(db, me, room.id);
    const topicId = m.replyToId ?? m.id;
    const topicCatId = m.replyToId
      ? (await db.select({ c: messages.threadCategoryId }).from(messages)
          .where(eq(messages.id, topicId)).limit(1))[0]?.c ?? null
      : m.threadCategoryId ?? null;
    if (readGate.boardLocked || (topicCatId && readGate.lockedCatIds.has(topicCatId))) {
      reply.code(403);
      return { error: "This is a members-only section of the forum.", code: "FORUM_BOARD_MEMBERS_ONLY" };
    }
    return {
      forumId: forum.id,
      forumSlug: forum.slug,
      boardRoomId: room.id,
      topicId,
    };
  });

  app.put<{ Params: { topicId: string } }>("/forums/topics/:topicId/watch", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const t = await resolveForumTopic(req.params.topicId);
    if (!t) { reply.code(404); return { error: "no such topic" }; }
    const { ensureTopicWatch } = await import("../forums/notifications.js");
    await ensureTopicWatch(db, me.id, t.topic.id);
    return { ok: true };
  });

  app.delete<{ Params: { topicId: string } }>("/forums/topics/:topicId/watch", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const { forumTopicWatches } = await import("../db/schema.js");
    await db.delete(forumTopicWatches).where(and(
      eq(forumTopicWatches.userId, me.id),
      eq(forumTopicWatches.topicId, req.params.topicId),
    ));
    return { ok: true };
  });

  /** Stamp "viewer read this topic now" — clears its unread marker.
   *  Fire-and-forget from the catalog when a topic is opened. */
  app.post<{ Params: { topicId: string } }>("/forums/topics/:topicId/read", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const { forumTopicReads } = await import("../db/schema.js");
    const now = new Date();
    await db.insert(forumTopicReads)
      .values({ userId: me.id, topicId: req.params.topicId, lastReadAt: now })
      .onConflictDoUpdate({
        target: [forumTopicReads.userId, forumTopicReads.topicId],
        set: { lastReadAt: now },
      });
    return { ok: true };
  });
}
