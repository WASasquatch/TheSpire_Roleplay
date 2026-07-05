/**
 * Builds the response payload for `GET /earning/game-rankings`.
 *
 * Reads the `game_stats` table populated by the social-game
 * resolvers (every call to `formatWinningsLine` records a row),
 * groups rows per game kind, and resolves owner_id back to a human
 * display name. Returns one leaderboard per game plus an "overall"
 * combined leaderboard.
 *
 * Game-kind labels are looked up from a small static table for the
 * known kinds; unknown kinds (e.g. a newly added social game) fall
 * back to a titlecased version of the kind string. Either way the
 * board surfaces immediately the moment data lands; no extra
 * registration step is required when adding a new game.
 */

import { eq } from "drizzle-orm";
import { gameStats } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { fetchDisplayInfo, type RankingPoolEntry, type RankingScope } from "./rankings.js";
import { DEFAULT_SERVER_ID } from "./pool.js";

const PER_GAME_LIMIT = 10;
const OVERALL_LIMIT = 20;

/** Friendly labels for known game kinds. New kinds without entries
 *  here fall back to titlecasing the kind string. */
const KNOWN_GAME_LABELS: Record<string, string> = {
  rps: "Rock-Paper-Scissors",
  trivia: "Trivia",
  storydice: "Story Dice",
  scramble: "Word Scramble",
  duel: "Duel",
  raffle: "Raffle",
};

