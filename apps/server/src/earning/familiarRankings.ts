/**
 * Builds the payload for `GET /earning/familiar-rankings` — the Eidolon Tamer
 * leaderboards. Reads `eidolon_state` directly (no denormalized cache, so no
 * upsert hot-path and no write amplification), catches each familiar up to now
 * for live level/health/death, and resolves cosmetics + the privacy gate via
 * the shared `fetchDisplayInfo` (a missing entry = hidden identity = dropped).
 *
 * Four boards celebrate different play styles: highest level, oldest (longevity),
 * longest best-streak (daily devotion), and best-kept (current health, living
 * only). Living familiars sort above dormant ones, which carry a `dead` flag
 * (the lifeless/dormant state) for a 💤 badge.
 */
import { eq } from "drizzle-orm";
import { eidolonLevelFromXp } from "@thekeep/shared";
import { eidolonState } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { fetchDisplayInfo, type RankingPoolEntry } from "./rankings.js";
import { catchUp } from "./eidolon.js";
import { DEFAULT_SERVER_ID } from "./pool.js";

const LIMIT = 10;
type FamiliarCosmetics = Omit<RankingPoolEntry, "value" | "scope" | "ownerId">;

export interface FamiliarRankingRow extends FamiliarCosmetics {
  ownerScope: "user" | "character";
  ownerId: string;
  familiarName: string;
  kind: "species" | "pet";
  speciesId: string | null;
  dead: boolean;
  level: number;
  ageHours: number;
  bestStreak: number;
  health: number;
  /** The metric for the board this row was returned on. */
  value: number;
}

export interface FamiliarRankingsResponse {
  byLevel: FamiliarRankingRow[];
  byAge: FamiliarRankingRow[];
  byStreak: FamiliarRankingRow[];
  byHealth: FamiliarRankingRow[];
}

interface Base extends FamiliarCosmetics {
  ownerScope: "user" | "character";
  ownerId: string;
  familiarName: string;
  kind: "species" | "pet";
  speciesId: string | null;
  dead: boolean;
  level: number;
  ageHours: number;
  bestStreak: number;
  health: number;
}

/**
 * Short-TTL single-flight cache for the familiar-rankings build (mirrors
 * rankings.ts). The public route is per-IP rate-capped, but this full
 * `eidolon_state` scan + per-row `catchUp` decay + batched display-info fetch
 * is process-global; memoizing the in-flight Promise per db collapses a fleet
 * of pollers into ~1-2 passes per TTL. NOTE: this also freezes the live
 * `catchUp(now)` decay snapshot for up to the TTL, so level/health/ageHours on
 * the board can lag reality by ~45s. That's acceptable for a browse leaderboard
 * (the player's own live familiar view reads eidolon state on its own path);
 * don't "fix" the apparent staleness by dropping the cache. Keyed by db so a
 * fresh test db never serves another's rows.
 */
const FAMILIAR_RANKINGS_TTL_MS = 45_000;
const familiarRankingsCache = new Map<Db, { at: number; promise: Promise<FamiliarRankingsResponse> }>();

export async function buildFamiliarRankings(db: Db): Promise<FamiliarRankingsResponse> {
  const cached = familiarRankingsCache.get(db);
  if (cached && Date.now() - cached.at < FAMILIAR_RANKINGS_TTL_MS) return cached.promise;
  const promise = computeFamiliarRankings(db);
  familiarRankingsCache.set(db, { at: Date.now(), promise });
  promise.catch(() => familiarRankingsCache.delete(db)); // don't memoize a failed pass
  return promise;
}

async function computeFamiliarRankings(db: Db): Promise<FamiliarRankingsResponse> {
  // Per-server economy: default (system) server only this pass, matching the
  // other leaderboards. With the servers flag off this is the only server.
  const rows = await db.select().from(eidolonState).where(eq(eidolonState.serverId, DEFAULT_SERVER_ID));
  if (rows.length === 0) return { byLevel: [], byAge: [], byStreak: [], byHealth: [] };

  const now = Date.now();
  const displayInfo = await fetchDisplayInfo(db, rows.map((r) => ({ scope: r.ownerScope, ownerId: r.ownerId })));

  const base: Base[] = [];
  for (const r of rows) {
    const info = displayInfo.get(`${r.ownerScope}::${r.ownerId}`);
    if (!info) continue; // hidden / private / deleted identity — drop
    const { scope: _scope, ownerId: _ownerId, ...cosmetics } = info;
    const prog = catchUp(r, now);
    base.push({
      ...cosmetics,
      ownerScope: r.ownerScope,
      ownerId: r.ownerId,
      familiarName: r.name,
      kind: r.kind,
      speciesId: r.speciesId,
      dead: prog.dead,
      level: eidolonLevelFromXp(prog.xp),
      ageHours: prog.ageHours,
      bestStreak: r.bestStreak,
      health: prog.stats.health,
    });
  }

  // Living-first, then metric desc, then age desc as a tiebreaker.
  const board = (metric: (b: Base) => number, aliveOnly = false): FamiliarRankingRow[] =>
    base
      .filter((b) => !aliveOnly || !b.dead)
      .map((b) => ({ ...b, value: metric(b) }))
      .sort((a, b) => (Number(a.dead) - Number(b.dead)) || (b.value - a.value) || (b.ageHours - a.ageHours))
      .slice(0, LIMIT);

  return {
    byLevel: board((b) => b.level),
    byAge: board((b) => Math.floor(b.ageHours)),
    byStreak: board((b) => b.bestStreak),
    byHealth: board((b) => Math.round(b.health), true),
  };
}
