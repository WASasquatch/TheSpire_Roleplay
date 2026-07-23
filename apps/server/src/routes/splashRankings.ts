/**
 * Public homepage member-rankings endpoint.
 *
 * GET /rankings/splash — anonymous, rate-limited, 60s single-flight
 * cached. Feeds the marketing homepage's "Our members" marquee: every
 * leaderboard the earning system exposes (the nine main boards, the
 * scriptorium author + book boards, the social-game boards, and the
 * Eidolon familiar boards) compacted to a few rows each, plus two
 * activity boards computed here ("Most talkative today" / "Most
 * actions today", rolling 24h) and a randomly-rotating featured
 * member spotlight.
 *
 * Privacy posture (this is an ANONYMOUS page — strictest surface):
 *   - The earning boards arrive already privacy-shaped: private
 *     masters ride as identity-less `private: true` stubs (rendered
 *     as an italic "Private User"), disabled/banned accounts are
 *     dropped entirely (see earning/rankings.ts).
 *   - The today-boards computed here mask private AND incognito
 *     accounts the same way (an incognito user's aliased presence
 *     must not be undone by an activity board naming them).
 *   - The featured member is only ever a public, non-NSFW-flagged,
 *     adult, non-incognito account, and the card carries TYPED profile
 *     metadata only (counts, gender key, languages) — never free-form
 *     bio content, whose text-stripped form is unreadable for
 *     designer-built profiles.
 *
 * The compact row shape deliberately omits the cosmetic config blobs
 * (name-style / freeform-border JSON) the in-app rankings carry: the
 * homepage renders plain names + static rank sigils, keeping the
 * marketing page free of the perpetual cosmetic-animation repaint
 * cost and the injector bundle.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { characters, messages, users } from "../db/schema.js";
import { buildRankings, fetchDisplayInfo, type RankingPoolEntry } from "../earning/rankings.js";
import { buildGameRankings } from "../earning/gameRankings.js";
import { buildFamiliarRankings } from "../earning/familiarRankings.js";
import { buildScriptoriumRankings } from "../earning/scriptoriumRankings.js";

/** Rows per section — the marquee shows one section at a time, so a
 *  short podium reads better than a full in-app top-10. */
const TOP_ROWS = 6;
const SPLASH_RANKINGS_TTL_MS = 60_000;

export interface SplashRankingRow {
  /** Display name; empty string when `private`. */
  name: string;
  /** Identity-masked private account — render italic "Private User". */
  private?: true;
  avatarUrl: string | null;
  sigilImageUrl: string | null;
  rankName: string | null;
  /** When present, the row links to the public profile page
   *  `/p/<profileName>` (new tab). Absent for private rows and
   *  non-person rows (books). */
  profileName?: string | undefined;
  /** Secondary line (book byline, familiar owner, …). */
  subtitle?: string | undefined;
  value: number;
  /** How the client formats `value`:
   *  number (locale int), rating (2dp), hours (Nh), rankName (show
   *  rankName instead of the numeric encoding). */
  valueKind: "number" | "rating" | "hours" | "rankName";
}

export interface SplashRankingSection {
  /** Stable key the client translates (`memberRankings.boards.<key>`),
   *  falling back to `label` for auto-discovered game kinds. */
  key: string;
  /** English fallback label (the in-app boards' own labels). */
  label: string;
  /** English fallback metric label. */
  metric: string;
  rows: SplashRankingRow[];
}

export interface SplashFeaturedMember {
  name: string;
  avatarUrl: string | null;
  rankName: string | null;
  sigilImageUrl: string | null;
  /**
   * Structured profile metadata for the card's two-column grid. The
   * card deliberately shows TYPED fields rather than a bio excerpt:
   * designer-built bios are arbitrary HTML whose text-stripped form
   * reads as garbage (template labels run together), so free text
   * never rides this payload.
   */
  /** Account creation timestamp (ms). */
  memberSince: number;
  /** Lifetime chat messages, or null when the member hides the count. */
  messages: number | null;
  /** Lifetime forum topics + replies; null when either count is hidden. */
  forumPosts: number | null;
  /** Public, non-deleted characters. */
  characters: number;
  /** Profile gender, null when undisclosed (client translates the key). */
  gender: "male" | "female" | "nonbinary" | "other" | null;
  /** Roleplay languages, display order preserved. Empty = none set. */
  languages: string[];
}

