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

import { desc, eq, inArray, sql } from "drizzle-orm";
import { characters, gameStats, users } from "../db/schema.js";
import type { Db } from "../db/index.js";

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

export interface GameRankingRow {
  ownerScope: "user" | "character";
  ownerId: string;
  displayName: string;
  wins: number;
  points: number;
  lastWonAt: number;
}

export interface OverallRankingRow {
  ownerScope: "user" | "character";
  ownerId: string;
  displayName: string;
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

export async function buildGameRankings(db: Db): Promise<GameRankingsResponse> {
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
    .from(gameStats);

  if (allRows.length === 0) {
    return { games: [], overall: [] };
  }

  // Resolve display names. One pass over the result to collect the
  // unique (scope, id) pairs we need, then two batched lookups.
  const characterIds = new Set<string>();
  const userIds = new Set<string>();
  for (const r of allRows) {
    if (r.ownerScope === "character") characterIds.add(r.ownerId);
    else userIds.add(r.ownerId);
  }
  const nameByCharacter = new Map<string, string>();
  const nameByUser = new Map<string, string>();
  if (characterIds.size > 0) {
    const rows = await db
      .select({ id: characters.id, name: characters.name, deletedAt: characters.deletedAt })
      .from(characters)
      .where(inArray(characters.id, [...characterIds]));
    for (const c of rows) {
      // Skip deleted characters from the leaderboard, their wins
      // still count toward the overall row (we have no other key),
      // but the rendering side filters with `displayName === ""`.
      if (c.deletedAt) continue;
      nameByCharacter.set(c.id, c.name);
    }
  }
  if (userIds.size > 0) {
    const rows = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    for (const u of rows) nameByUser.set(u.id, u.username);
  }
  function resolveName(scope: "user" | "character", ownerId: string): string {
    if (scope === "character") return nameByCharacter.get(ownerId) ?? "";
    return nameByUser.get(ownerId) ?? "";
  }

  // Group rows by game kind for per-game boards.
  const byKind = new Map<string, GameRankingRow[]>();
  for (const r of allRows) {
    const displayName = resolveName(r.ownerScope, r.ownerId);
    if (!displayName) continue; // deleted identity, skip surface
    const row: GameRankingRow = {
      ownerScope: r.ownerScope,
      ownerId: r.ownerId,
      displayName,
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
    const displayName = resolveName(r.ownerScope, r.ownerId);
    if (!displayName) continue;
    const key = `${r.ownerScope}:${r.ownerId}`;
    const existing = totalsByIdentity.get(key);
    if (existing) {
      existing.totalWins += r.wins;
      existing.totalPoints += r.points;
    } else {
      totalsByIdentity.set(key, {
        ownerScope: r.ownerScope,
        ownerId: r.ownerId,
        displayName,
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
