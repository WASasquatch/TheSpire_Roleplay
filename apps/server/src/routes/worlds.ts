import type { FastifyInstance, FastifyRequest } from "fastify";
import { hasPermission } from "../auth/permissions.js";
import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  Role,
  Theme,
  WorldApplicationEntry,
  WorldApplicationList,
  WorldApplicationStatus,
  WorldCatalogEntry,
  WorldCatalogPage,
  WorldDetail,
  WorldGenre,
  WorldJoinMode,
  WorldMemberRef,
  WorldMembership,
  WorldPacing,
  WorldPage,
  WorldStatus,
  WorldSummary,
  WorldEntity,
  WorldEntityLight,
  WorldEntityKind,
  WorldArc,
  WorldArcStatus,
  WorldSession,
  WorldSessionLight,
  WorldVibeAxisKey,
  WorldVibeStats,
  WorldVisibility,
} from "@thekeep/shared";
import {
  CONTENT_WARNINGS,
  WORLD_APP_ANSWER_MAX_LEN,
  WORLD_APP_MAX_QUESTIONS,
  WORLD_APP_QUESTION_MAX_LEN,
  WORLD_APP_REVIEW_NOTE_MAX_LEN,
  WORLD_PAGE_DEPTH_CAP,
  WORLD_VIBE_AXES,
  BUILTIN_ENTITY_KIND_KEYS,
  WORLD_ENTITY_BODY_MAX,
  WORLD_ENTITY_PER_KIND_CAP,
  WORLD_ENTITY_KINDS_CAP,
  WORLD_ENTITY_SUMMARY_MAX,
  WORLD_ENTITY_NAME_MAX,
  WORLD_ARC_STATUSES,
  WORLD_ARCS_CAP,
  WORLD_SESSIONS_CAP,
  deriveSlug,
  normalizeTheme,
  parseTagList,
  serializeTagList,
} from "@thekeep/shared";
import {
  characters,
  roomMembers,
  roomWorldLinks,
  rooms,
  users,
  worldApplications,
  worldArcs,
  worldCollaborators,
  worldEntities,
  worldEntityKinds,
  worldMembers,
  worldPages,
  worldSessions,
  worlds,
} from "../db/schema.js";
import { sanitizeBio } from "../auth/html.js";
import { resolveIdentityArg } from "../commands/identityArg.js";
import { getSessionUser } from "./auth.js";
import { getSettings } from "../settings.js";
import { broadcastPresence, broadcastRoomState } from "../realtime/broadcast.js";
import { pushToUser } from "../push.js";
import type { Db } from "../db/index.js";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/**
 * Slug rules: lowercase letters, numbers, hyphens. 1-60 chars. The slug
 * lives in URLs and slash commands, so we keep it tight.
 */
const SLUG_RX = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

const visibilityEnum = z.enum(["private", "public", "open"]);
const genreEnum = z.enum([
  "fantasy", "modern", "scifi", "horror",
  "western", "steampunk", "mythological", "other",
]);
const statusEnum = z.enum(["active", "featured", "archived"]);
const pacingEnum = z.enum([
  "freeform",
  "drop-in",
  "casual",
  "slice-of-life",
  "structured",
  "long-form",
]);
const contentWarningEnum = z.enum(CONTENT_WARNINGS as unknown as [string, ...string[]]);

// Tags: each entry must look like a slug-ish kebab token. The canonical
// list is curated and short, but owners can add custom tags, this regex
// gates the *shape* (lowercase letters / digits / hyphens, 1-32 chars),
// not the membership. Empty input arrays are allowed (no tags).
const TAG_RX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const tagSchema = z
  .string()
  .min(1)
  .max(32)
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => TAG_RX.test(s), { message: "tags must be lowercase letters / digits / hyphens" });
const tagsArraySchema = z
  .array(tagSchema)
  .max(20)
  .transform((arr) => parseTagList(arr.join(",")));
const cwArraySchema = z
  .array(contentWarningEnum)
  .max(CONTENT_WARNINGS.length)
  .transform((arr) => parseTagList(arr.join(",")));

// Restrict cover image URLs to http(s), same posture as character
// avatars (the URL constructor rejects malformed input; we additionally
// gate the protocol).
const httpUrl = z.string().min(1).max(2000).refine(
  (s) => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } },
  { message: "coverImageUrl must use http or https" },
);

/**
 * Vibe-stat axis Zod schema. 0..100 inclusive integer, OR null to
 * clear an axis back to "unset". The shape mirrors WorldVibeStats,
 * every axis key is optional in the request body; only the keys the
 * author actually touched are sent over the wire.
 */
const vibeStatValue = z.union([
  z.number().int().min(0).max(100),
  z.null(),
]);
const vibeStatsSchema = z.object({
  combat: vibeStatValue.optional(),
  magic: vibeStatValue.optional(),
  technology: vibeStatValue.optional(),
  romance: vibeStatValue.optional(),
  politics: vibeStatValue.optional(),
  mystery: vibeStatValue.optional(),
  horror: vibeStatValue.optional(),
  exploration: vibeStatValue.optional(),
}).strict();

const joinModeEnum = z.enum(["open", "application", "invite-only"]);

/** Application question list: max 5 entries, each 1..280 chars. */
const applicationQuestionsSchema = z
  .array(z.string().min(1).max(WORLD_APP_QUESTION_MAX_LEN))
  .max(WORLD_APP_MAX_QUESTIONS)
  .transform((arr) => arr.map((s) => s.trim()).filter((s) => s.length > 0));

const createWorldBody = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().max(60).optional(),
  description: z.string().max(2000).nullable().optional(),
  visibility: visibilityEnum.optional(),
  // Catalog metadata, all optional on create so the world can be filled
  // out incrementally; defaults match the DB column defaults so missing
  // fields land in the catalog's "Other" bucket without an extra step.
  genre: genreEnum.optional(),
  tags: tagsArraySchema.optional(),
  contentWarnings: cwArraySchema.optional(),
  // Owners can mark their own world `archived` (hide from catalog) or
  // leave it `active`; only admins can set `featured`. Enforced at the
  // route layer, not the Zod schema.
  status: statusEnum.optional(),
  coverImageUrl: httpUrl.nullable().optional(),
  pacing: pacingEnum.nullable().optional(),
  vibeStats: vibeStatsSchema.optional(),
  joinMode: joinModeEnum.optional(),
  applicationQuestions: applicationQuestionsSchema.optional(),
}).strict();

// Theme is a free-form object passed to normalizeTheme on the way in. We
// accept "any object" at the schema level and let normalize do the actual
// sanitisation; null clears the theme back to the default.
const updateWorldBody = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z.string().max(60).optional(),
  description: z.string().max(2000).nullable().optional(),
  visibility: visibilityEnum.optional(),
  theme: z.union([z.record(z.unknown()), z.null()]).optional(),
  genre: genreEnum.optional(),
  tags: tagsArraySchema.optional(),
  contentWarnings: cwArraySchema.optional(),
  status: statusEnum.optional(),
  coverImageUrl: httpUrl.nullable().optional(),
  pacing: pacingEnum.nullable().optional(),
  vibeStats: vibeStatsSchema.optional(),
  joinMode: joinModeEnum.optional(),
  applicationQuestions: applicationQuestionsSchema.optional(),
}).strict();

/**
 * Per-axis min/max query param schema. Catalog passes `min_combat=40&
 * max_combat=80` and the route uses these to clip the catalog to
 * worlds whose tuned value sits in the closed interval. NULL stat
 * columns are EXCLUDED from filtered results, once any range is
 * applied, "unset" worlds drop out, since the user is filtering by
 * vibe and "no opinion" doesn't match.
 *
 * Zod coerce-then-range so `?min_combat=` (empty string) falls
 * through as undefined rather than NaN.
 */
const optInt0to100 = z.preprocess(
  (v) => (v === "" || v === undefined ? undefined : v),
  z.coerce.number().int().min(0).max(100).optional(),
);

const vibeRangeQueryShape = Object.fromEntries(
  WORLD_VIBE_AXES.flatMap((a) => [
    [`min_${a.key}`, optInt0to100],
    [`max_${a.key}`, optInt0to100],
  ]),
) as Record<string, typeof optInt0to100>;

const catalogQuery = z.object({
  q: z.string().max(120).optional(),
  // Repeated `tag=foo&tag=bar` semantics. Zod's preprocess can normalize
  // either a single string (`?tag=foo`) or an array (`?tag=foo&tag=bar`)
  // because Fastify's querystring parser yields one or the other.
  tag: z.preprocess(
    (v) => (typeof v === "string" ? [v] : v),
    z.array(z.string().max(32)).optional(),
  ),
  exclude: z.preprocess(
    (v) => (typeof v === "string" ? [v] : v),
    z.array(z.string().max(32)).optional(),
  ),
  genre: genreEnum.optional(),
  status: statusEnum.optional(),
  page: z.coerce.number().int().min(0).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
  ...vibeRangeQueryShape,
}).strict();

const submitApplicationBody = z.object({
  /**
   * Free-text answers, one per question in the world's current
   * question list (same length). The route validates length match
   * AGAINST the live world row so a stale form can't smuggle extra
   * answers in.
   */
  answers: z.array(z.string().max(WORLD_APP_ANSWER_MAX_LEN)).max(WORLD_APP_MAX_QUESTIONS),
}).strict();

const reviewApplicationBody = z.object({
  action: z.enum(["approve", "reject"]),
  /** Optional author note shown to the applicant on the terminal-state row. */
  reviewNote: z.string().max(WORLD_APP_REVIEW_NOTE_MAX_LEN).nullable().optional(),
}).strict();

const createPageBody = z.object({
  title: z.string().min(1).max(120),
  slug: z.string().max(60).optional(),
  parentPageId: z.string().nullable().optional(),
  bodyHtml: z.string().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
}).strict();

const updatePageBody = z.object({
  title: z.string().min(1).max(120).optional(),
  slug: z.string().max(60).optional(),
  parentPageId: z.string().nullable().optional(),
  bodyHtml: z.string().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
}).strict();

const linkWorldBody = z.object({
  worldId: z.string().min(1),
}).strict();

/* =========================================================
 *  Internal helpers
 * ========================================================= */

async function loadOwnerUsername(db: Db, userId: string): Promise<string> {
  const u = (await db.select({ username: users.username }).from(users).where(eq(users.id, userId)).limit(1))[0];
  return u?.username ?? "(deleted user)";
}

async function pageCount(db: Db, worldId: string): Promise<number> {
  const r = (await db
    .select({ n: sql<number>`count(*)` })
    .from(worldPages)
    .where(eq(worldPages.worldId, worldId)))[0];
  return r?.n ?? 0;
}

async function memberCountFor(db: Db, worldId: string): Promise<number> {
  const r = (await db
    .select({ n: sql<number>`count(*)` })
    .from(worldMembers)
    .where(eq(worldMembers.worldId, worldId)))[0];
  return r?.n ?? 0;
}

async function linkedRoomCountFor(db: Db, worldId: string): Promise<number> {
  const r = (await db
    .select({ n: sql<number>`count(*)` })
    .from(roomWorldLinks)
    .where(eq(roomWorldLinks.worldId, worldId)))[0];
  return r?.n ?? 0;
}

/**
 * Materialize the member list for a world (used in WorldDetail). Resolves
 * usernames in one extra query per row; fine at chat-room scale, switch to
 * a join if the modal ever paginates.
 */