export interface SplashRankingsResponse {
  sections: SplashRankingSection[];
  featured: SplashFeaturedMember | null;
  generatedAt: number;
}

const splashCache = new Map<Db, { at: number; promise: Promise<SplashRankingsResponse> }>();

export async function registerSplashRankingRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get(
    "/rankings/splash",
    // Anonymous + cached: the cache absorbs the cost, the cap absorbs
    // abuse. 60/min is far above the splash's one fetch per visit.
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async () => buildSplashRankings(db),
  );
}

/** Single-flight 60s cache, same posture as the earning builders it
 *  aggregates (their own 45s caches make a cold pass here cheap when
 *  anything else touched them recently). */
function buildSplashRankings(db: Db): Promise<SplashRankingsResponse> {
  const cached = splashCache.get(db);
  if (cached && Date.now() - cached.at < SPLASH_RANKINGS_TTL_MS) return cached.promise;
  const promise = computeSplashRankings(db);
  splashCache.set(db, { at: Date.now(), promise });
  promise.catch(() => splashCache.delete(db)); // don't memoize a failed pass
  return promise;
}

async function computeSplashRankings(db: Db): Promise<SplashRankingsResponse> {
  const [main, games, familiars, scriptorium, todayBoards, featured] = await Promise.all([
    buildRankings(db),
    buildGameRankings(db).catch(() => null),
    buildFamiliarRankings(db).catch(() => null),
    buildScriptoriumRankings(db).catch(() => null),
    buildTodayBoards(db),
    pickFeaturedMember(db).catch(() => null),
  ]);

  const sections: SplashRankingSection[] = [];

  // Today first: fresh, dynamic social proof leads the rotation.
  sections.push(...todayBoards);

  // The nine main boards (already masked/privacy-shaped upstream).
  for (const b of main.boards) {
    sections.push({
      key: b.key,
      label: b.label,
      metric: b.metric,
      rows: b.entries.slice(0, TOP_ROWS).map((e) => poolRow(e, b.key === "rank" ? "rankName" : "number")),
    });
  }

  if (scriptorium) {
    for (const b of scriptorium.authorBoards) {
      sections.push({
        key: `scriptorium-${b.key}`,
        label: b.label,
        metric: b.metric,
        rows: b.entries.slice(0, TOP_ROWS).map((e) => poolRow(e, "number")),
      });
    }
    for (const b of scriptorium.bookBoards) {
      sections.push({
        key: `scriptorium-${b.key}`,
        label: b.label,
        metric: b.metric,
        rows: b.entries.slice(0, TOP_ROWS).map((r) => ({
          name: r.title,
          avatarUrl: r.coverImageUrl,
          sigilImageUrl: null,
          rankName: null,
          subtitle: r.author.characterName ?? r.author.masterUsername,
          value: b.key === "rated" ? (r.avgRating ?? 0) : r.applauseCount,
          valueKind: b.key === "rated" ? ("rating" as const) : ("number" as const),
        })),
      });
    }
  }

  if (games) {
    if (games.overall.length > 0) {
      sections.push({
        key: "games-overall",
        label: "Game Champions",
        metric: "Wins",
        rows: games.overall.slice(0, TOP_ROWS).map((r) => ({
          name: r.displayName,
          avatarUrl: r.avatarUrl,
          sigilImageUrl: r.sigilImageUrl,
          rankName: r.rankName,
          profileName: r.displayName || undefined,
          value: r.totalWins,
          valueKind: "number" as const,
        })),
      });
    }
    for (const g of games.games) {
      if (g.leaderboard.length === 0) continue;
      sections.push({
        key: `games-${g.gameKind}`,
        label: g.label,
        metric: "Wins",
        rows: g.leaderboard.slice(0, TOP_ROWS).map((r) => ({
          name: r.displayName,
          avatarUrl: r.avatarUrl,
          sigilImageUrl: r.sigilImageUrl,
          rankName: r.rankName,
          profileName: r.displayName || undefined,
          value: r.wins,
          valueKind: "number" as const,
        })),
      });
    }
  }

  if (familiars) {
    const familiarBoards: Array<{ key: string; label: string; metric: string; rows: typeof familiars.byLevel; valueKind: SplashRankingRow["valueKind"] }> = [
      { key: "familiar-level", label: "Mightiest Eidolons", metric: "Level", rows: familiars.byLevel, valueKind: "number" },
      { key: "familiar-age", label: "Eldest Eidolons", metric: "Age", rows: familiars.byAge, valueKind: "hours" },
      { key: "familiar-streak", label: "Best Care Streaks", metric: "Days", rows: familiars.byStreak, valueKind: "number" },
    ];
    for (const fb of familiarBoards) {
      const alive = fb.rows.filter((r) => !r.dead).slice(0, TOP_ROWS);
      if (alive.length === 0) continue;
      sections.push({
        key: fb.key,
        label: fb.label,
        metric: fb.metric,
        rows: alive.map((r) => ({
          name: r.familiarName,
          avatarUrl: null,
          sigilImageUrl: null,
          rankName: null,
          subtitle: r.displayName,
          profileName: r.displayName || undefined,
          value: r.value,
          valueKind: fb.valueKind,
        })),
      });
    }
  }

  return {
    sections: sections.filter((s) => s.rows.length > 0),
    featured,
    generatedAt: Date.now(),
  };
}

