/**
 * Builds the response for `GET /earning/scriptorium-rankings`.
 *
 * Two flavors of board:
 *  - AUTHOR boards (identity rows) — Top Publishers (count of public published
 *    stories) and Most Words (sum of published word counts), grouped by the
 *    authoring identity (the story's character if authored IC, else the master
 *    pool). These reuse `fetchDisplayInfo` so author rows render with the same
 *    avatar / border / name-style fidelity as every other ranking, and inherit
 *    its privacy gate (private/disabled masters + deleted characters drop).
 *  - BOOK boards (story rows) — Top Books (most applause) and Highest Rated
 *    (avg review score, with a minimum-reviews qualifier). These surface the
 *    book itself (cover, title, author byline), restricted to SFW ratings since
 *    the endpoint is public.
 *
 * Like the social-game rankings, everything is computed on the fly from the
 * live `stories` rollups; no registration step and no materialized cache.
 */

import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { SFW_RATINGS, type StoryAuthor, type StoryRating } from "@thekeep/shared";
import { characters, stories, users } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { fetchDisplayInfo, type RankingPoolEntry, type RankingScope } from "./rankings.js";

const TOP_N = 10;
/** Highest-Rated needs at least this many reviews to qualify — keeps a lone
 *  5-star review from topping the board. */
const MIN_REVIEWS_FOR_RATED = 3;

/** A board entry before the display-info join (mirrors rankings.ts). */
interface RawEntry {
  scope: RankingScope;
  ownerId: string;
  value: number;
}

/** Master-account privacy gate (joined via the author's `users` row). */
function publicUserFilter() {
  return and(isNull(users.disabledAt), eq(users.isPublic, true));
}

/** "A published, public story" — matches the splash bookshelf's notion of a
 *  live book (excludes drafts and abandoned works). */
function publishedStoryFilter() {
  return and(eq(stories.visibility, "public"), ne(stories.status, "draft"), ne(stories.status, "abandoned"));
}

function mergeTop(masters: RawEntry[], chars: RawEntry[]): RawEntry[] {
  return [...masters, ...chars].sort((a, b) => b.value - a.value).slice(0, TOP_N);
}

/* ---------------- AUTHOR boards (identity rows) ---------------- */

/** Top Publishers: count of public published stories per authoring identity. */
async function queryPublishersBoard(db: Db): Promise<RawEntry[]> {
  const masterRows = await db
    .select({ ownerId: stories.authorUserId, value: sql<number>`COUNT(*)` })
    .from(stories)
    .innerJoin(users, eq(users.id, stories.authorUserId))
    .where(and(publicUserFilter(), isNull(stories.authorCharacterId), publishedStoryFilter()))
    .groupBy(stories.authorUserId)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(TOP_N);
  const charRows = await db
    .select({ ownerId: stories.authorCharacterId, value: sql<number>`COUNT(*)` })
    .from(stories)
    .innerJoin(characters, eq(characters.id, stories.authorCharacterId))
    .innerJoin(users, eq(users.id, characters.userId))
    .where(and(publicUserFilter(), isNotNull(stories.authorCharacterId), isNull(characters.deletedAt), publishedStoryFilter()))
    .groupBy(stories.authorCharacterId)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(TOP_N);
  return mergeTop(
    masterRows.map((r) => ({ scope: "user" as const, ownerId: r.ownerId, value: Number(r.value) })),
    charRows.map((r) => ({ scope: "character" as const, ownerId: r.ownerId!, value: Number(r.value) })),
  );
}

