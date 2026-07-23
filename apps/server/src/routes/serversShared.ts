/**
 * serversShared - module-level helpers, wire builders, and the routes context
 * shared by routes/servers.ts and its sub-registrars (serversCatalog /
 * serversMembership / serversConsole / serversModeration). Pure move-only
 * extraction of what used to sit at the top of routes/servers.ts and inside
 * registerServerRoutes; behavior is byte-identical.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Server as IoServer } from "socket.io";
import { eq, isNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { parseBackgroundArt, parseTagsJson } from "@thekeep/shared";
import type {
  BackgroundArt,
  ClientToServerEvents,
  Role,
  ServerPermission,
  ServerRole,
  ServerToClientEvents,
} from "@thekeep/shared";
import { auditLog, rooms, servers } from "../db/schema.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import type { Db } from "../db/index.js";
import type { ServerAuthority } from "../servers/authority.js";
import { resolveWorld } from "./worlds/shared.js";
import type { getSessionUser } from "./auth.js";

/** Parse a stored icon/banner crop (AvatarCrop JSON) to an object, or null when
 *  unset/malformed. Mirrors the {zoom,offsetX,offsetY} shape user avatars use. */
export function parseCrop(json: string | null | undefined): { zoom: number; offsetX: number; offsetY: number } | null {
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
export function catalogRank(s: { isSystem: boolean; status: string }): number {
  if (s.isSystem) return 0;
  if (s.status === "featured") return 1;
  return 2;
}

/** The servers-table columns every ServerSummary builder reads. Selected
 *  identically by the catalog, discover, search, and tags endpoints so they
 *  all hand back the exact same card shape. */
export const SERVER_SUMMARY_COLUMNS = {
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
  // Owner-uploaded background override (migration 0368). Rides the catalog
  // so the glass chat shell can swap its backdrop the moment the viewer
  // lands on this server, without a detail fetch. NSFW gating is handled
  // by the catalog/discover filters (18+ servers never reach viewers who
  // can't see NSFW), so the summary carries it plainly.
  backgroundJson: servers.backgroundJson,
  isSystem: servers.isSystem,
  isDefault: servers.isDefault,
  status: servers.status,
  visibility: servers.visibility,
  joinMode: servers.joinMode,
  ownerUserId: servers.ownerUserId,
  tagsJson: servers.tagsJson,
  createdAt: servers.createdAt,
  // Global-admin moderation state (migration 0306). Rides every summary so the
  // rail can badge a suspended/banned server for its owner/staff and the
  // catalog/discover filters can hide it from everyone else (lazy-expiry aware).
  moderationState: servers.moderationState,
  moderationUntil: servers.moderationUntil,
  moderationNote: servers.moderationNote,
  // "18+ community" flag + public-safe banner (age plan, Phase 2). The flag
  // rides so the rail/catalog filters can drop 18+ servers for viewers who
  // can't see NSFW and chip them "18+" for adults; the sfw banner is what
  // public/discovery surfaces show in place of the real banner art.
  isNsfw: servers.isNsfw,
  sfwBannerUrl: servers.sfwBannerUrl,
  // Community world link (migration 0346). The raw column never rides the
  // wire — buildServerSummary swaps it for the viewer-gated `world` ref
  // resolved in loadSummaryViewerCtx (private worlds read as null).
  worldId: servers.worldId,
} as const;

export type ServerSummaryRow = {
  [K in keyof typeof SERVER_SUMMARY_COLUMNS]: (typeof servers.$inferSelect)[K];
};

/** The viewer-relative enrichment the catalog/discover/search summaries layer
 *  on top of a row (one batched read each per request). Null `me` ⇒ anonymous
 *  viewer: viewerRole stays null and the favorite/unseen flags are omitted. */
export interface SummaryViewerCtx {
  me: { id: string } | null;
  rolesBy: Map<string, ServerRole> | null;
  visitsBy: Map<string, number> | null;
  myDefaultServerId: string | null;
  activityBy: Map<string, number | null>;
  /** Owner account id → display name, batched once per request over the rows
   *  in play. Drives the discover card's "by <owner>" link so a viewer can open
   *  the owner's profile (e.g. to message them for an invite to a closed
   *  server). */
  ownerNamesBy: Map<string, string>;
  /** Server id → the VIEWER-VISIBLE ref of its community world (migration
   *  0346). Resolved once per distinct world through {@link resolveWorld}, so
   *  a private/unlisted/18+-gated world the viewer can't open simply has no
   *  entry — the summary emits `world: null` and the name never leaks. */
  worldRefsBy: Map<string, ServerWorldRef>;
}

/** The brief world identity a server payload carries (migration 0346). */
export interface ServerWorldRef {
  id: string;
  slug: string;
  name: string;
}

/**
 * Resolve a server's community world to its wire ref FOR a given viewer.
 * The one rule every /servers payload follows: the world resolves through
 * {@link resolveWorld} (the canonical world visibility + NSFW gate), so a
 * private world returns null to anyone but its owner/admin, and an 18+
 * world returns null to minors and anonymous viewers. Never build the ref
 * from a raw row read.
 */
export async function resolveServerWorldRef(
  db: Db,
  worldId: string | null | undefined,
  viewer: { id: string; role: Role } | null,
): Promise<ServerWorldRef | null> {
  if (!worldId) return null;
  const w = await resolveWorld(db, worldId, viewer?.id ?? null, viewer?.role ?? null);
  return w ? { id: w.id, slug: w.slug, name: w.name } : null;
}

/** Map ONE server row + viewer context to the ServerSummary wire shape. The
 *  single source of truth for the card shape — `tags` rides every surface. */
export function buildServerSummary(s: ServerSummaryRow, ctx: SummaryViewerCtx) {
  const { me, rolesBy, visitsBy, myDefaultServerId, activityBy, ownerNamesBy } = ctx;
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
    // Background override as the parsed BackgroundArt bundle (or null).
    background: parseBackgroundArt(s.backgroundJson),
    isSystem: !!s.isSystem,
    isDefault: !!s.isDefault,
    status: s.status,
    visibility: s.visibility,
    joinMode: s.joinMode,
    viewerRole: role,
    // Server owner identity for the discover card's "by <owner>" link. Null on
    // the system/home server (no human owner to message). ownerName is null
    // when the owner row couldn't be resolved (deleted account).
    ownerUserId: s.ownerUserId ?? null,
    ownerName: s.ownerUserId ? ownerNamesBy.get(s.ownerUserId) ?? null : null,
    // Owner-set discovery tags (migration 0301); [] when unset.
    tags: parseTagsJson(s.tagsJson),
    // Global-admin moderation state — surfaced so the owner/staff (the only ones
    // this card is shown to when moderated) can badge SUSPENDED/BANNED and open
    // the server to fix it. A ban past its until is treated as 'none' (lazy
    // expiry, row not deleted). Timestamps normalized to ms (or null).
    moderationState: s.moderationState,
    moderationUntil: s.moderationUntil ? +s.moderationUntil : null,
    moderationNote: s.moderationNote ?? null,
    // 18+ community flag (age plan, Phase 2). Cards carrying `true` only ever
    // reach adult viewers — the catalog/discover routes filter first — so the
    // client just renders the "18+" chip. sfwBannerUrl rides for the owner
    // console; PUBLIC surfaces (share page, OG) swap banners server-side.
    isNsfw: !!s.isNsfw,
    sfwBannerUrl: s.sfwBannerUrl ?? null,
    // Community world (migration 0346): the viewer-gated ref resolved in
    // loadSummaryViewerCtx. Null when unset OR when THIS viewer can't open
    // the world (private/unlisted/18+ posture) — never the raw row.
    world: (s.worldId ? ctx.worldRefsBy.get(s.id) : null) ?? null,
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
export async function auditServer(
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

/** Does this room belong to the gated server? NULL serverId is adopted by the
 *  default/system server (the documented contract), so the default server's
 *  console manages legacy NULL rooms too. */
export function roomInServer(room: { serverId: string | null }, serverId: string): boolean {
  return (room.serverId ?? DEFAULT_SERVER_ID) === serverId;
}

/** SQL WHERE counterpart of {@link roomInServer}: matches a server's rooms,
 *  adopting legacy NULL-serverId rooms into the default/system server so the
 *  default server's counts/activity/eviction/reorder/clear queries don't
 *  silently drop un-homed rooms (the prior "lost rooms" bug class). */
export function roomsOfServerWhere(serverId: string) {
  return serverId === DEFAULT_SERVER_ID
    ? or(eq(rooms.serverId, serverId), isNull(rooms.serverId))
    : eq(rooms.serverId, serverId);
}

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;
type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;
type ServerRow = typeof servers.$inferSelect;

export type ServerGateResult =
  | { fail: { code: number; error: string } }
  | { me: SessionUser; server: ServerRow; authority: ServerAuthority };

export type ResolveTargetResult =
  | { ok: true; userId: string; username: string }
  | { ok: false; error: string };

/** The dependency bundle registerServerRoutes builds once and hands to each
 *  sub-registrar. Carries the emit hub, the feature gate, the owner/permission
 *  gates, the target resolver, and the image writers - all closures over db /
 *  uploadsRoot that stay defined in routes/servers.ts. */
export interface ServerRoutesCtx {
  app: FastifyInstance;
  db: Db;
  io: Io;
  serversLive: (reply: { code: (c: number) => unknown }) => Promise<boolean>;
  requireServerOwner: (req: FastifyRequest, serverId: string) => Promise<ServerGateResult>;
  requireServerPermission: (req: FastifyRequest, serverId: string, key: ServerPermission) => Promise<ServerGateResult>;
  resolveServerTarget: (raw: string, locale?: string | null) => Promise<ResolveTargetResult>;
  writeServerImage: (prefix: string, dataUrl: string, maxBytes: number, locale?: string | null) => Promise<{ url: string } | { error: string; status: number }>;
  /** Background override upload: renders the 2560w WebP/AVIF + average-color
   *  bundle via the images.ts sharp pipeline instead of storing bytes verbatim. */
  writeServerBackground: (prefix: string, dataUrl: string, maxBytes: number, locale?: string | null) => Promise<{ art: BackgroundArt } | { error: string; status: number }>;
  unlinkServerImage: (url: string | null | undefined) => void;
}