/** Compact a (possibly masked) earning pool entry to a splash row. */
function poolRow(e: RankingPoolEntry, valueKind: SplashRankingRow["valueKind"]): SplashRankingRow {
  if (e.private) {
    return { name: "", private: true, avatarUrl: null, sigilImageUrl: null, rankName: null, value: e.value, valueKind };
  }
  return {
    name: e.displayName,
    avatarUrl: e.avatarUrl,
    sigilImageUrl: e.sigilImageUrl,
    rankName: e.rankName,
    profileName: e.displayName || undefined,
    value: e.value,
    valueKind,
  };
}

/* =========================================================
 *  "Today" boards — rolling 24h activity, computed here.
 * ========================================================= */

async function buildTodayBoards(db: Db): Promise<SplashRankingSection[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Two GROUP BY passes over the 24h window. No created_at index exists,
  // but /stats already does an equivalent 24h scan per request; here the
  // 60s cache bounds it to ~one pass per minute site-wide.
  const [talkRaw, actionRaw] = await Promise.all([
    db
      .select({ userId: messages.userId, n: sql<number>`count(*)` })
      .from(messages)
      .where(and(gt(messages.createdAt, since), sql`${messages.kind} not in ('system','whisper')`))
      .groupBy(messages.userId)
      .orderBy(desc(sql`count(*)`))
      .limit(TOP_ROWS + 6),
    db
      .select({ userId: messages.userId, n: sql<number>`count(*)` })
      .from(messages)
      .where(and(gt(messages.createdAt, since), eq(messages.kind, "me")))
      .groupBy(messages.userId)
      .orderBy(desc(sql`count(*)`))
      .limit(TOP_ROWS + 6),
  ]);

  const ids = [...new Set([...talkRaw, ...actionRaw].map((r) => r.userId))];
  const userRows = ids.length > 0
    ? await db
        .select({
          id: users.id,
          username: users.username,
          avatarUrl: users.avatarUrl,
          isPublic: users.isPublic,
          incognitoMode: users.incognitoMode,
          disabledAt: users.disabledAt,
        })
        .from(users)
        .where(inArray(users.id, ids))
    : [];
  const byId = new Map(userRows.map((u) => [u.id, u]));

  function stitch(raw: Array<{ userId: string; n: number }>): SplashRankingRow[] {
    const rows: SplashRankingRow[] = [];
    for (const r of raw) {
      if (rows.length >= TOP_ROWS) break;
      const u = byId.get(r.userId);
      if (!u || u.disabledAt) continue; // deleted/disabled → drop entirely
      if (u.username === "system") continue; // sentinel author of housekeeping rows
      // Private profiles AND incognito accounts mask: incognito hides a
      // person's presence in-app right now — a public "most talkative"
      // board naming them would undo exactly that.
      if (!u.isPublic || u.incognitoMode) {
        rows.push({ name: "", private: true, avatarUrl: null, sigilImageUrl: null, rankName: null, value: Number(r.n), valueKind: "number" });
        continue;
      }
      rows.push({
        name: u.username,
        avatarUrl: u.avatarUrl ?? null,
        sigilImageUrl: null,
        rankName: null,
        profileName: u.username,
        value: Number(r.n),
        valueKind: "number",
      });
    }
    return rows;
  }

  const out: SplashRankingSection[] = [];
  const talk = stitch(talkRaw);
  if (talk.length > 0) out.push({ key: "today-talkative", label: "Most Talkative Today", metric: "Messages", rows: talk });
  const actions = stitch(actionRaw);
  if (actions.length > 0) out.push({ key: "today-actions", label: "Most Actions Today", metric: "Actions", rows: actions });
  return out;
}

