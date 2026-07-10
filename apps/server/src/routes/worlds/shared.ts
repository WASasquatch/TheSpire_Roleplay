import { and, asc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import type {
  Role,
  Theme,
  WorldApplicationEntry,
  WorldApplicationStatus,
  WorldCatalogEntry,
  WorldGenre,
  WorldJoinMode,
  WorldMemberRef,
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
  WorldVibeStats,
  WorldVisibility,
 ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import {
  CONTENT_WARNINGS,
  WORLD_APP_ANSWER_MAX_LEN,
  WORLD_APP_MAX_QUESTIONS,
  WORLD_APP_QUESTION_MAX_LEN,
  WORLD_APP_REVIEW_NOTE_MAX_LEN,
  WORLD_PAGE_DEPTH_CAP,
  WORLD_VIBE_AXES,
  slugRx,
  normalizeTheme,
  parseTagList,
} from "@thekeep/shared";
import type { Server as IoServer } from "socket.io";
import { isMinor } from "../../auth/ageGate.js";
import { hasPermission } from "../../auth/permissions.js";
import type {
  worldApplications,
  worldArcs,
  worldEntities,
  worldEntityKinds,
  worldSessions} from "../../db/schema.js";
import {
  characters,
  roomMembers,
  roomWorldLinks,
  rooms,
  users,
  worldCollaborators,
  worldMembers,
  worldPages,
  worlds,
} from "../../db/schema.js";
import {
  offsetPageQueryShape,
} from "../../lib/pagination.js";
import { rebroadcastPresenceForUser } from "../../realtime/broadcast.js";
import type { Db } from "../../db/index.js";

export type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/**
 * Slug rules: lowercase letters, numbers, hyphens. 1-60 chars. The slug
 * lives in URLs and slash commands, so we keep it tight.
 */
export const SLUG_RX = slugRx(60);

export const visibilityEnum = z.enum(["private", "public", "open"]);
export const genreEnum = z.enum([
  "fantasy", "modern", "scifi", "horror",
  "western", "steampunk", "mythological", "other",
]);
export const statusEnum = z.enum(["active", "featured", "archived"]);
export const pacingEnum = z.enum([
  "freeform",
  "drop-in",
  "casual",
  "slice-of-life",
  "structured",
  "long-form",
]);
export const contentWarningEnum = z.enum(CONTENT_WARNINGS as unknown as [string, ...string[]]);

// Tags: each entry must look like a slug-ish kebab token. The canonical
// list is curated and short, but owners can add custom tags, this regex
// gates the *shape* (lowercase letters / digits / hyphens, 1-32 chars),
// not the membership. Empty input arrays are allowed (no tags).
export const TAG_RX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const tagSchema = z
  .string()
  .min(1)
  .max(32)
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => TAG_RX.test(s), { message: "tags must be lowercase letters / digits / hyphens" });
export const tagsArraySchema = z
  .array(tagSchema)
  .max(20)
  .transform((arr) => parseTagList(arr.join(",")));
export const cwArraySchema = z
  .array(contentWarningEnum)
  .max(CONTENT_WARNINGS.length)
  .transform((arr) => parseTagList(arr.join(",")));

// Restrict cover image URLs to http(s), same posture as character
// avatars (the URL constructor rejects malformed input; we additionally
// gate the protocol).
export const httpUrl = z.string().min(1).max(2000).refine(
  (s) => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } },
  { message: "coverImageUrl must use http or https" },
);

/**
 * Vibe-stat axis Zod schema. 0..100 inclusive integer, OR null to
 * clear an axis back to "unset". The shape mirrors WorldVibeStats,
 * every axis key is optional in the request body; only the keys the
 * author actually touched are sent over the wire.
 */
export const vibeStatValue = z.union([
  z.number().int().min(0).max(100),
  z.null(),
]);
export const vibeStatsSchema = z.object({
  combat: vibeStatValue.optional(),
  magic: vibeStatValue.optional(),
  technology: vibeStatValue.optional(),
  romance: vibeStatValue.optional(),
  politics: vibeStatValue.optional(),
  mystery: vibeStatValue.optional(),
  horror: vibeStatValue.optional(),
  exploration: vibeStatValue.optional(),
}).strict();