async function memberListFor(db: Db, worldId: string): Promise<WorldMemberRef[]> {
  // Privacy filter: only members whose master profile is BOTH public
  // and not NSFW make the list. A user who flipped their profile to
  // private explicitly opted out of being publicly affiliated, so they
  // shouldn't appear in any world's member gallery either, including
  // their characters' affiliations, since exposing those publicly
  // would chain back to the master.
  //
  // Per migration 0187 each row is an identity-level membership, so
  // the same userId can appear twice (OOC + one or more characters).
  // We left-join `characters` on the (nullable) character_id; non-null
  // rows surface the character's name + avatar, null rows show the
  // master's. Soft-deleted characters (deletedAt set) drop out via
  // the join condition.
  const rows = await db
    .select({
      userId: worldMembers.userId,
      characterId: worldMembers.characterId,
      joinedAt: worldMembers.joinedAt,
      username: users.username,
      masterAvatarUrl: users.avatarUrl,
      masterAvatarZoom: users.avatarZoom,
      masterAvatarOffsetX: users.avatarOffsetX,
      masterAvatarOffsetY: users.avatarOffsetY,
      characterName: characters.name,
      characterAvatarUrl: characters.avatarUrl,
      characterAvatarZoom: characters.avatarZoom,
      characterAvatarOffsetX: characters.avatarOffsetX,
      characterAvatarOffsetY: characters.avatarOffsetY,
      characterDeletedAt: characters.deletedAt,
    })
    .from(worldMembers)
    .innerJoin(users, eq(users.id, worldMembers.userId))
    .leftJoin(characters, eq(characters.id, worldMembers.characterId))
    .where(and(
      eq(worldMembers.worldId, worldId),
      eq(users.isPublic, true),
      eq(users.isNsfw, false),
    ))
    .orderBy(asc(worldMembers.joinedAt));
  // Filter out memberships whose character row is soft-deleted (the
  // FK cascade only fires on hard delete; soft-delete leaves the
  // character row in place with deletedAt set). The membership row
  // is meaningless once the character no longer exists publicly.
  const visible = rows.filter((r) => r.characterId === null || r.characterDeletedAt === null);
  return visible.map((r) => {
    const isCharacter = r.characterId !== null;
    return {
      userId: r.userId,
      username: r.username,
      characterId: r.characterId,
      displayName: isCharacter ? (r.characterName ?? r.username) : r.username,
      // OOC ↔ character partition: NEVER fall back to the master's
      // avatar on a character row. A character with no portrait
      // renders as initials of their OWN display name, surfacing
      // the master's avatar would expose the link "this character
      // belongs to that master," which is exactly the leak the
      // identity partition is supposed to prevent.
      //
      // Crop columns on `characters` are NOT NULL with defaults
      // (1.0 zoom, 50/50 offsets), so when the leftJoin's column
      // types widen to allow null we just coalesce back to those
      // schema-level defaults, never to the master's crop, even
      // when the character row has no avatar set.
      avatarUrl: isCharacter
        ? (r.characterAvatarUrl ?? null)
        : (r.masterAvatarUrl ?? null),
      avatarCrop: isCharacter
        ? {
            zoom: r.characterAvatarZoom ?? 1,
            offsetX: r.characterAvatarOffsetX ?? 50,
            offsetY: r.characterAvatarOffsetY ?? 50,
          }
        : {
            zoom: r.masterAvatarZoom,
            offsetX: r.masterAvatarOffsetX,
            offsetY: r.masterAvatarOffsetY,
          },
      joinedAt: +r.joinedAt,
    };
  });
}

/** Parse the `theme` JSON column. Stored as TEXT to keep SQLite happy. */
function parseStoredTheme(raw: string | null): Theme | null {
  if (!raw) return null;
  try { return normalizeTheme(JSON.parse(raw)); }
  catch { return null; }
}

/**
 * Read the eight vibe-stat columns off a `worlds` row into the
 * wire-shape bag. Null values pass through (renderer treats them as
 * "unset" / muted dash).
 */
function vibeStatsFromRow(w: typeof worlds.$inferSelect): WorldVibeStats {
  return {
    combat: w.statCombat,
    magic: w.statMagic,
    technology: w.statTechnology,
    romance: w.statRomance,
    politics: w.statPolitics,
    mystery: w.statMystery,
    horror: w.statHorror,
    exploration: w.statExploration,
  };
}

/**
 * Parse the JSON-stored application question list. Empty array is
 * legal (an application with no Q&A captures just intent-to-join);
 * a corrupt JSON value falls back to empty so the rest of the world
 * payload still renders.
 */
function parseApplicationQuestions(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

/**
 * Wire-shape projection for a `world_applications` row joined with
 * applicant + reviewer usernames + avatar.
 */
type AppRow = typeof worldApplications.$inferSelect;
async function applicationToWire(
  db: Db,
  row: AppRow,
  /** The world's current question list, snapshot in the row's
   *  answers length, but the questions themselves are read live so
   *  the owner sees the prompts that the user actually saw at submit
   *  time (we don't snapshot questions today; future hardening). */
  questionsAtSubmit: string[],
): Promise<WorldApplicationEntry> {
  // Pull master + (optional) character info in two cheap point
  // lookups. Owner-facing display surfaces the IDENTITY name (the
  // character's display name when present, the master's username
  // for OOC), with the master shown for accountability.
  const applicant = (await db
    .select({ username: users.username, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, row.applicantUserId))
    .limit(1))[0];
  const character = row.characterId
    ? (await db
        .select({ name: characters.name, avatarUrl: characters.avatarUrl })
        .from(characters)
        .where(eq(characters.id, row.characterId))
        .limit(1))[0]
    : null;
  const reviewer = row.reviewedByUserId
    ? (await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, row.reviewedByUserId))
        .limit(1))[0]
    : null;
  let answers: string[] = [];
  try {
    const parsed = JSON.parse(row.answersJson);
    if (Array.isArray(parsed)) answers = parsed.filter((s): s is string => typeof s === "string");
  } catch { /* fall through to empty */ }
  const masterUsername = applicant?.username ?? "(deleted user)";
  return {
    id: row.id,
    worldId: row.worldId,
    applicantUserId: row.applicantUserId,
    applicantUsername: masterUsername,
    applicantCharacterId: row.characterId,
    applicantDisplayName: row.characterId !== null
      ? (character?.name ?? masterUsername)
      : masterUsername,
    // Same OOC ↔ character partition as the gallery: a character
    // application never falls back to the master's avatar. The
    // owner's review pane renders initials of the character's
    // display name when no portrait is set.
    applicantAvatarUrl: row.characterId !== null
      ? (character?.avatarUrl ?? null)
      : (applicant?.avatarUrl ?? null),
    questions: questionsAtSubmit,
    answers,
    status: row.status as WorldApplicationStatus,
    submittedAt: +row.submittedAt,
    reviewedAt: row.reviewedAt ? +row.reviewedAt : null,
    reviewedByUserId: row.reviewedByUserId ?? null,
    reviewedByUsername: reviewer?.username ?? null,
    reviewNote: row.reviewNote ?? null,
  };
}

async function toSummary(db: Db, w: typeof worlds.$inferSelect): Promise<WorldSummary> {
  const ownerUsername = await loadOwnerUsername(db, w.ownerUserId);
  return {
    id: w.id,
    slug: w.slug,
    ownerUserId: w.ownerUserId,
    ownerUsername,
    name: w.name,
    description: w.description,
    visibility: w.visibility as WorldVisibility,
    pageCount: await pageCount(db, w.id),
    memberCount: await memberCountFor(db, w.id),
    linkedRoomCount: await linkedRoomCountFor(db, w.id),
    theme: parseStoredTheme(w.theme),
    genre: (w.genre ?? "other") as WorldGenre,
    tags: parseTagList(w.tags),
    contentWarnings: parseTagList(w.contentWarnings),
    status: (w.status ?? "active") as WorldStatus,
    coverImageUrl: w.coverImageUrl ?? null,
    pacing: (w.pacing ?? null) as WorldPacing | null,
    vibeStats: vibeStatsFromRow(w),
    joinMode: (w.joinMode ?? "open") as WorldJoinMode,
    applicationQuestions: parseApplicationQuestions(w.applicationQuestionsJson),
    createdAt: +w.createdAt,
    updatedAt: +w.updatedAt,
  };
}

/**
 * Shared catalog-entry builder. The cards in WorldsListModal and
 * FeaturedWorldsCarousel share this shape; centralizing keeps the two
 * surfaces in lockstep when metadata fields are added.
 */
async function toCatalogEntry(db: Db, w: typeof worlds.$inferSelect): Promise<WorldCatalogEntry> {
  return {
    id: w.id,
    slug: w.slug,
    ownerUsername: await loadOwnerUsername(db, w.ownerUserId),
    name: w.name,
    description: w.description,
    pageCount: await pageCount(db, w.id),
    memberCount: await memberCountFor(db, w.id),
    linkedRoomCount: await linkedRoomCountFor(db, w.id),
    genre: (w.genre ?? "other") as WorldGenre,
    tags: parseTagList(w.tags),
    contentWarnings: parseTagList(w.contentWarnings),
    status: (w.status ?? "active") as WorldStatus,
    coverImageUrl: w.coverImageUrl ?? null,
    pacing: (w.pacing ?? null) as WorldPacing | null,
    vibeStats: vibeStatsFromRow(w),
    joinMode: (w.joinMode ?? "open") as WorldJoinMode,
    updatedAt: +w.updatedAt,
  };
}

function pageRowToWire(p: typeof worldPages.$inferSelect): WorldPage {
  return {
    id: p.id,
    worldId: p.worldId,
    parentPageId: p.parentPageId,
    slug: p.slug,
    title: p.title,
    bodyHtml: p.bodyHtml,
    sortOrder: p.sortOrder,
    arcId: p.arcId ?? null,
    createdAt: +p.createdAt,
    updatedAt: +p.updatedAt,
  };
}

function arcRowToWire(a: typeof worldArcs.$inferSelect): WorldArc {
  return {
    id: a.id,
    worldId: a.worldId,
    slug: a.slug,
    title: a.title,
    summary: a.summary,
    status: (a.status ?? "active") as WorldArcStatus,
    color: a.color ?? null,
    sortOrder: a.sortOrder,
    createdAt: +a.createdAt,
    updatedAt: +a.updatedAt,
  };
}
function sessionLightToWire(s: typeof worldSessions.$inferSelect): WorldSessionLight {
  return {
    id: s.id,
    worldId: s.worldId,
    arcId: s.arcId ?? null,
    slug: s.slug,
    title: s.title,
    summary: s.summary,
    sessionDate: s.sessionDate ? +s.sessionDate : null,
    sortOrder: s.sortOrder,
    createdAt: +s.createdAt,
    updatedAt: +s.updatedAt,
  };
}
function sessionRowToWire(s: typeof worldSessions.$inferSelect): WorldSession {
  return { ...sessionLightToWire(s), bodyHtml: s.bodyHtml };
}

/** Defensive JSON → string/string map for entity stats (mirrors codex). */
function parseEntityStats(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter((e): e is [string, string] => typeof e[1] === "string"),
      );
    }
  } catch { /* fall through */ }
  return {};
}

function entityLightToWire(e: typeof worldEntities.$inferSelect): WorldEntityLight {
  return {
    id: e.id,
    worldId: e.worldId,
    kind: e.kind,
    slug: e.slug,
    name: e.name,
    summary: e.summary,
    stats: parseEntityStats(e.statsJson),
    tags: parseTagList(e.tags),
    imageUrl: e.imageUrl ?? null,
    isPublic: !!e.isPublic,
    sortOrder: e.sortOrder,
    arcId: e.arcId ?? null,
    createdAt: +e.createdAt,
    updatedAt: +e.updatedAt,
  };
}
function entityRowToWire(e: typeof worldEntities.$inferSelect): WorldEntity {
  return { ...entityLightToWire(e), bodyHtml: e.bodyHtml };
}
function entityKindRowToWire(k: typeof worldEntityKinds.$inferSelect): WorldEntityKind {
  return {
    key: k.key,
    label: k.label,
    description: k.description,
    icon: k.icon ?? null,
    color: k.color ?? null,
    sortOrder: k.sortOrder,
  };
}

