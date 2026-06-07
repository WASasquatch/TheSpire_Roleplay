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
import { eidolonLevelFromXp } from "@thekeep/shared";
import { eidolonState } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { fetchDisplayInfo, type RankingPoolEntry } from "./rankings.js";
import { catchUp } from "./eidolon.js";

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

export async function buildFamiliarRankings(db: Db): Promise<FamiliarRankingsResponse> {
  const rows = await db.select().from(eidolonState);
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