export const joinModeEnum = z.enum(["open", "application", "invite-only"]);

/** Application question list: max 5 entries, each 1..280 chars. */
export const applicationQuestionsSchema = z
  .array(z.string().min(1).max(WORLD_APP_QUESTION_MAX_LEN))
  .max(WORLD_APP_MAX_QUESTIONS)
  .transform((arr) => arr.map((s) => s.trim()).filter((s) => s.length > 0));

export const createWorldBody = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().max(60).optional(),
  description: z.string().max(2000).nullable().optional(),
  visibility: visibilityEnum.optional(),
  // Owner-set "18+ world" flag (age-restriction plan Phase 4). Adults
  // only; enforced at the route layer so the rejection copy is friendly.
  isNsfw: z.boolean().optional(),
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
export const updateWorldBody = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z.string().max(60).optional(),
  description: z.string().max(2000).nullable().optional(),
  visibility: visibilityEnum.optional(),
  // Adult owners (or edit_others_world staff) only; route-enforced.
  isNsfw: z.boolean().optional(),
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
export const optInt0to100 = z.preprocess(
  (v) => (v === "" || v === undefined ? undefined : v),
  z.coerce.number().int().min(0).max(100).optional(),
);

export const vibeRangeQueryShape = Object.fromEntries(
  WORLD_VIBE_AXES.flatMap((a) => [
    [`min_${a.key}`, optInt0to100],
    [`max_${a.key}`, optInt0to100],
  ]),
) as Record<string, typeof optInt0to100>;

export const catalogQuery = z.object({
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
  ...offsetPageQueryShape,
  ...vibeRangeQueryShape,
}).strict();

export const submitApplicationBody = z.object({
  /**
   * Free-text answers, one per question in the world's current
   * question list (same length). The route validates length match
   * AGAINST the live world row so a stale form can't smuggle extra
   * answers in.
   */
  answers: z.array(z.string().max(WORLD_APP_ANSWER_MAX_LEN)).max(WORLD_APP_MAX_QUESTIONS),
}).strict();

export const reviewApplicationBody = z.object({
  action: z.enum(["approve", "reject"]),
  /** Optional author note shown to the applicant on the terminal-state row. */
  reviewNote: z.string().max(WORLD_APP_REVIEW_NOTE_MAX_LEN).nullable().optional(),
}).strict();

export const createPageBody = z.object({
  title: z.string().min(1).max(120),
  slug: z.string().max(60).optional(),
  parentPageId: z.string().nullable().optional(),
  bodyHtml: z.string().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
}).strict();

export const updatePageBody = z.object({
  title: z.string().min(1).max(120).optional(),
  slug: z.string().max(60).optional(),
  parentPageId: z.string().nullable().optional(),
  bodyHtml: z.string().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
}).strict();

export const linkWorldBody = z.object({
  worldId: z.string().min(1),
}).strict();

/* =========================================================
 *  Internal helpers
 * ========================================================= */

export async function loadOwnerUsername(db: Db, userId: string): Promise<string> {
  const u = (await db.select({ username: users.username }).from(users).where(eq(users.id, userId)).limit(1))[0];
  return u?.username ?? "(deleted user)";
}

export async function pageCount(db: Db, worldId: string): Promise<number> {
  const r = (await db
    .select({ n: sql<number>`count(*)` })
    .from(worldPages)
    .where(eq(worldPages.worldId, worldId)))[0];
  return r?.n ?? 0;
}

export async function memberCountFor(db: Db, worldId: string): Promise<number> {
  const r = (await db
    .select({ n: sql<number>`count(*)` })
    .from(worldMembers)
    .where(eq(worldMembers.worldId, worldId)))[0];
  return r?.n ?? 0;
}