/**
 * Resolve a world by id-or-slug, plus an authenticated viewer's view rights.
 * The slug-shaped routes use this to accept either form for friendly URLs.
 *
 * Visibility check: private worlds resolve only for the owner / admin.
 * public + open resolve for anyone.
 */
async function resolveWorld(
  db: Db,
  idOrSlug: string,
  viewerUserId: string | null,
  viewerRole: Role | null,
): Promise<typeof worlds.$inferSelect | null> {
  // Try id first (cheap; slugs are friendlier but ids are uuid-shaped).
  let w = (await db.select().from(worlds).where(eq(worlds.id, idOrSlug)).limit(1))[0];
  if (!w) {
    // Slug lookup is per-owner-unique, so a bare slug needs disambiguation.
    // For viewer convenience: if the viewer is logged in, prefer their own
    // world with that slug; otherwise pick the first public/open match.
    if (viewerUserId) {
      const own = (await db
        .select()
        .from(worlds)
        .where(and(eq(worlds.ownerUserId, viewerUserId), sql`lower(${worlds.slug}) = ${idOrSlug.toLowerCase()}`))
        .limit(1))[0];
      if (own) w = own;
    }
    if (!w) {
      const pub = (await db
        .select()
        .from(worlds)
        .where(and(
          sql`lower(${worlds.slug}) = ${idOrSlug.toLowerCase()}`,
          or(eq(worlds.visibility, "public"), eq(worlds.visibility, "open")),
        ))
        .limit(1))[0];
      if (pub) w = pub;
    }
  }
  if (!w) return null;
  const viewable = w.visibility !== "private"
    || (viewerUserId && w.ownerUserId === viewerUserId)
    || viewerRole === "admin";
  if (!viewable) return null;
  return w;
}

/**
 * Whether a given viewer can edit a world's metadata + pages. Owner
 * and admins always can; otherwise the viewer must appear in the
 * world_collaborators list. The check is centralized here so every
 * mutation endpoint uses the same rule.
 *
 * `null` viewer (anon) is never an editor.
 */
async function canEditWorld(
  db: Db,
  worldRow: typeof worlds.$inferSelect,
  viewerUserId: string | null,
  viewerRole: Role | null,
): Promise<boolean> {
  if (!viewerUserId) return false;
  if (worldRow.ownerUserId === viewerUserId) return true;
  // Admin override on someone else's world. `edit_others_world` is the
  // matrix-grantable key (admin-default per the seed). The role is
  // passed through so `hasPermission` can resolve role-level grants.
  if (viewerRole) {
    const admin = await hasPermission({ id: viewerUserId, role: viewerRole }, "edit_others_world", db);
    if (admin) return true;
  }
  const row = (await db
    .select({ userId: worldCollaborators.userId })
    .from(worldCollaborators)
    .where(and(
      eq(worldCollaborators.worldId, worldRow.id),
      eq(worldCollaborators.userId, viewerUserId),
    ))
    .limit(1))[0];
  return !!row;
}

/** Load the list of collaborator user-refs for a world, with usernames. */
async function collaboratorListFor(
  db: Db,
  worldId: string,
): Promise<Array<{ userId: string; username: string; addedAt: number | null }>> {
  const rows = await db
    .select({
      userId: worldCollaborators.userId,
      username: users.username,
      addedAt: worldCollaborators.addedAt,
    })
    .from(worldCollaborators)
    .innerJoin(users, eq(users.id, worldCollaborators.userId))
    .where(eq(worldCollaborators.worldId, worldId))
    .orderBy(asc(worldCollaborators.addedAt));
  return rows.map((r) => ({
    userId: r.userId,
    username: r.username,
    addedAt: r.addedAt ? +r.addedAt : null,
  }));
}

/** Walk the parent chain to compute a candidate page's depth (root = 0). */
async function depthOf(db: Db, parentPageId: string | null): Promise<number> {
  if (!parentPageId) return 0;
  let depth = 1;
  let current = parentPageId;
  for (let i = 0; i < WORLD_PAGE_DEPTH_CAP + 2; i++) {
    const p = (await db.select().from(worldPages).where(eq(worldPages.id, current)).limit(1))[0];
    if (!p?.parentPageId) return depth;
    current = p.parentPageId;
    depth++;
  }
  // Cycle detection bail-out; should never happen with FK cascade integrity.
  return WORLD_PAGE_DEPTH_CAP + 1;
}

async function callerCanModerateRoom(db: Db, userId: string, role: Role, roomId: string): Promise<boolean> {
  // Site-wide override (matrix-grantable, admin-default).
  if (await hasPermission({ id: userId, role }, "edit_any_room_metadata", db)) return true;
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) return false;
  if (room.ownerId === userId) return true;
  const m = (await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1))[0];
  return m?.role === "owner" || m?.role === "mod";
}

/**
 * Membership changes alter the userlist (sort/grouping by primary world), so
 * any room the user is currently in needs a fresh presence broadcast. We
 * scan the user's live sockets for the rooms they're in - cheap at our
 * scale, and avoids piping a "current room id" into every API call.
 */
async function rebroadcastUserOccupancy(io: Io, db: Db, userId: string): Promise<void> {
  const sockets = await io.fetchSockets();
  const roomsToRefresh = new Set<string>();
  for (const s of sockets) {
    if ((s.data as { userId?: string }).userId !== userId) continue;
    for (const r of s.rooms) {
      if (r.startsWith("room:")) roomsToRefresh.add(r.slice(5));
    }
  }
  for (const rid of roomsToRefresh) {
    await broadcastPresence(io, db, rid).catch(() => {});
  }
}

/* =========================================================
 *  Route registration
 * ========================================================= */

