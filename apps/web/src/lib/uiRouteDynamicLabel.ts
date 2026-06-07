/**
 * Dynamic UI-route chip resolution.
 *
 * Some `{token}` chips resolve their label (and sometimes their click
 * target) at render time rather than from the static catalog:
 *   - {scriptorium:latest:story} → the latest published story's title
 *   - {users:latest} / {users:character:latest} → the newest member's name
 *   - {ranking:<board>} → "<Board>: <#1 ranked member>"
 *
 * Both render surfaces (the React chip in markdown.tsx and the HTML
 * hydrator in hydrateDynamicUiRouteChips.ts) call {@link resolveDynamicChipLabel}
 * so adding a new dynamic chip is one `case` here plus one entry in the
 * shared `dynamicMarkerFor`. Fetches are TTL-cached + coalesced so a
 * page full of chips doesn't N+1 the server; the `random` member pick
 * is deliberately NOT cached so it re-rolls on every click.
 */

import type { UiRoute, UiRouteRankingBoard } from "@thekeep/shared";
import { fetchLatestPublishedStory } from "./latestStory.js";
import { fetchRankings, type RankingsResponse } from "./earning.js";

const TTL_MS = 30_000;

/* ---------- member spotlight ---------- */

export interface SpotlightMember {
  /** Identity token for `profile:fetch` (username, or `@cid:<id>`). */
  token: string;
  displayName: string;
}

interface MemberCell {
  result: SpotlightMember | null;
  expiresAt: number;
  inFlight: Promise<SpotlightMember | null> | null;
}
// One cache cell per scope, for the `latest` picks only.
const latestMemberCache = new Map<"user" | "character", MemberCell>();

async function requestSpotlight(scope: "user" | "character", pick: "latest" | "random"): Promise<SpotlightMember | null> {
  try {
    const r = await fetch(`/members/spotlight?scope=${scope}&pick=${pick}`, { credentials: "include" });
    if (!r.ok) return null;
    const j = (await r.json()) as { member?: SpotlightMember | null };
    return j.member ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a member to spotlight. `latest` is TTL-cached + coalesced per
 * scope; `random` is never cached so each call (label render + click)
 * re-rolls a fresh pick.
 */
export async function fetchSpotlightMember(
  scope: "user" | "character",
  pick: "latest" | "random",
): Promise<SpotlightMember | null> {
  if (pick === "random") return requestSpotlight(scope, "random");
  const now = Date.now();
  const cell = latestMemberCache.get(scope);
  if (cell) {
    if (cell.result !== null && now < cell.expiresAt) return cell.result;
    if (cell.inFlight) return cell.inFlight;
  }
  const inFlight = (async () => {
    const result = await requestSpotlight(scope, "latest");
    latestMemberCache.set(scope, { result, expiresAt: Date.now() + TTL_MS, inFlight: null });
    return result;
  })();
  latestMemberCache.set(scope, { result: cell?.result ?? null, expiresAt: cell?.expiresAt ?? 0, inFlight });
  return inFlight;
}

/* ---------- top-ranked (for {ranking:<board>} labels) ---------- */

let rankingsCell: { result: RankingsResponse | null; expiresAt: number; inFlight: Promise<RankingsResponse | null> | null } = {
  result: null,
  expiresAt: 0,
  inFlight: null,
};

async function getRankingsCached(): Promise<RankingsResponse | null> {
  const now = Date.now();
  if (rankingsCell.result !== null && now < rankingsCell.expiresAt) return rankingsCell.result;
  if (rankingsCell.inFlight) return rankingsCell.inFlight;
  rankingsCell.inFlight = (async () => {
    try {
      const r = await fetchRankings();
      rankingsCell = { result: r, expiresAt: Date.now() + TTL_MS, inFlight: null };
      return r;
    } catch {
      rankingsCell.inFlight = null;
      return null;
    }
  })();
  return rankingsCell.inFlight;
}

/** Display name of the #1 entry on a board, or null when empty. */
export async function fetchTopRankedName(board: UiRouteRankingBoard): Promise<string | null> {
  const r = await getRankingsCached();
  return r?.boards.find((b) => b.key === board)?.entries[0]?.displayName ?? null;
}

/* ---------- unified resolver ---------- */

/**
 * Resolve the dynamic label for a chip, or null to keep the static
 * catalog label. Only called for chips `dynamicMarkerFor` flagged.
 */
export async function resolveDynamicChipLabel(entry: UiRoute): Promise<string | null> {
  const t = entry.target;
  switch (t.kind) {
    case "nav-scriptorium-latest-story": {
      const s = await fetchLatestPublishedStory();
      return s?.title ?? null;
    }
    case "open-member": {
      // Only `latest` resolves to a stable name; `random` keeps its
      // static label (it re-rolls each click).
      if (t.pick !== "latest") return null;
      const m = await fetchSpotlightMember(t.scope, t.pick);
      return m?.displayName ?? null;
    }
    case "modal-earning": {
      if (!t.board) return null;
      const top = await fetchTopRankedName(t.board);
      // Keep the board name as context: "Wealthiest: Kaal".
      return top ? `${entry.label}: ${top}` : null;
    }
    default:
      return null;
  }
}