function labelFor(gameKind: string): string {
  if (KNOWN_GAME_LABELS[gameKind]) return KNOWN_GAME_LABELS[gameKind]!;
  // Titlecase fallback: "newgame" -> "Newgame", "my-game" -> "My Game"
  return gameKind
    .split(/[-_\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Cosmetic display context shared by both row shapes, resolved via the
 * earning rankings' `fetchDisplayInfo` so social-game boards render with
 * the same avatar + border + name-style fidelity as the pool boards.
 * (Everything from a RankingPoolEntry except the per-board `value` and
 * the `scope`/`ownerId` we re-expose as `ownerScope`/`ownerId` below.)
 */
type GameRankingCosmetics = Omit<RankingPoolEntry, "value" | "scope" | "ownerId">;

export interface GameRankingRow extends GameRankingCosmetics {
  ownerScope: "user" | "character";
  ownerId: string;
  wins: number;
  points: number;
  lastWonAt: number;
}

export interface OverallRankingRow extends GameRankingCosmetics {
  ownerScope: "user" | "character";
  ownerId: string;
  totalWins: number;
  totalPoints: number;
}

export interface GameRankingsResponse {
  games: Array<{
    gameKind: string;
    label: string;
    leaderboard: GameRankingRow[];
  }>;
  overall: OverallRankingRow[];
}

/**
 * Short-TTL single-flight cache for the game-rankings build (mirrors
 * rankings.ts). The public route is per-IP rate-capped, but this full
 * `game_stats` scan + batched display-info fetch is process-global and
 * expensive; memoizing the in-flight Promise per db collapses a fleet of
 * pollers into ~1-2 passes per TTL and shares one query pass under
 * concurrent cold load. Keyed by db so a fresh test db never serves stale rows.
 */
const GAME_RANKINGS_TTL_MS = 45_000;
const gameRankingsCache = new Map<Db, { at: number; promise: Promise<GameRankingsResponse> }>();

export async function buildGameRankings(db: Db): Promise<GameRankingsResponse> {
  const cached = gameRankingsCache.get(db);
  if (cached && Date.now() - cached.at < GAME_RANKINGS_TTL_MS) return cached.promise;
  const promise = computeGameRankings(db);
  gameRankingsCache.set(db, { at: Date.now(), promise });
  promise.catch(() => gameRankingsCache.delete(db)); // don't memoize a failed pass
  return promise;
}

async function computeGameRankings(db: Db): Promise<GameRankingsResponse> {
  // Pull all rows in one query; the table is small enough (one row
  // per identity per game kind) that even a multi-thousand-player
  // site comes out in the low-megabyte range. Filtering / ranking
  // happens in memory below; the alternative (per-kind window-
  // function query) is more code without a real perf win at our
  // scale.
  const allRows = await db
    .select({
      ownerScope: gameStats.ownerScope,
      ownerId: gameStats.ownerId,
      gameKind: gameStats.gameKind,
      wins: gameStats.wins,
      points: gameStats.points,
      lastWonAt: gameStats.lastWonAt,
    })
    .from(gameStats)
    // Per-server economy: this pass surfaces the default (system) server's
    // game stats only (matches the rankings boards). Per-active-server is a
    // later pass; with the flag off this is the only server.
    .where(eq(gameStats.serverId, DEFAULT_SERVER_ID));

  if (allRows.length === 0) {
    return { games: [], overall: [] };
  }

  // Resolve the full cosmetic display context (avatar, border, name
  // style, rank tier) for every identity on the boards, reusing the
  // earning rankings' batched resolver so social-game rows render with
  // identical fidelity. `fetchDisplayInfo` also applies the privacy
  // gate (disabled / non-public masters + deleted characters are
  // omitted from the map), so a missing key means "drop this row" -
  // which both hides those identities AND replaces the old
  // deleted-character-only skip.
  const poolByKey = new Map<string, { scope: RankingScope; ownerId: string }>();
  for (const r of allRows) {
    poolByKey.set(`${r.ownerScope}::${r.ownerId}`, { scope: r.ownerScope, ownerId: r.ownerId });
  }
  const displayInfo = await fetchDisplayInfo(db, [...poolByKey.values()]);
  /** Cosmetic fields for a (scope, ownerId), or null when the identity
   *  is hidden (private/disabled/deleted) and the row should be dropped. */
  function cosmeticsFor(scope: "user" | "character", ownerId: string): GameRankingCosmetics | null {
    const info = displayInfo.get(`${scope}::${ownerId}`);
    if (!info) return null;
    const { scope: _s, ownerId: _o, ...cosmetics } = info;
    return cosmetics;
  }

  // Group rows by game kind for per-game boards.
  const byKind = new Map<string, GameRankingRow[]>();
  for (const r of allRows) {
    const cosmetics = cosmeticsFor(r.ownerScope, r.ownerId);
    if (!cosmetics) continue; // hidden identity, skip surface
    const row: GameRankingRow = {
      ownerScope: r.ownerScope,
      ownerId: r.ownerId,
      ...cosmetics,
      wins: r.wins,
      points: r.points,
      lastWonAt: r.lastWonAt instanceof Date ? +r.lastWonAt : Number(r.lastWonAt),
    };
    const arr = byKind.get(r.gameKind) ?? [];
    arr.push(row);
    byKind.set(r.gameKind, arr);
  }

  // Per-game leaderboards: sort by wins desc, points desc, recency
  // desc; truncate to the per-game limit.
  const games: GameRankingsResponse["games"] = [];
  for (const [gameKind, rows] of byKind) {
    rows.sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.points !== a.points) return b.points - a.points;
      return b.lastWonAt - a.lastWonAt;
    });
    games.push({
      gameKind,
      label: labelFor(gameKind),
      leaderboard: rows.slice(0, PER_GAME_LIMIT),
    });
  }
  // Stable, friendly ordering for the games list: known kinds first
  // (in catalog order), unknown kinds appended alphabetically.
  const knownOrder = Object.keys(KNOWN_GAME_LABELS);
  games.sort((a, b) => {
    const ai = knownOrder.indexOf(a.gameKind);
    const bi = knownOrder.indexOf(b.gameKind);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.label.localeCompare(b.label);
  });

  // Overall leaderboard: sum wins + points across all games per
  // identity. Read straight from the raw rows so the totals
  // include game kinds that didn't make their per-game top-N.
  const totalsByIdentity = new Map<string, OverallRankingRow>();
  for (const r of allRows) {
    const key = `${r.ownerScope}::${r.ownerId}`;
    const existing = totalsByIdentity.get(key);
    if (existing) {
      existing.totalWins += r.wins;
      existing.totalPoints += r.points;
    } else {
      const cosmetics = cosmeticsFor(r.ownerScope, r.ownerId);
      if (!cosmetics) continue; // hidden identity, skip surface
      totalsByIdentity.set(key, {
        ownerScope: r.ownerScope,
        ownerId: r.ownerId,
        ...cosmetics,
        totalWins: r.wins,
        totalPoints: r.points,
      });
    }
  }
  const overall = [...totalsByIdentity.values()]
    .sort((a, b) => {
      if (b.totalWins !== a.totalWins) return b.totalWins - a.totalWins;
      return b.totalPoints - a.totalPoints;
    })
    .slice(0, OVERALL_LIMIT);

  return { games, overall };
}