export async function registerWorldRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /* ---------- World list (caller's own) ---------- */
  app.get("/me/worlds", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const rows = await db
      .select()
      .from(worlds)
      .where(eq(worlds.ownerUserId, me.id))
      .orderBy(asc(worlds.name));
    const summaries = await Promise.all(rows.map((w) => toSummary(db, w)));
    return { worlds: summaries };
  });

  /* ---------- Featured worlds (public; for the splash carousel) ----------
   *
   * Returns up to `limit` (default 10, capped at 10) randomly-chosen open
   * worlds. Public so the splash AuthGate can fetch it pre-login. Admin
   * toggle `featuredWorldsEnabled` controls whether the splash actually
   * displays the result; this endpoint always serves so callers can preview.
   *
   * The randomness is per-request (`ORDER BY random()`), so two visitors
   * landing simultaneously generally see different rotations - no static
   * cache to bust on world edits, and no popularity bias either.
   */
  app.get<{ Querystring: { limit?: string } }>("/worlds/featured", async (req) => {
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit ?? "10", 10) || 10));
    // Featured rotation: prefer admin-curated `status="featured"`, fall
    // back to the random sample of open worlds when there aren't enough
    // featured rows to fill the strip. Curated worlds always lead so
    // an admin's deliberate spotlight isn't drowned by the random tail.
    const featured = await db
      .select()
      .from(worlds)
      .where(and(eq(worlds.visibility, "open"), eq(worlds.status, "featured")))
      .orderBy(sql`random()`)
      .limit(limit);
    const need = limit - featured.length;
    const filler = need > 0
      ? await db
          .select()
          .from(worlds)
          .where(and(eq(worlds.visibility, "open"), ne(worlds.status, "featured"), ne(worlds.status, "archived")))
          .orderBy(sql`random()`)
          .limit(need)
      : [];
    const entries = await Promise.all([...featured, ...filler].map((w) => toCatalogEntry(db, w)));
    return { entries };
  });

  /* ---------- World catalog (open visibility, filterable) ---------- */
  app.get<{ Querystring: Record<string, string | string[]> }>("/worlds/catalog", async (req) => {
    const parsed = catalogQuery.safeParse(req.query);
    const q = parsed.success ? parsed.data : ({} as z.infer<typeof catalogQuery>);
    const pageSize = q.pageSize ?? 24;
    const page = q.page ?? 0;
    // Build the WHERE incrementally. The base set is "open + not
    // archived" (archived worlds stay reachable via direct link but
    // don't appear in catalog browse).
    const conds: ReturnType<typeof eq>[] = [
      eq(worlds.visibility, "open"),
      ne(worlds.status, "archived"),
    ];
    if (q.genre) conds.push(eq(worlds.genre, q.genre));
    if (q.status) conds.push(eq(worlds.status, q.status));
    // Text search across name + description + tags. SQLite LIKE is
    // case-insensitive for ASCII; the patterns are escaped to keep `%`
    // and `_` literal so a search for "20% off" doesn't go wild.
    if (q.q && q.q.trim()) {
      const like = `%${q.q.trim().replace(/[%_]/g, (c) => `\\${c}`).toLowerCase()}%`;
      conds.push(or(
        sql`lower(${worlds.name}) LIKE ${like} ESCAPE '\\'`,
        sql`lower(${worlds.description}) LIKE ${like} ESCAPE '\\'`,
        sql`lower(${worlds.tags}) LIKE ${like} ESCAPE '\\'`,
      )!);
    }
    // Tags: AND together (a world must carry every requested tag). We
    // use substring matches since tags are stored as comma-separated;
    // wrap the column in commas so a search for `,courtly,` doesn't
    // accidentally match `low-courtly` or similar substring overlaps.
    if (q.tag && q.tag.length > 0) {
      for (const tag of q.tag) {
        const needle = `%,${tag.toLowerCase()},%`;
        conds.push(sql`(',' || lower(${worlds.tags}) || ',') LIKE ${needle}`);
      }
    }
    // Exclude any world that lists ANY of these content warnings. Same
    // bracketed-substring approach as tags.
    if (q.exclude && q.exclude.length > 0) {
      for (const cw of q.exclude) {
        const needle = `%,${cw.toLowerCase()},%`;
        conds.push(sql`(',' || lower(${worlds.contentWarnings}) || ',') NOT LIKE ${needle}`);
      }
    }
    // Vibe-stat range filters. For each axis the user constrained, the
    // world's tuned value must sit inside the [min, max] closed
    // interval, AND the column must be non-null. "Unset" worlds drop
    // out of any filtered view because "no opinion" doesn't satisfy a
    // specific user constraint; with NO filter applied (the default),
    // unset worlds remain visible because no `conds.push` runs.
    // Each axis maps to its DB column via a small lookup table.
    // Typed as `SqliteColumnLike` (a structural alias for "anything
    // SQL template literals will accept as a column") because the
    // eight columns have distinct drizzle name-literal types and
    // can't all fit one `typeof worlds.statCombat` slot.
    const STAT_COLS = {
      combat: worlds.statCombat,
      magic: worlds.statMagic,
      technology: worlds.statTechnology,
      romance: worlds.statRomance,
      politics: worlds.statPolitics,
      mystery: worlds.statMystery,
      horror: worlds.statHorror,
      exploration: worlds.statExploration,
    } as const;
    for (const axis of WORLD_VIBE_AXES) {
      const min = (q as Record<string, unknown>)[`min_${axis.key}`] as number | undefined;
      const max = (q as Record<string, unknown>)[`max_${axis.key}`] as number | undefined;
      if (min === undefined && max === undefined) continue;
      const col = STAT_COLS[axis.key];
      conds.push(sql`${col} IS NOT NULL`);
      if (min !== undefined) conds.push(sql`${col} >= ${min}`);
      if (max !== undefined) conds.push(sql`${col} <= ${max}`);
    }
    const whereExpr = and(...conds);
    const totalRow = (await db
      .select({ n: sql<number>`count(*)` })
      .from(worlds)
      .where(whereExpr))[0];
    const total = totalRow?.n ?? 0;
    const rows = await db
      .select()
      .from(worlds)
      .where(whereExpr)
      // Featured first so admin curation reads top-of-page; then by
      // recency so freshly-updated worlds bubble up.
      .orderBy(
        sql`CASE ${worlds.status} WHEN 'featured' THEN 0 ELSE 1 END`,
        desc(worlds.updatedAt),
      )
      .limit(pageSize)
      .offset(page * pageSize);
    const entries = await Promise.all(rows.map((w) => toCatalogEntry(db, w)));
    const payload: WorldCatalogPage = {
      entries,
      page,
      pageSize,
      total,
      hasMore: (page + 1) * pageSize < total,
    };
    return payload;
  });

  /* ---------- Create world ---------- */
  app.post<{ Body: unknown }>("/worlds", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let body;
    try { body = createWorldBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const slug = (body.slug ?? deriveSlug(body.name)).toLowerCase();
    if (!SLUG_RX.test(slug)) {
      reply.code(400);
      return { error: "slug must be 1-60 lowercase letters, numbers, hyphens" };
    }

    // Per-owner uniqueness.
    const dup = (await db
      .select()
      .from(worlds)
      .where(and(eq(worlds.ownerUserId, me.id), sql`lower(${worlds.slug}) = ${slug}`))
      .limit(1))[0];
    if (dup) { reply.code(409); return { error: "you already have a world with that slug" }; }

    // `featured` is admin-curated only; silently downgrade to `active`
    // when an owner attempts to self-promote on create. We don't error
    // here because the rest of the body is valid, the surprise of a
    // 400 over a single forbidden enum value would be hostile when the
    // owner's intent is clearly "publish this world."
    let initialStatus: WorldStatus = body.status ?? "active";
    if (initialStatus === "featured" && !(await hasPermission(me, "feature_worlds", db))) {
      initialStatus = "active";
    }

    const id = nanoid();
    const vs = body.vibeStats;
    await db.insert(worlds).values({
      id,
      ownerUserId: me.id,
      slug,
      name: body.name.trim(),
      description: body.description?.trim() || null,
      visibility: body.visibility ?? "private",
      genre: body.genre ?? "other",
      tags: body.tags ? serializeTagList(body.tags) : "",
      contentWarnings: body.contentWarnings ? serializeTagList(body.contentWarnings) : "",
      status: initialStatus,
      coverImageUrl: body.coverImageUrl ?? null,
      pacing: body.pacing ?? null,
      statCombat: vs?.combat ?? null,
      statMagic: vs?.magic ?? null,
      statTechnology: vs?.technology ?? null,
      statRomance: vs?.romance ?? null,
      statPolitics: vs?.politics ?? null,
      statMystery: vs?.mystery ?? null,
      statHorror: vs?.horror ?? null,
      statExploration: vs?.exploration ?? null,
      joinMode: body.joinMode ?? "open",
      applicationQuestionsJson: JSON.stringify(body.applicationQuestions ?? []),
    });
    const created = (await db.select().from(worlds).where(eq(worlds.id, id)).limit(1))[0]!;
    reply.code(201);
    return await toSummary(db, created);
  });

  /* ---------- Read world (summary + full pages list + members) ---------- */
  app.get<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
    if (!w) {
      // Anonymous deep-link to a private world: surface a "private" stub so
      // the splash can render a "this world is private, sign in to view"
      // hint, mirroring the profile flow. We deliberately return HTTP 200
      // so a fetch() doesn't treat it as an error; the discriminating shape
      // is the `private: true` field. Truly missing slugs still 404.
      if (!me) {
        const raw = (await db
          .select()
          .from(worlds)
          .where(or(
            eq(worlds.id, req.params.idOrSlug),
            sql`lower(${worlds.slug}) = ${req.params.idOrSlug.toLowerCase()}`,
          ))
          .limit(1))[0];
        if (raw && raw.visibility === "private") {
          return {
            private: true as const,
            name: raw.name,
            slug: raw.slug,
            requiresAuth: true,
          };
        }
      }
      reply.code(404);
      return { error: "not found" };
    }
    const pages = await db
      .select()
      .from(worldPages)
      .where(eq(worldPages.worldId, w.id))
      .orderBy(asc(worldPages.sortOrder), asc(worldPages.createdAt));
    const members = await memberListFor(db, w.id);
    // viewerIsMember asks "is the viewer's CURRENT identity a member
    // of this world?" Other identities of the same master may also be
    // members; this flag only reflects the face the viewer is wearing
    // right now (which is what drives the catalog button + the world
    // page's Join/Leave affordance).
    const viewerCharId: string | null = me?.activeCharacterId ?? null;
    const viewerMember = me
      ? members.find((m) => m.userId === me.id && m.characterId === viewerCharId) ?? null
      : null;
    // Collaborator surface. Always loaded so the client can show the
    // wiki-editor's owner-only "Collaborators" panel without a second
    // round trip. Non-owners get the same list, handy for "who else
    // can edit this" transparency on a shared wiki, but the client
    // gates the add/remove controls on viewerIsOwner.
    const collaborators = await collaboratorListFor(db, w.id);
    const viewerIsOwner = !!me && w.ownerUserId === me.id;
    const viewerCanEdit = await canEditWorld(db, w, me?.id ?? null, me?.role ?? null);
    // Pull the viewer's most recent application against this world,
    // if any, so the client can drive the Apply/Pending/Rejected
    // button state from a single fetch. Owners look at the editor's
    // full Applications pane instead, so we skip this work for them
    // (the field stays null on the owner's view).
    let viewerApplication: WorldApplicationEntry | null = null;
    if (me && !viewerIsOwner) {
      // Per-identity lookup: an applicant's most recent application
      // for the IDENTITY they're currently voicing. Other identities
      // of the same master have their own application histories
      // (each can apply once at a time per world).
      const appRow = (await db
        .select()
        .from(worldApplications)
        .where(and(
          eq(worldApplications.worldId, w.id),
          eq(worldApplications.applicantUserId, me.id),
          viewerCharId === null
            ? sql`${worldApplications.characterId} IS NULL`
            : eq(worldApplications.characterId, viewerCharId),
        ))
        .orderBy(desc(worldApplications.submittedAt))
        .limit(1))[0];
      if (appRow) {
        viewerApplication = await applicationToWire(
          db,
          appRow,
          parseApplicationQuestions(w.applicationQuestionsJson),
        );
      }
    }
    // Typed entries (light rows) + custom kind registry for the knowledge-base
    // dashboard. Non-editors see only public entries (mirrors the codex gate).
    const entityRows = await db
      .select()
      .from(worldEntities)
      .where(eq(worldEntities.worldId, w.id))
      .orderBy(asc(worldEntities.kind), asc(worldEntities.sortOrder), asc(worldEntities.createdAt));
    const visibleEntities = viewerCanEdit ? entityRows : entityRows.filter((r) => !!r.isPublic);
    const entityKindRows = await db
      .select()
      .from(worldEntityKinds)
      .where(eq(worldEntityKinds.worldId, w.id))
      .orderBy(asc(worldEntityKinds.sortOrder), asc(worldEntityKinds.key));
    const arcRows = await db
      .select()
      .from(worldArcs)
      .where(eq(worldArcs.worldId, w.id))
      .orderBy(asc(worldArcs.sortOrder), asc(worldArcs.createdAt));
    const sessionRows = await db
      .select()
      .from(worldSessions)
      .where(eq(worldSessions.worldId, w.id))
      .orderBy(desc(worldSessions.sessionDate), asc(worldSessions.sortOrder), asc(worldSessions.createdAt));
    const detail: WorldDetail = {
      world: await toSummary(db, w),
      pages: pages.map(pageRowToWire),
      members,
      viewerIsMember: viewerMember !== null,
      viewerIsOwner,
      viewerCanEdit,
      collaborators,
      entities: visibleEntities.map(entityLightToWire),
      entityKinds: entityKindRows.map(entityKindRowToWire),
      arcs: arcRows.map(arcRowToWire),
      sessions: sessionRows.map(sessionLightToWire),
      viewerApplication,
    };
    return detail;
  });

  /* ---------- Collaborators (list / add / remove) ----------
   * Adding and removing collaborators is owner-only (or admin).
   * Collaborators themselves cannot manage the collaborator list,
   * matching the migration 0174 design note. */
  app.post<{ Params: { idOrSlug: string }; Body: unknown }>(
    "/worlds/:idOrSlug/collaborators",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      // Owner OR admin only, collaborators can't promote others.
      if (w.ownerUserId !== me.id && !(await hasPermission(me, "edit_others_world", db))) {
        reply.code(403); return { error: "owner only" };
      }
      const body = z.object({ username: z.string().min(1).max(80) }).safeParse(req.body);
      if (!body.success) { reply.code(400); return { error: "invalid body" }; }
      const username = body.data.username.trim();
      const user = (await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(sql`lower(${users.username}) = lower(${username})`)
        .limit(1))[0];
      if (!user) { reply.code(404); return { error: "no such user" }; }
      if (user.id === w.ownerUserId) {
        reply.code(409); return { error: "owner is already an editor" };
      }
      await db
        .insert(worldCollaborators)
        .values({
          worldId: w.id,
          userId: user.id,
          addedByUserId: me.id,
        })
        .onConflictDoNothing({
          target: [worldCollaborators.worldId, worldCollaborators.userId],
        });
      return { ok: true, collaborators: await collaboratorListFor(db, w.id) };
    },
  );

  app.delete<{ Params: { idOrSlug: string; userId: string } }>(
    "/worlds/:idOrSlug/collaborators/:userId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      // Two valid removers: the world owner / admin, or the
      // collaborator removing themselves ("leave"). Anyone else is 403.
      const selfLeave = req.params.userId === me.id;
      const isOwnerOrAdmin = w.ownerUserId === me.id || (await hasPermission(me, "edit_others_world", db));
      if (!selfLeave && !isOwnerOrAdmin) {
        reply.code(403); return { error: "owner only" };
      }
      await db
        .delete(worldCollaborators)
        .where(and(
          eq(worldCollaborators.worldId, w.id),
          eq(worldCollaborators.userId, req.params.userId),
        ));
      return { ok: true, collaborators: await collaboratorListFor(db, w.id) };
    },
  );

  /* ---------- Update world ---------- */
  app.patch<{ Params: { idOrSlug: string }; Body: unknown }>("/worlds/:idOrSlug", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }

    let body;
    try { body = updateWorldBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const update: Partial<typeof worlds.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name.trim();
    if (body.description !== undefined) update.description = body.description?.trim() || null;
    if (body.visibility !== undefined) update.visibility = body.visibility;
    if (body.theme !== undefined) {
      // null clears it; any object is normalized to a Theme shape (drops
      // unknown keys, falls back to defaults for missing ones).
      update.theme = body.theme === null
        ? null
        : JSON.stringify(normalizeTheme(body.theme));
    }
    if (body.genre !== undefined) update.genre = body.genre;
    if (body.tags !== undefined) update.tags = serializeTagList(body.tags);
    if (body.contentWarnings !== undefined) {
      update.contentWarnings = serializeTagList(body.contentWarnings);
    }
    if (body.status !== undefined) {
      // Non-admin owners can move between `active` ↔ `archived`. Only
      // admins can set `featured`; an owner attempting to self-promote
      // is silently downgraded to `active` for the same UX reason as
      // the create path (no hostile 400 over one field).
      if (body.status === "featured" && !(await hasPermission(me, "feature_worlds", db))) {
        update.status = "active";
      } else {
        update.status = body.status;
      }
    }
    if (body.coverImageUrl !== undefined) {
      update.coverImageUrl = body.coverImageUrl ?? null;
    }
    if (body.pacing !== undefined) update.pacing = body.pacing ?? null;
    if (body.vibeStats !== undefined) {
      // Only the axes the body actually carries get updated. An axis
      // sent as `null` clears it; an absent axis is left alone. This
      // lets the editor's per-slider "reset" button clear ONE axis
      // without touching the others.
      const vs = body.vibeStats;
      if ("combat" in vs) update.statCombat = vs.combat ?? null;
      if ("magic" in vs) update.statMagic = vs.magic ?? null;
      if ("technology" in vs) update.statTechnology = vs.technology ?? null;
      if ("romance" in vs) update.statRomance = vs.romance ?? null;
      if ("politics" in vs) update.statPolitics = vs.politics ?? null;
      if ("mystery" in vs) update.statMystery = vs.mystery ?? null;
      if ("horror" in vs) update.statHorror = vs.horror ?? null;
      if ("exploration" in vs) update.statExploration = vs.exploration ?? null;
    }
    if (body.joinMode !== undefined) update.joinMode = body.joinMode;
    if (body.applicationQuestions !== undefined) {
      update.applicationQuestionsJson = JSON.stringify(body.applicationQuestions);
    }
    if (body.slug !== undefined) {
      const slug = body.slug.toLowerCase();
      if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "slug must be 1-60 lowercase letters, numbers, hyphens" }; }
      if (slug !== w.slug.toLowerCase()) {
        const dup = (await db
          .select()
          .from(worlds)
          .where(and(eq(worlds.ownerUserId, w.ownerUserId), sql`lower(${worlds.slug}) = ${slug}`, ne(worlds.id, w.id)))
          .limit(1))[0];
        if (dup) { reply.code(409); return { error: "you already have a world with that slug" }; }
        update.slug = slug;
      }
    }
    await db.update(worlds).set(update).where(eq(worlds.id, w.id));
    return { ok: true };
  });

  /* ---------- Delete world (cascade) ---------- */
  app.delete<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (w.ownerUserId !== me.id && !(await hasPermission(me, "delete_others_world", db))) {
      reply.code(403); return { error: "not yours" };
    }
    // Find all rooms currently linked to this world so we can re-broadcast
    // their state after the link cascade-deletes (so the chat banner
    // disappears in real time).
    const linkedRooms = await db
      .select({ roomId: roomWorldLinks.roomId })
      .from(roomWorldLinks)
      .where(eq(roomWorldLinks.worldId, w.id));
    await db.delete(worlds).where(eq(worlds.id, w.id));
    for (const r of linkedRooms) {
      await broadcastRoomState(io, db, r.roomId).catch(() => {});
    }
    return { ok: true };
  });

  /* ---------- Create page ---------- */
  app.post<{ Params: { idOrSlug: string }; Body: unknown }>(
    "/worlds/:idOrSlug/pages",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }

      let body;
      try { body = createPageBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      // parent existence + same-world check
      if (body.parentPageId) {
        const parent = (await db.select().from(worldPages).where(eq(worldPages.id, body.parentPageId)).limit(1))[0];
        if (!parent || parent.worldId !== w.id) {
          reply.code(400);
          return { error: "parent page does not belong to this world" };
        }
      }

      // Depth cap. depth(parent) + 1 <= WORLD_PAGE_DEPTH_CAP - 1 means
      // child's depth <= cap-1, i.e. cap means "up to 10 levels (0..9)".
      const newDepth = await depthOf(db, body.parentPageId ?? null);
      if (newDepth > WORLD_PAGE_DEPTH_CAP - 1) {
        reply.code(400);
        return { error: `Page tree is capped at ${WORLD_PAGE_DEPTH_CAP} levels.` };
      }

      const slug = (body.slug ?? deriveSlug(body.title)).toLowerCase();
      if (!SLUG_RX.test(slug)) {
        reply.code(400);
        return { error: "slug must be 1-60 lowercase letters, numbers, hyphens" };
      }

      // Body cap follows the bio cap (admin-tunable).
      const { maxBioLength } = await getSettings(db);
      if ((body.bodyHtml ?? "").length > maxBioLength) {
        reply.code(413);
        return { error: `Page body capped at ${maxBioLength} chars.` };
      }

      const id = nanoid();
      await db.insert(worldPages).values({
        id,
        worldId: w.id,
        parentPageId: body.parentPageId ?? null,
        slug,
        title: body.title.trim(),
        bodyHtml: sanitizeBio(body.bodyHtml ?? ""),
        sortOrder: body.sortOrder ?? 0,
      });
      // Touch world.updatedAt so catalog rankings reflect activity.
      await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
      const row = (await db.select().from(worldPages).where(eq(worldPages.id, id)).limit(1))[0]!;
      reply.code(201);
      return pageRowToWire(row);
    },
  );

  /* ---------- Update page ---------- */
  app.patch<{ Params: { idOrSlug: string; pageId: string }; Body: unknown }>(
    "/worlds/:idOrSlug/pages/:pageId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }

      let body;
      try { body = updatePageBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const existing = (await db
        .select()
        .from(worldPages)
        .where(and(eq(worldPages.id, req.params.pageId), eq(worldPages.worldId, w.id)))
        .limit(1))[0];
      if (!existing) { reply.code(404); return { error: "not found" }; }

      // Reparent? Validate target parent is in this world AND isn't
      // a descendant (no cycles), and that the new depth fits the cap.
      if (body.parentPageId !== undefined && body.parentPageId !== existing.parentPageId) {
        if (body.parentPageId) {
          if (body.parentPageId === existing.id) {
            reply.code(400); return { error: "page can't be its own parent" };
          }
          // Walk new parent up to ensure existing.id isn't an ancestor.
          let cursor: string | null = body.parentPageId;
          for (let i = 0; i < 64; i++) {
            if (!cursor) break;
            const currentId: string = cursor;
            const parentRow = (await db
              .select()
              .from(worldPages)
              .where(eq(worldPages.id, currentId))
              .limit(1))[0];
            if (!parentRow || parentRow.worldId !== w.id) {
              reply.code(400); return { error: "parent page does not belong to this world" };
            }
            if (parentRow.id === existing.id) {
              reply.code(400); return { error: "moving here would create a cycle" };
            }
            cursor = parentRow.parentPageId;
          }
          const newDepth = await depthOf(db, body.parentPageId);
          if (newDepth > WORLD_PAGE_DEPTH_CAP - 1) {
            reply.code(400);
            return { error: `Page tree is capped at ${WORLD_PAGE_DEPTH_CAP} levels.` };
          }
        }
      }

      if (body.bodyHtml !== undefined) {
        const { maxBioLength } = await getSettings(db);
        if (body.bodyHtml.length > maxBioLength) {
          reply.code(413);
          return { error: `Page body capped at ${maxBioLength} chars.` };
        }
      }

      const update: Partial<typeof worldPages.$inferInsert> = { updatedAt: new Date() };
      if (body.title !== undefined) update.title = body.title.trim();
      if (body.bodyHtml !== undefined) update.bodyHtml = sanitizeBio(body.bodyHtml);
      if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
      if (body.parentPageId !== undefined) update.parentPageId = body.parentPageId;
      if (body.slug !== undefined) {
        const slug = body.slug.toLowerCase();
        if (!SLUG_RX.test(slug)) {
          reply.code(400); return { error: "slug must be 1-60 lowercase letters, numbers, hyphens" };
        }
        update.slug = slug;
      }
      await db.update(worldPages).set(update).where(eq(worldPages.id, existing.id));
      await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
      return { ok: true };
    },
  );

  /* ---------- Delete page (cascades to children) ---------- */
  app.delete<{ Params: { idOrSlug: string; pageId: string } }>(
    "/worlds/:idOrSlug/pages/:pageId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
      const existing = (await db
        .select()
        .from(worldPages)
        .where(and(eq(worldPages.id, req.params.pageId), eq(worldPages.worldId, w.id)))
        .limit(1))[0];
      if (!existing) { reply.code(404); return { error: "not found" }; }
      await db.delete(worldPages).where(eq(worldPages.id, existing.id));
      await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
      return { ok: true };
    },
  );

  /* ===================================================== *
   *  Knowledge base — typed entries (Locations / NPCs /
   *  Items / Factions / custom kinds). Mirrors the
   *  Scriptorium codex. "Lore" stays the worldPages tree.
   * ===================================================== */

  const entityStatsSchema = z
    .record(z.string().max(200))
    .refine((r) => Object.keys(r).length <= 50, { message: "too many stats" });
  const entityImageUrl = z
    .string().trim().max(2000)
    .refine((s) => /^https?:\/\//i.test(s), { message: "imageUrl must be http(s)" });
  const entityTag = z
    .string().min(1).max(32)
    .transform((s) => s.trim().toLowerCase())
    .refine((s) => /^[a-z0-9-]+$/.test(s), { message: "tags must be lowercase letters/digits/hyphens" });
  const entityTags = z.array(entityTag).max(20).transform((a) => parseTagList(a.join(",")));

  const createEntityBody = z.object({
    kind: z.string().min(1).max(40),
    name: z.string().min(1).max(WORLD_ENTITY_NAME_MAX),
    slug: z.string().optional(),
    summary: z.string().max(WORLD_ENTITY_SUMMARY_MAX).optional(),
    bodyHtml: z.string().max(WORLD_ENTITY_BODY_MAX * 4).optional(),
    stats: entityStatsSchema.optional(),
    tags: entityTags.optional(),
    imageUrl: entityImageUrl.nullable().optional(),
    isPublic: z.boolean().optional(),
    arcId: z.string().nullable().optional(),
  }).strict();
  const updateEntityBody = z.object({
    name: z.string().min(1).max(WORLD_ENTITY_NAME_MAX).optional(),
    slug: z.string().optional(),
    summary: z.string().max(WORLD_ENTITY_SUMMARY_MAX).optional(),
    bodyHtml: z.string().max(WORLD_ENTITY_BODY_MAX * 4).optional(),
    stats: entityStatsSchema.optional(),
    tags: entityTags.optional(),
    imageUrl: entityImageUrl.nullable().optional(),
    isPublic: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    arcId: z.string().nullable().optional(),
  }).strict();

  /** Reserved kind keys a custom kind can't reuse (built-ins + synthetic lore). */
  const RESERVED_KIND_KEYS = new Set<string>([...BUILTIN_ENTITY_KIND_KEYS, "lore"]);
  /** Valid entity kind = a built-in (npc/location/faction/item) OR a registered
   *  custom key on this world. */
  async function isValidEntityKind(worldId: string, kind: string): Promise<boolean> {
    if ((BUILTIN_ENTITY_KIND_KEYS as readonly string[]).includes(kind)) return true;
    const row = (await db
      .select({ key: worldEntityKinds.key })
      .from(worldEntityKinds)
      .where(and(eq(worldEntityKinds.worldId, worldId), sql`lower(${worldEntityKinds.key}) = ${kind.toLowerCase()}`))
      .limit(1))[0];
    return !!row;
  }

  /** True iff the arc exists in this world (soft-FK validation for arcId). */
  async function arcInWorld(worldId: string, arcId: string): Promise<boolean> {
    const row = (await db.select({ id: worldArcs.id }).from(worldArcs)
      .where(and(eq(worldArcs.id, arcId), eq(worldArcs.worldId, worldId))).limit(1))[0];
    return !!row;
  }

  app.get<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug/entities", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const canEdit = await canEditWorld(db, w, me?.id ?? null, me?.role ?? null);
    const rows = await db.select().from(worldEntities).where(eq(worldEntities.worldId, w.id))
      .orderBy(asc(worldEntities.kind), asc(worldEntities.sortOrder), asc(worldEntities.createdAt));
    const visible = canEdit ? rows : rows.filter((r) => !!r.isPublic);
    return { entities: visible.map(entityLightToWire) };
  });

  app.get<{ Params: { idOrSlug: string; eid: string } }>("/worlds/:idOrSlug/entities/:eid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const canEdit = await canEditWorld(db, w, me?.id ?? null, me?.role ?? null);
    const e = (await db.select().from(worldEntities)
      .where(and(eq(worldEntities.id, req.params.eid), eq(worldEntities.worldId, w.id))).limit(1))[0];
    if (!e || (!canEdit && !e.isPublic)) { reply.code(404); return { error: "not found" }; }
    return { entity: entityRowToWire(e) };
  });

  app.post<{ Params: { idOrSlug: string }; Body: unknown }>("/worlds/:idOrSlug/entities", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    let body; try { body = createEntityBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    if (!(await isValidEntityKind(w.id, body.kind))) { reply.code(400); return { error: "unknown kind" }; }
    if (body.arcId && !(await arcInWorld(w.id, body.arcId))) { reply.code(400); return { error: "unknown arc" }; }
    const countRow = (await db.select({ n: sql<number>`count(*)` }).from(worldEntities)
      .where(and(eq(worldEntities.worldId, w.id), eq(worldEntities.kind, body.kind))))[0];
    if ((countRow?.n ?? 0) >= WORLD_ENTITY_PER_KIND_CAP) { reply.code(409); return { error: "too many entries of this kind" }; }
    const slug = (body.slug?.trim() || deriveSlug(body.name)).toLowerCase();
    if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "invalid slug" }; }
    const dup = (await db.select({ id: worldEntities.id }).from(worldEntities)
      .where(and(eq(worldEntities.worldId, w.id), eq(worldEntities.kind, body.kind), sql`lower(${worldEntities.slug}) = ${slug}`)).limit(1))[0];
    if (dup) { reply.code(409); return { error: "an entry with that slug already exists" }; }
    const maxRow = (await db.select({ m: sql<number>`COALESCE(MAX(${worldEntities.sortOrder}), -1)` }).from(worldEntities)
      .where(and(eq(worldEntities.worldId, w.id), eq(worldEntities.kind, body.kind))))[0];
    const now = new Date();
    const id = nanoid();
    await db.insert(worldEntities).values({
      id, worldId: w.id, kind: body.kind, slug, name: body.name,
      summary: body.summary ?? "", bodyHtml: sanitizeBio(body.bodyHtml ?? ""),
      statsJson: JSON.stringify(body.stats ?? {}), tags: serializeTagList(body.tags ?? []),
      imageUrl: body.imageUrl ?? null, isPublic: body.isPublic ? 1 : 0,
      sortOrder: Number(maxRow?.m ?? -1) + 1,
      arcId: body.arcId ?? null,
      createdAt: now, updatedAt: now,
    });
    await db.update(worlds).set({ updatedAt: now }).where(eq(worlds.id, w.id));
    const created = (await db.select().from(worldEntities).where(eq(worldEntities.id, id)).limit(1))[0]!;
    return { entity: entityRowToWire(created) };
  });

  app.patch<{ Params: { idOrSlug: string; eid: string }; Body: unknown }>("/worlds/:idOrSlug/entities/:eid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const existing = (await db.select().from(worldEntities)
      .where(and(eq(worldEntities.id, req.params.eid), eq(worldEntities.worldId, w.id))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    let body; try { body = updateEntityBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    const update: Partial<typeof worldEntities.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.summary !== undefined) update.summary = body.summary;
    if (body.bodyHtml !== undefined) update.bodyHtml = sanitizeBio(body.bodyHtml);
    if (body.stats !== undefined) update.statsJson = JSON.stringify(body.stats);
    if (body.tags !== undefined) update.tags = serializeTagList(body.tags);
    if (body.imageUrl !== undefined) update.imageUrl = body.imageUrl;
    if (body.isPublic !== undefined) update.isPublic = body.isPublic ? 1 : 0;
    if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
    if (body.arcId !== undefined) {
      if (body.arcId && !(await arcInWorld(w.id, body.arcId))) { reply.code(400); return { error: "unknown arc" }; }
      update.arcId = body.arcId;
    }
    if (body.slug !== undefined) {
      const slug = (body.slug.trim() || deriveSlug(body.name ?? existing.name)).toLowerCase();
      if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "invalid slug" }; }
      const dup = (await db.select({ id: worldEntities.id }).from(worldEntities)
        .where(and(eq(worldEntities.worldId, w.id), eq(worldEntities.kind, existing.kind), sql`lower(${worldEntities.slug}) = ${slug}`, ne(worldEntities.id, existing.id))).limit(1))[0];
      if (dup) { reply.code(409); return { error: "an entry with that slug already exists" }; }
      update.slug = slug;
    }
    await db.update(worldEntities).set(update).where(eq(worldEntities.id, existing.id));
    await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
    const updated = (await db.select().from(worldEntities).where(eq(worldEntities.id, existing.id)).limit(1))[0]!;
    return { entity: entityRowToWire(updated) };
  });

  app.delete<{ Params: { idOrSlug: string; eid: string } }>("/worlds/:idOrSlug/entities/:eid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const existing = (await db.select({ id: worldEntities.id }).from(worldEntities)
      .where(and(eq(worldEntities.id, req.params.eid), eq(worldEntities.worldId, w.id))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    await db.delete(worldEntities).where(eq(worldEntities.id, existing.id));
    await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
    return { ok: true };
  });

  /* ---------- Custom entry-kind registry ---------- */

  const createKindBody = z.object({
    key: z.string().min(1).max(40),
    label: z.string().min(1).max(60),
    description: z.string().max(200).optional(),
    icon: z.string().max(8).nullable().optional(),
    color: z.string().max(32).nullable().optional(),
  }).strict();
  const updateKindBody = z.object({
    label: z.string().min(1).max(60).optional(),
    description: z.string().max(200).optional(),
    icon: z.string().max(8).nullable().optional(),
    color: z.string().max(32).nullable().optional(),
    sortOrder: z.number().int().optional(),
  }).strict();

  app.get<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug/entity-kinds", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const rows = await db.select().from(worldEntityKinds).where(eq(worldEntityKinds.worldId, w.id))
      .orderBy(asc(worldEntityKinds.sortOrder), asc(worldEntityKinds.key));
    return { entityKinds: rows.map(entityKindRowToWire) };
  });

  app.post<{ Params: { idOrSlug: string }; Body: unknown }>("/worlds/:idOrSlug/entity-kinds", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    let body; try { body = createKindBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    const key = body.key.trim().toLowerCase();
    if (!SLUG_RX.test(key)) { reply.code(400); return { error: "invalid kind key" }; }
    if (RESERVED_KIND_KEYS.has(key)) { reply.code(409); return { error: "that kind key is reserved" }; }
    const countRow = (await db.select({ n: sql<number>`count(*)` }).from(worldEntityKinds).where(eq(worldEntityKinds.worldId, w.id)))[0];
    if ((countRow?.n ?? 0) >= WORLD_ENTITY_KINDS_CAP) { reply.code(409); return { error: "too many custom kinds" }; }
    const dup = (await db.select({ key: worldEntityKinds.key }).from(worldEntityKinds)
      .where(and(eq(worldEntityKinds.worldId, w.id), sql`lower(${worldEntityKinds.key}) = ${key}`)).limit(1))[0];
    if (dup) { reply.code(409); return { error: "that kind already exists" }; }
    const maxRow = (await db.select({ m: sql<number>`COALESCE(MAX(${worldEntityKinds.sortOrder}), -1)` }).from(worldEntityKinds).where(eq(worldEntityKinds.worldId, w.id)))[0];
    await db.insert(worldEntityKinds).values({
      worldId: w.id, key, label: body.label, description: body.description ?? "",
      icon: body.icon ?? null, color: body.color ?? null,
      sortOrder: Number(maxRow?.m ?? -1) + 1, createdAt: new Date(),
    });
    const rows = await db.select().from(worldEntityKinds).where(eq(worldEntityKinds.worldId, w.id))
      .orderBy(asc(worldEntityKinds.sortOrder), asc(worldEntityKinds.key));
    return { entityKinds: rows.map(entityKindRowToWire) };
  });

  app.patch<{ Params: { idOrSlug: string; key: string }; Body: unknown }>("/worlds/:idOrSlug/entity-kinds/:key", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    let body; try { body = updateKindBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    const key = req.params.key.toLowerCase();
    const existing = (await db.select().from(worldEntityKinds)
      .where(and(eq(worldEntityKinds.worldId, w.id), sql`lower(${worldEntityKinds.key}) = ${key}`)).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    const update: Partial<typeof worldEntityKinds.$inferInsert> = {};
    if (body.label !== undefined) update.label = body.label;
    if (body.description !== undefined) update.description = body.description;
    if (body.icon !== undefined) update.icon = body.icon;
    if (body.color !== undefined) update.color = body.color;
    if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
    await db.update(worldEntityKinds).set(update)
      .where(and(eq(worldEntityKinds.worldId, w.id), eq(worldEntityKinds.key, existing.key)));
    const rows = await db.select().from(worldEntityKinds).where(eq(worldEntityKinds.worldId, w.id))
      .orderBy(asc(worldEntityKinds.sortOrder), asc(worldEntityKinds.key));
    return { entityKinds: rows.map(entityKindRowToWire) };
  });

  app.delete<{ Params: { idOrSlug: string; key: string } }>("/worlds/:idOrSlug/entity-kinds/:key", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const key = req.params.key.toLowerCase();
    // Refuse to delete a kind that still has entries (avoids orphaning them).
    const inUse = (await db.select({ id: worldEntities.id }).from(worldEntities)
      .where(and(eq(worldEntities.worldId, w.id), eq(worldEntities.kind, key))).limit(1))[0];
    if (inUse) { reply.code(409); return { error: "kind still has entries; delete or reassign them first" }; }
    await db.delete(worldEntityKinds).where(and(eq(worldEntityKinds.worldId, w.id), sql`lower(${worldEntityKinds.key}) = ${key}`));
    return { ok: true };
  });

  /* ===================================================== *
   *  Arcs (storyline groupings)
   * ===================================================== */

  const arcStatus = z.enum(["planned", "active", "concluded", "archived"]);
  const createArcBody = z.object({
    title: z.string().min(1).max(120),
    slug: z.string().optional(),
    summary: z.string().max(500).optional(),
    status: arcStatus.optional(),
    color: z.string().max(32).nullable().optional(),
  }).strict();
  const updateArcBody = z.object({
    title: z.string().min(1).max(120).optional(),
    slug: z.string().optional(),
    summary: z.string().max(500).optional(),
    status: arcStatus.optional(),
    color: z.string().max(32).nullable().optional(),
    sortOrder: z.number().int().optional(),
  }).strict();

  app.get<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug/arcs", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const rows = await db.select().from(worldArcs).where(eq(worldArcs.worldId, w.id))
      .orderBy(asc(worldArcs.sortOrder), asc(worldArcs.createdAt));
    return { arcs: rows.map(arcRowToWire) };
  });

  app.post<{ Params: { idOrSlug: string }; Body: unknown }>("/worlds/:idOrSlug/arcs", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    let body; try { body = createArcBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    const countRow = (await db.select({ n: sql<number>`count(*)` }).from(worldArcs).where(eq(worldArcs.worldId, w.id)))[0];
    if ((countRow?.n ?? 0) >= WORLD_ARCS_CAP) { reply.code(409); return { error: "too many arcs" }; }
    const slug = (body.slug?.trim() || deriveSlug(body.title)).toLowerCase();
    if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "invalid slug" }; }
    const dup = (await db.select({ id: worldArcs.id }).from(worldArcs)
      .where(and(eq(worldArcs.worldId, w.id), sql`lower(${worldArcs.slug}) = ${slug}`)).limit(1))[0];
    if (dup) { reply.code(409); return { error: "an arc with that slug already exists" }; }
    const maxRow = (await db.select({ m: sql<number>`COALESCE(MAX(${worldArcs.sortOrder}), -1)` }).from(worldArcs).where(eq(worldArcs.worldId, w.id)))[0];
    const now = new Date();
    const aid = nanoid();
    await db.insert(worldArcs).values({
      id: aid, worldId: w.id, slug, title: body.title, summary: body.summary ?? "",
      status: body.status ?? "active", color: body.color ?? null,
      sortOrder: Number(maxRow?.m ?? -1) + 1, createdAt: now, updatedAt: now,
    });
    await db.update(worlds).set({ updatedAt: now }).where(eq(worlds.id, w.id));
    const created = (await db.select().from(worldArcs).where(eq(worldArcs.id, aid)).limit(1))[0]!;
    return { arc: arcRowToWire(created) };
  });

  app.patch<{ Params: { idOrSlug: string; aid: string }; Body: unknown }>("/worlds/:idOrSlug/arcs/:aid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const existing = (await db.select().from(worldArcs)
      .where(and(eq(worldArcs.id, req.params.aid), eq(worldArcs.worldId, w.id))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    let body; try { body = updateArcBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    const update: Partial<typeof worldArcs.$inferInsert> = { updatedAt: new Date() };
    if (body.title !== undefined) update.title = body.title;
    if (body.summary !== undefined) update.summary = body.summary;
    if (body.status !== undefined) update.status = body.status;
    if (body.color !== undefined) update.color = body.color;
    if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
    if (body.slug !== undefined) {
      const slug = (body.slug.trim() || deriveSlug(body.title ?? existing.title)).toLowerCase();
      if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "invalid slug" }; }
      const dup = (await db.select({ id: worldArcs.id }).from(worldArcs)
        .where(and(eq(worldArcs.worldId, w.id), sql`lower(${worldArcs.slug}) = ${slug}`, ne(worldArcs.id, existing.id))).limit(1))[0];
      if (dup) { reply.code(409); return { error: "an arc with that slug already exists" }; }
      update.slug = slug;
    }
    await db.update(worldArcs).set(update).where(eq(worldArcs.id, existing.id));
    const updated = (await db.select().from(worldArcs).where(eq(worldArcs.id, existing.id)).limit(1))[0]!;
    return { arc: arcRowToWire(updated) };
  });

  app.delete<{ Params: { idOrSlug: string; aid: string } }>("/worlds/:idOrSlug/arcs/:aid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const aid = req.params.aid;
    const existing = (await db.select({ id: worldArcs.id }).from(worldArcs)
      .where(and(eq(worldArcs.id, aid), eq(worldArcs.worldId, w.id))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    // Detach references so nothing dangles (no DB FK on arcId).
    await db.update(worldEntities).set({ arcId: null }).where(and(eq(worldEntities.worldId, w.id), eq(worldEntities.arcId, aid)));
    await db.update(worldPages).set({ arcId: null }).where(and(eq(worldPages.worldId, w.id), eq(worldPages.arcId, aid)));
    await db.update(worldSessions).set({ arcId: null }).where(and(eq(worldSessions.worldId, w.id), eq(worldSessions.arcId, aid)));
    await db.delete(worldArcs).where(eq(worldArcs.id, aid));
    await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
    return { ok: true };
  });

  /* ===================================================== *
   *  Sessions (chronological logs)
   * ===================================================== */

  const createSessionBody = z.object({
    title: z.string().min(1).max(160),
    slug: z.string().optional(),
    summary: z.string().max(500).optional(),
    bodyHtml: z.string().max(WORLD_ENTITY_BODY_MAX * 4).optional(),
    sessionDate: z.number().int().nullable().optional(),
    arcId: z.string().nullable().optional(),
  }).strict();
  const updateSessionBody = z.object({
    title: z.string().min(1).max(160).optional(),
    slug: z.string().optional(),
    summary: z.string().max(500).optional(),
    bodyHtml: z.string().max(WORLD_ENTITY_BODY_MAX * 4).optional(),
    sessionDate: z.number().int().nullable().optional(),
    arcId: z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
  }).strict();

  app.get<{ Params: { idOrSlug: string; sid: string } }>("/worlds/:idOrSlug/sessions/:sid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const s = (await db.select().from(worldSessions)
      .where(and(eq(worldSessions.id, req.params.sid), eq(worldSessions.worldId, w.id))).limit(1))[0];
    if (!s) { reply.code(404); return { error: "not found" }; }
    return { session: sessionRowToWire(s) };
  });

  app.post<{ Params: { idOrSlug: string }; Body: unknown }>("/worlds/:idOrSlug/sessions", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    let body; try { body = createSessionBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    if (body.arcId && !(await arcInWorld(w.id, body.arcId))) { reply.code(400); return { error: "unknown arc" }; }
    const countRow = (await db.select({ n: sql<number>`count(*)` }).from(worldSessions).where(eq(worldSessions.worldId, w.id)))[0];
    if ((countRow?.n ?? 0) >= WORLD_SESSIONS_CAP) { reply.code(409); return { error: "too many sessions" }; }
    const slug = (body.slug?.trim() || deriveSlug(body.title)).toLowerCase();
    if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "invalid slug" }; }
    const dup = (await db.select({ id: worldSessions.id }).from(worldSessions)
      .where(and(eq(worldSessions.worldId, w.id), sql`lower(${worldSessions.slug}) = ${slug}`)).limit(1))[0];
    if (dup) { reply.code(409); return { error: "a session with that slug already exists" }; }
    const maxRow = (await db.select({ m: sql<number>`COALESCE(MAX(${worldSessions.sortOrder}), -1)` }).from(worldSessions).where(eq(worldSessions.worldId, w.id)))[0];
    const now = new Date();
    const sid = nanoid();
    await db.insert(worldSessions).values({
      id: sid, worldId: w.id, arcId: body.arcId ?? null, slug, title: body.title,
      summary: body.summary ?? "", bodyHtml: sanitizeBio(body.bodyHtml ?? ""),
      sessionDate: body.sessionDate != null ? new Date(body.sessionDate) : null,
      sortOrder: Number(maxRow?.m ?? -1) + 1, createdAt: now, updatedAt: now,
    });
    await db.update(worlds).set({ updatedAt: now }).where(eq(worlds.id, w.id));
    const created = (await db.select().from(worldSessions).where(eq(worldSessions.id, sid)).limit(1))[0]!;
    return { session: sessionRowToWire(created) };
  });

  app.patch<{ Params: { idOrSlug: string; sid: string }; Body: unknown }>("/worlds/:idOrSlug/sessions/:sid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const existing = (await db.select().from(worldSessions)
      .where(and(eq(worldSessions.id, req.params.sid), eq(worldSessions.worldId, w.id))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    let body; try { body = updateSessionBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    const update: Partial<typeof worldSessions.$inferInsert> = { updatedAt: new Date() };
    if (body.title !== undefined) update.title = body.title;
    if (body.summary !== undefined) update.summary = body.summary;
    if (body.bodyHtml !== undefined) update.bodyHtml = sanitizeBio(body.bodyHtml);
    if (body.sessionDate !== undefined) update.sessionDate = body.sessionDate != null ? new Date(body.sessionDate) : null;
    if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
    if (body.arcId !== undefined) {
      if (body.arcId && !(await arcInWorld(w.id, body.arcId))) { reply.code(400); return { error: "unknown arc" }; }
      update.arcId = body.arcId;
    }
    if (body.slug !== undefined) {
      const slug = (body.slug.trim() || deriveSlug(body.title ?? existing.title)).toLowerCase();
      if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "invalid slug" }; }
      const dup = (await db.select({ id: worldSessions.id }).from(worldSessions)
        .where(and(eq(worldSessions.worldId, w.id), sql`lower(${worldSessions.slug}) = ${slug}`, ne(worldSessions.id, existing.id))).limit(1))[0];
      if (dup) { reply.code(409); return { error: "a session with that slug already exists" }; }
      update.slug = slug;
    }
    await db.update(worldSessions).set(update).where(eq(worldSessions.id, existing.id));
    await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
    const updated = (await db.select().from(worldSessions).where(eq(worldSessions.id, existing.id)).limit(1))[0]!;
    return { session: sessionRowToWire(updated) };
  });

  app.delete<{ Params: { idOrSlug: string; sid: string } }>("/worlds/:idOrSlug/sessions/:sid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const existing = (await db.select({ id: worldSessions.id }).from(worldSessions)
      .where(and(eq(worldSessions.id, req.params.sid), eq(worldSessions.worldId, w.id))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    await db.delete(worldSessions).where(eq(worldSessions.id, existing.id));
    await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
    return { ok: true };
  });

  /* ---------- Link a world to a room ---------- */
  app.put<{ Params: { roomId: string }; Body: unknown }>(
    "/rooms/:roomId/world",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      if (!(await callerCanModerateRoom(db, me.id, me.role, req.params.roomId))) {
        reply.code(403); return { error: "room owner / mod / admin only" };
      }

      let body;
      try { body = linkWorldBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const w = await resolveWorld(db, body.worldId, me.id, me.role);
      if (!w) { reply.code(404); return { error: "world not found" }; }
      // Linking other people's worlds requires visibility = open.
      if (w.ownerUserId !== me.id && w.visibility !== "open"
          && !(await hasPermission(me, "edit_others_world", db))) {
        reply.code(403);
        return { error: "world isn't open for catalog use" };
      }

      await db
        .insert(roomWorldLinks)
        .values({
          roomId: req.params.roomId,
          worldId: w.id,
          linkedByUserId: me.id,
        })
        .onConflictDoUpdate({
          target: roomWorldLinks.roomId,
          set: { worldId: w.id, linkedByUserId: me.id, linkedAt: new Date() },
        });
      await broadcastRoomState(io, db, req.params.roomId);
      return { ok: true };
    },
  );

  /* ---------- Unlink the room's current world ---------- */
  app.delete<{ Params: { roomId: string } }>("/rooms/:roomId/world", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await callerCanModerateRoom(db, me.id, me.role, req.params.roomId))) {
      reply.code(403); return { error: "room owner / mod / admin only" };
    }
    await db.delete(roomWorldLinks).where(eq(roomWorldLinks.roomId, req.params.roomId));
    await broadcastRoomState(io, db, req.params.roomId);
    return { ok: true };
  });

  /* ---------- Join a world as the current identity ---------- *
   *
   * Joining is per-identity (migration 0187): the membership row
   * carries the caller's currently-voiced character_id (or null for
   * OOC). Avery can be in Halcyon City without dragging the master's
   * OOC face, or the master's other characters, along.
   *
   * Owners can join their own world as any of their identities;
   * admins with edit_others_world can join any world. Everyone else
   * needs visibility="open" AND joinMode="open".
   */
  app.post<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug/members", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const isOwner = w.ownerUserId === me.id;
    const isAdmin = !isOwner && (await hasPermission(me, "edit_others_world", db));
    if (!isOwner && !isAdmin) {
      if (w.visibility !== "open") {
        reply.code(403);
        return { error: "this world isn't open for community membership", code: "NOT_OPEN" };
      }
      const joinMode = (w.joinMode ?? "open") as WorldJoinMode;
      if (joinMode === "invite-only") {
        reply.code(403);
        return {
          error: "this world is invite-only; ask the owner to add you",
          code: "INVITE_ONLY",
        };
      }
      if (joinMode === "application") {
        reply.code(403);
        return {
          error: "this world requires an application; use the Apply button",
          code: "APPLICATION_REQUIRED",
        };
      }
    }
    const charId = me.activeCharacterId;
    const existing = (await db
      .select()
      .from(worldMembers)
      .where(and(
        eq(worldMembers.worldId, w.id),
        eq(worldMembers.userId, me.id),
        charId === null
          ? sql`${worldMembers.characterId} IS NULL`
          : eq(worldMembers.characterId, charId),
      ))
      .limit(1))[0];
    if (existing) {
      // Idempotent: this identity is already a member.
      return { ok: true, alreadyMember: true };
    }
    await db.insert(worldMembers).values({
      worldId: w.id,
      userId: me.id,
      characterId: charId,
    });
    await rebroadcastUserOccupancy(io, db, me.id);
    return { ok: true };
  });

  /* ---------- Owner-invited member ----------
   * Direct owner-side membership add. Unlike `POST /members` (which
   * registers the CALLER as a member), this endpoint registers a NAMED
   * target identity that the owner picked. The two paths sit together
   * because they hit the same `worldMembers` table, but the auth model
   * and identity resolution differ, invites are owner/admin only and
   * the target comes from a free-form name OR an unambiguous identity
   * token (`@id:` / `@cid:`) the same shared resolver every other
   * identity-keyed command uses.
   *
   * Per-identity contract preserved: if the target token addresses a
   * specific character (`@cid:`), the membership row is bound to that
   * character; addressing a master (`@id:` or a bare master name)
   * inserts an OOC membership with `characterId = null`. The owner can
   * invite both a master AND any of their characters separately, same
   * as the catalog Join flow, by re-running the invite with each
   * identity token.
   *
   * Useful for ALL three join modes:
   *   - invite-only: the ONLY way anyone gets in besides the owner.
   *   - application: shortcut for "I already trust this person; skip
   *     the queue."
   *   - open: an explicit pre-add for someone who hasn't found the
   *     world yet but the owner wants them seated.
   */
  app.post<{ Params: { idOrSlug: string }; Body: unknown }>(
    "/worlds/:idOrSlug/invites",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
      if (!w) { reply.code(404); return { error: "not found" }; }
      const isOwner = w.ownerUserId === me.id;
      const isAdmin = !isOwner && (await hasPermission(me, "edit_others_world", db));
      if (!isOwner && !isAdmin) {
        reply.code(403); return { error: "owner only" };
      }
      const body = z.object({ target: z.string().min(1).max(120) }).safeParse(req.body);
      if (!body.success) { reply.code(400); return { error: "invalid body" }; }
      const resolution = await resolveIdentityArg(db, body.data.target);
      if (resolution.kind === "none") {
        reply.code(404); return { error: `no user or character matched "${body.data.target}"` };
      }
      if (resolution.kind === "ambiguous") {
        // Surface the disambiguation candidates so the owner can re-run
        // with the right token. Same shape `emitAmbiguousIdentityModal`
        // uses on the chat side, just over HTTP.
        reply.code(409);
        return {
          error: `"${body.data.target}" matches ${resolution.matches.length} identities, re-run with a specific token`,
          candidates: resolution.matches.map((m) => ({
            displayName: m.displayName,
            masterUsername: m.masterUsername,
            characterId: m.characterId,
            userId: m.userId,
            token: m.characterId ? `@cid:${m.characterId}` : `@id:${m.userId}`,
          })),
        };
      }
      const target = resolution.target;
      const targetCharId = target.characterId;
      // Idempotent on (worldId, userId, characterId). Mirrors the
      // same triple-key membership shape `POST /members` uses, so
      // re-inviting an identity that's already in returns success
      // instead of a duplicate-row error.
      const existing = (await db
        .select()
        .from(worldMembers)
        .where(and(
          eq(worldMembers.worldId, w.id),
          eq(worldMembers.userId, target.userId),
          targetCharId === null
            ? sql`${worldMembers.characterId} IS NULL`
            : eq(worldMembers.characterId, targetCharId),
        ))
        .limit(1))[0];
      if (existing) {
        return { ok: true, alreadyMember: true, displayName: target.displayName };
      }
      await db.insert(worldMembers).values({
        worldId: w.id,
        userId: target.userId,
        characterId: targetCharId,
      });
      // Re-broadcast the target's occupancy so any user-list watching
      // them picks up the new world-membership chip immediately, same
      // as the self-join path.
      await rebroadcastUserOccupancy(io, db, target.userId);
      // Fire-and-forget web-push to the invitee. Without this, the
      // direct-add flow was completely silent, the invitee only
      // discovered the membership by stumbling on the member list,
      // which made invite-only worlds borderline unusable. Matches
      // the whisper / mention push posture in `broadcast.pushTriggers`:
      // generic copy, scoped tag so repeats coalesce, never throws.
      pushToUser(db, target.userId, {
        title: "Added to a world",
        body: `${me.username} added you to ${w.name}.`,
        tag: `world-invite-${w.id}`,
      }).catch(() => {});
      return { ok: true, displayName: target.displayName };
    },
  );

  /* ---------- Leave a world as the current identity ---------- */
  app.delete<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug/members", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const charId = me.activeCharacterId;
    const r = await db
      .delete(worldMembers)
      .where(and(
        eq(worldMembers.worldId, w.id),
        eq(worldMembers.userId, me.id),
        charId === null
          ? sql`${worldMembers.characterId} IS NULL`
          : eq(worldMembers.characterId, charId),
      ));
    if (r.changes === 0) return { ok: true, alreadyAbsent: true };
    await rebroadcastUserOccupancy(io, db, me.id);
    return { ok: true };
  });

  /**
   * Caller's world memberships across every identity. Used by the
   * WorldsList modal ("Worlds I've joined") and by the catalog's
   * Joined-indicator pre-fetch.
   *
   * Each row carries the identity that joined (`characterId` null =
   * OOC, non-null = the character) plus a resolved `identityDisplayName`
   * so the My Worlds list can render "as Avery, Halcyon City" without
   * a second lookup. Soft-deleted characters drop out.
   */
  app.get("/me/worlds/memberships", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const rows = await db
      .select({
        worldId: worldMembers.worldId,
        characterId: worldMembers.characterId,
        joinedAt: worldMembers.joinedAt,
        worldSlug: worlds.slug,
        worldName: worlds.name,
        ownerUserId: worlds.ownerUserId,
        characterName: characters.name,
        characterDeletedAt: characters.deletedAt,
      })
      .from(worldMembers)
      .innerJoin(worlds, eq(worlds.id, worldMembers.worldId))
      .leftJoin(characters, eq(characters.id, worldMembers.characterId))
      .where(eq(worldMembers.userId, me.id))
      .orderBy(asc(worldMembers.joinedAt));
    const visible = rows.filter((r) => r.characterId === null || r.characterDeletedAt === null);
    const memberships: WorldMembership[] = await Promise.all(
      visible.map(async (r) => ({
        worldId: r.worldId,
        worldSlug: r.worldSlug,
        worldName: r.worldName,
        ownerUsername: await loadOwnerUsername(db, r.ownerUserId),
        characterId: r.characterId,
        identityDisplayName: r.characterId !== null
          ? (r.characterName ?? me.username)
          : me.username,
        joinedAt: +r.joinedAt,
      })),
    );
    return { memberships };
  });

  /**
   * Read another user's memberships (for the profile modal). Returns only
   * memberships in worlds whose visibility allows the viewer to see them
   * (private worlds are filtered out unless the viewer is the owner of the
   * world or an admin).
   */
  app.get<{ Params: { userId: string } }>("/users/:userId/world-memberships", async (req, reply) => {
    const me = await getSessionUser(req, db);
    // Visibility model, runs identically for anonymous and logged-in
    // viewers, with the viewer's identity only affecting which PRIVATE
    // worlds are unblanked:
    //
    //   public / open visibility → always shown (the splash already
    //     features these by name; surfacing them on a profile leaks
    //     nothing extra).
    //   private visibility       → shown ONLY when the viewer is the
    //     world's owner or a site admin. Anonymous viewers and
    //     unrelated logged-in viewers never see private memberships.
    //
    // The previous implementation gated the ENTIRE response on auth
    // ({ private: true } stub for anonymous), which over-hid public
    // worlds the splash was already advertising. Now the gate is per
    // row, scoped to the privacy of each world individually.
    // Per-identity filter via query string: `?characterId=<id>` filters
    // to that character's memberships; `?characterId=ooc` returns the
    // master's OOC memberships only; omit the param to return ALL
    // identities. The profile modal scopes the request to whichever
    // identity it's rendering, character profile passes the character
    // id, master profile passes "ooc".
    const q = req.query as { characterId?: string } | undefined;
    const filterChar = q?.characterId;
    const rows = await db
      .select({
        worldId: worldMembers.worldId,
        characterId: worldMembers.characterId,
        joinedAt: worldMembers.joinedAt,
        worldSlug: worlds.slug,
        worldName: worlds.name,
        visibility: worlds.visibility,
        ownerUserId: worlds.ownerUserId,
        ownerUsername: users.username,
        characterName: characters.name,
        characterDeletedAt: characters.deletedAt,
      })
      .from(worldMembers)
      .innerJoin(worlds, eq(worlds.id, worldMembers.worldId))
      .innerJoin(users, eq(users.id, worlds.ownerUserId))
      .leftJoin(characters, eq(characters.id, worldMembers.characterId))
      .where(eq(worldMembers.userId, req.params.userId))
      .orderBy(asc(worldMembers.joinedAt));
    // Pre-resolve admin override once; the per-row predicate stays
    // synchronous and we avoid 1+N permission lookups on a list filter.
    const meCanSeePrivateAsAdmin = !!me && (await hasPermission(me, "edit_others_world", db));
    // Master username for the OOC identity label. Resolved once.
    const targetMaster = (await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, req.params.userId))
      .limit(1))[0];
    const targetMasterUsername = targetMaster?.username ?? "(deleted user)";
    const filtered = rows.filter((r) => {
      // Drop soft-deleted character rows.
      if (r.characterId !== null && r.characterDeletedAt !== null) return false;
      // Identity filter.
      if (filterChar === "ooc" && r.characterId !== null) return false;
      if (filterChar && filterChar !== "ooc" && r.characterId !== filterChar) return false;
      // Private-world visibility gate (unchanged from v2).
      if (r.visibility !== "private") return true;
      return !!me && (meCanSeePrivateAsAdmin || r.ownerUserId === me.id);
    });
    const memberships: WorldMembership[] = filtered.map((r) => ({
      worldId: r.worldId,
      worldSlug: r.worldSlug,
      worldName: r.worldName,
      ownerUsername: r.ownerUsername,
      characterId: r.characterId,
      identityDisplayName: r.characterId !== null
        ? (r.characterName ?? targetMasterUsername)
        : targetMasterUsername,
      joinedAt: +r.joinedAt,
    }));
    return { memberships };
  });

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

// Suppress an unused-imports lint flag - FastifyRequest is used implicitly
// by route generic params elsewhere.
void (null as unknown as FastifyRequest);