export async function linkedRoomCountFor(db: Db, worldId: string): Promise<number> {
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
export async function memberListFor(db: Db, worldId: string): Promise<WorldMemberRef[]> {
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
export function parseStoredTheme(raw: string | null): Theme | null {
  if (!raw) return null;
  try { return normalizeTheme(JSON.parse(raw)); }
  catch { return null; }
}

/**
 * Read the eight vibe-stat columns off a `worlds` row into the
 * wire-shape bag. Null values pass through (renderer treats them as
 * "unset" / muted dash).
 */
export function vibeStatsFromRow(w: typeof worlds.$inferSelect): WorldVibeStats {
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
export function parseApplicationQuestions(raw: string): string[] {
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
export type AppRow = typeof worldApplications.$inferSelect;
export async function applicationToWire(
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

export async function toSummary(db: Db, w: typeof worlds.$inferSelect): Promise<WorldSummary> {
  const ownerUsername = await loadOwnerUsername(db, w.ownerUserId);
  return {
    id: w.id,
    slug: w.slug,
    ownerUserId: w.ownerUserId,
    ownerUsername,
    name: w.name,
    description: w.description,
    visibility: w.visibility as WorldVisibility,
    isNsfw: w.isNsfw,
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
export async function toCatalogEntry(db: Db, w: typeof worlds.$inferSelect): Promise<WorldCatalogEntry> {
  return {
    id: w.id,
    slug: w.slug,
    ownerUsername: await loadOwnerUsername(db, w.ownerUserId),
    name: w.name,
    description: w.description,
    isNsfw: w.isNsfw,
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

export function pageRowToWire(p: typeof worldPages.$inferSelect): WorldPage {
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

export function arcRowToWire(a: typeof worldArcs.$inferSelect): WorldArc {
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
export function sessionLightToWire(s: typeof worldSessions.$inferSelect): WorldSessionLight {
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
export function sessionRowToWire(s: typeof worldSessions.$inferSelect): WorldSession {
  return { ...sessionLightToWire(s), bodyHtml: s.bodyHtml };
}

/** Defensive JSON → string/string map for entity stats (mirrors codex). */
export function parseEntityStats(json: string): Record<string, string> {
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

export function entityLightToWire(e: typeof worldEntities.$inferSelect): WorldEntityLight {
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
export function entityRowToWire(e: typeof worldEntities.$inferSelect): WorldEntity {
  return { ...entityLightToWire(e), bodyHtml: e.bodyHtml };
}
export function entityKindRowToWire(k: typeof worldEntityKinds.$inferSelect): WorldEntityKind {
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
 *
 * HARD age gate (age-restriction plan Phase 4): an 18+ world resolves
 * only for signed-in ADULT viewers — minors and anonymous visitors get
 * the same null as a missing world, so every consumer (detail payload,
 * the /w/:slug page's data fetch, pages, membership, applications,
 * knowledge base) inherits the 404 posture from this one chokepoint.
 * There is deliberately NO owner/admin bypass: age gates have none, so
 * a minor owner whose world an adult staffer flagged 18+ loses access
 * too. Membership + collaborator rows are never touched by the flag
 * (keep-but-hide, mirroring rooms) so everything returns if it flips
 * back — or when the member turns 18. The viewer's adulthood is derived
 * from `users.birthdate` right here (one point read, 18+ worlds only)
 * instead of a new parameter so all ~30 existing call sites — and any
 * future one — can't forget to pass it.
 */
export async function resolveWorld(
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
  if (w.isNsfw) {
    if (!viewerUserId) return null;
    const viewer = (await db
      .select({ birthdate: users.birthdate })
      .from(users)
      .where(eq(users.id, viewerUserId))
      .limit(1))[0];
    // Missing row fails closed, same posture as ageGate's malformed-DOB rule.
    if (!viewer || isMinor(viewer)) return null;
  }
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
export async function canEditWorld(
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
export async function collaboratorListFor(
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
export async function depthOf(db: Db, parentPageId: string | null): Promise<number> {
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

export async function callerCanModerateRoom(db: Db, userId: string, role: Role, roomId: string): Promise<boolean> {
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
export async function rebroadcastUserOccupancy(io: Io, db: Db, userId: string): Promise<void> {
  await rebroadcastPresenceForUser(io, db, userId);
}