/** Most Words: sum of published word counts per authoring identity. */
async function queryWordsBoard(db: Db): Promise<RawEntry[]> {
  const masterRows = await db
    .select({ ownerId: stories.authorUserId, value: sql<number>`COALESCE(SUM(${stories.totalWords}), 0)` })
    .from(stories)
    .innerJoin(users, eq(users.id, stories.authorUserId))
    .where(and(publicUserFilter(), isNull(stories.authorCharacterId), publishedStoryFilter()))
    .groupBy(stories.authorUserId)
    .orderBy(desc(sql`COALESCE(SUM(${stories.totalWords}), 0)`))
    .limit(TOP_N);
  const charRows = await db
    .select({ ownerId: stories.authorCharacterId, value: sql<number>`COALESCE(SUM(${stories.totalWords}), 0)` })
    .from(stories)
    .innerJoin(characters, eq(characters.id, stories.authorCharacterId))
    .innerJoin(users, eq(users.id, characters.userId))
    .where(and(publicUserFilter(), isNotNull(stories.authorCharacterId), isNull(characters.deletedAt), publishedStoryFilter()))
    .groupBy(stories.authorCharacterId)
    .orderBy(desc(sql`COALESCE(SUM(${stories.totalWords}), 0)`))
    .limit(TOP_N);
  return mergeTop(
    masterRows.map((r) => ({ scope: "user" as const, ownerId: r.ownerId, value: Number(r.value) })),
    charRows.map((r) => ({ scope: "character" as const, ownerId: r.ownerId!, value: Number(r.value) })),
  );
}

/* ---------------- BOOK boards (story rows) ---------------- */

export interface ScriptoriumBookRow {
  storyId: string;
  slug: string;
  title: string;
  coverImageUrl: string | null;
  rating: StoryRating;
  author: StoryAuthor;
  applauseCount: number;
  avgRating: number | null;
  reviewCount: number;
  totalWords: number;
}

/** Shared select shape for book boards: the story rollups + the author byline
 *  resolved inline (one query, no per-row author fetch). */
function bookRowSelect() {
  return {
    id: stories.id,
    slug: stories.slug,
    title: stories.title,
    coverImageUrl: stories.coverImageUrl,
    rating: stories.rating,
    applauseCount: stories.applauseCount,
    avgRatingX100: stories.avgRatingX100,
    reviewCount: stories.reviewCount,
    totalWords: stories.totalWords,
    authorUserId: stories.authorUserId,
    authorCharacterId: stories.authorCharacterId,
    masterUsername: users.username,
    masterAvatarUrl: users.avatarUrl,
    characterName: characters.name,
    characterAvatarUrl: characters.avatarUrl,
  };
}

type BookSelectRow = {
  id: string; slug: string; title: string; coverImageUrl: string | null;
  rating: string | null; applauseCount: number | null; avgRatingX100: number | null;
  reviewCount: number | null; totalWords: number | null;
  authorUserId: string; authorCharacterId: string | null;
  masterUsername: string | null; masterAvatarUrl: string | null;
  characterName: string | null; characterAvatarUrl: string | null;
};

function toBookRow(r: BookSelectRow): ScriptoriumBookRow {
  const author: StoryAuthor = {
    userId: r.authorUserId,
    masterUsername: r.masterUsername ?? "(deleted user)",
    characterId: r.authorCharacterId ?? null,
    characterName: r.authorCharacterId ? (r.characterName ?? null) : null,
    characterAvatarUrl: r.authorCharacterId ? (r.characterAvatarUrl ?? null) : null,
    masterAvatarUrl: r.masterAvatarUrl ?? null,
  };
  return {
    storyId: r.id,
    slug: r.slug,
    title: r.title,
    coverImageUrl: r.coverImageUrl ?? null,
    rating: (r.rating ?? "PG") as StoryRating,
    author,
    applauseCount: r.applauseCount ?? 0,
    avgRating: r.avgRatingX100 == null ? null : Math.round(r.avgRatingX100) / 100,
    reviewCount: r.reviewCount ?? 0,
    totalWords: r.totalWords ?? 0,
  };
}

/** Books, public + published + SFW, whose author is public and (if IC) not a
 *  deleted character. Shared base predicate for both book boards. */
function bookBoardFilter() {
  return and(
    publicUserFilter(),
    publishedStoryFilter(),
    inArray(stories.rating, [...SFW_RATINGS]),
    or(isNull(stories.authorCharacterId), isNull(characters.deletedAt)),
  );
}

async function queryTopBooks(db: Db): Promise<ScriptoriumBookRow[]> {
  const rows = await db
    .select(bookRowSelect())
    .from(stories)
    .innerJoin(users, eq(users.id, stories.authorUserId))
    .leftJoin(characters, eq(characters.id, stories.authorCharacterId))
    .where(and(bookBoardFilter(), sql`${stories.applauseCount} > 0`))
    .orderBy(desc(stories.applauseCount))
    .limit(TOP_N);
  return rows.map(toBookRow);
}