/* =========================================================
 *  Featured member spotlight.
 * ========================================================= */

/** ISO date (YYYY-MM-DD) exactly 18 years ago — the adult cutoff for
 *  users.birthdate string comparison. NULL birthdate = legacy account,
 *  grandfathered adult (age plan). */
function adultCutoffIso(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 18);
  return d.toISOString().slice(0, 10);
}

async function pickFeaturedMember(db: Db): Promise<SplashFeaturedMember | null> {
  const cutoff = adultCutoffIso();
  // Eligibility: public + non-NSFW-flagged profile, adult (or legacy),
  // enabled, not incognito, has a portrait. Prefer members who have
  // actually chatted, then rotate randomly — a new spotlight roughly
  // every cache TTL.
  const row = (await db
    .select({
      id: users.id,
      username: users.username,
      avatarUrl: users.avatarUrl,
      createdAt: users.createdAt,
      gender: users.gender,
      languages: users.languages,
      lifetimeChatMessages: users.lifetimeChatMessages,
      hideChatMessageCount: users.hideChatMessageCount,
      lifetimeForumTopics: users.lifetimeForumTopics,
      hideForumTopicCount: users.hideForumTopicCount,
      lifetimeForumReplies: users.lifetimeForumReplies,
      hideForumReplyCount: users.hideForumReplyCount,
    })
    .from(users)
    .where(and(
      isNull(users.disabledAt),
      eq(users.isPublic, true),
      eq(users.isNsfw, false),
      eq(users.incognitoMode, false),
      sql`${users.avatarUrl} IS NOT NULL AND ${users.avatarUrl} != ''`,
      sql`(${users.birthdate} IS NULL OR ${users.birthdate} <= ${cutoff})`,
      sql`${users.username} != 'system'`,
    ))
    .orderBy(sql`(${users.lifetimeChatMessages} <= 0) ASC, RANDOM()`)
    .limit(1))[0];
  if (!row) return null;

  // Rank display (name + sigil) through the same batched resolver the
  // leaderboards use — it re-checks privacy, so a race with the user
  // flipping private between the two queries degrades to "no rank shown".
  const display = (await fetchDisplayInfo(db, [{ scope: "user", ownerId: row.id }])).get(`user::${row.id}`);

  // Public, non-deleted characters — the card's "how much roleplay
  // lives here" signal.
  const charCount = Number((await db
    .select({ n: sql<number>`count(*)` })
    .from(characters)
    .where(and(eq(characters.userId, row.id), isNull(characters.deletedAt), eq(characters.isPublic, true))))[0]?.n ?? 0);

  return {
    name: row.username,
    avatarUrl: row.avatarUrl ?? null,
    rankName: display?.rankName ?? null,
    sigilImageUrl: display?.sigilImageUrl ?? null,
    memberSince: +row.createdAt,
    messages: row.hideChatMessageCount ? null : row.lifetimeChatMessages ?? 0,
    forumPosts: row.hideForumTopicCount || row.hideForumReplyCount
      ? null
      : (row.lifetimeForumTopics ?? 0) + (row.lifetimeForumReplies ?? 0),
    characters: charCount,
    gender: row.gender === "undisclosed" ? null : row.gender,
    languages: row.languages.split(",").map((l) => l.trim()).filter(Boolean),
  };
}