async function queryHighestRated(db: Db): Promise<ScriptoriumBookRow[]> {
  const rows = await db
    .select(bookRowSelect())
    .from(stories)
    .innerJoin(users, eq(users.id, stories.authorUserId))
    .leftJoin(characters, eq(characters.id, stories.authorCharacterId))
    .where(and(
      bookBoardFilter(),
      isNotNull(stories.avgRatingX100),
      gte(stories.reviewCount, MIN_REVIEWS_FOR_RATED),
    ))
    .orderBy(desc(stories.avgRatingX100), desc(stories.reviewCount))
    .limit(TOP_N);
  return rows.map(toBookRow);
}

/* ---------------- Assembly ---------------- */

export interface ScriptoriumAuthorBoard {
  key: "publishers" | "words";
  label: string;
  metric: string;
  entries: RankingPoolEntry[];
}
export interface ScriptoriumBookBoard {
  key: "applause" | "rated";
  label: string;
  metric: string;
  entries: ScriptoriumBookRow[];
}
export interface ScriptoriumRankingsResponse {
  authorBoards: ScriptoriumAuthorBoard[];
  bookBoards: ScriptoriumBookBoard[];
  generatedAt: number;
}

/**
 * Short-TTL single-flight cache for the scriptorium-rankings build (mirrors
 * rankings.ts). The public route is per-IP rate-capped, but the four board
 * queries (COUNT/SUM/AVG over the `stories` rollups) + batched display-info
 * fetch are process-global; memoizing the in-flight Promise per db collapses a
 * fleet of pollers into ~1-2 passes per TTL and shares one query pass under
 * concurrent cold load. `generatedAt` reflects the cached-build time — the
 * correct/honest "as of" stamp for a cached leaderboard. Keyed by db so a
 * fresh test db never serves another's rows.
 */
const SCRIPTORIUM_RANKINGS_TTL_MS = 45_000;
const scriptoriumRankingsCache = new Map<Db, { at: number; promise: Promise<ScriptoriumRankingsResponse> }>();

export async function buildScriptoriumRankings(db: Db): Promise<ScriptoriumRankingsResponse> {
  const cached = scriptoriumRankingsCache.get(db);
  if (cached && Date.now() - cached.at < SCRIPTORIUM_RANKINGS_TTL_MS) return cached.promise;
  const promise = computeScriptoriumRankings(db);
  scriptoriumRankingsCache.set(db, { at: Date.now(), promise });
  promise.catch(() => scriptoriumRankingsCache.delete(db)); // don't memoize a failed pass
  return promise;
}

async function computeScriptoriumRankings(db: Db): Promise<ScriptoriumRankingsResponse> {
  const [publishersRaw, wordsRaw, topBooks, highestRated] = await Promise.all([
    queryPublishersBoard(db),
    queryWordsBoard(db),
    queryTopBooks(db),
    queryHighestRated(db),
  ]);

  // Resolve display context for every author identity on the boards, reusing
  // the earning rankings' batched resolver (and its privacy gate).
  const referenced = new Map<string, { scope: RankingScope; ownerId: string }>();
  for (const r of [...publishersRaw, ...wordsRaw]) {
    referenced.set(`${r.scope}::${r.ownerId}`, { scope: r.scope, ownerId: r.ownerId });
  }
  const displayInfo = await fetchDisplayInfo(db, [...referenced.values()]);
  const stitch = (raws: RawEntry[]): RankingPoolEntry[] => {
    const out: RankingPoolEntry[] = [];
    for (const r of raws) {
      const info = displayInfo.get(`${r.scope}::${r.ownerId}`);
      if (!info) continue; // hidden identity, drop
      out.push({ ...info, value: r.value });
    }
    return out;
  };

  return {
    authorBoards: [
      { key: "publishers", label: "Top Publishers", metric: "Books", entries: stitch(publishersRaw) },
      { key: "words", label: "Most Words", metric: "Words", entries: stitch(wordsRaw) },
    ],
    bookBoards: [
      { key: "applause", label: "Top Books", metric: "Applause", entries: topBooks },
      { key: "rated", label: "Highest Rated", metric: "Rating", entries: highestRated },
    ],
    generatedAt: Date.now(),
  };
}
