/**
 * Earning, Zustand slice + hooks.
 *
 * Holds the cached `/earning/me` snapshot, a live-updated wallet on
 * `earning:earned` socket events, and the unacknowledged rank-up
 * queue that the ribbon and dashboard read from.
 *
 * Mounts as a thin layer over the fetch helpers in `lib/earning.ts`.
 * Socket subscription is wired in App.tsx (alongside every other
 * `socket.on()`); this module exposes the `applyEarned` /
 * `applyRankUp` / `dismissRankUp` actions the listener calls.
 *
 * Why a separate store (instead of folding into `useChat`):
 *   - Cleaner unmount/remount on logout. The Earning slice can be
 *     reset wholesale by calling `useEarning.setState(INITIAL)`.
 *   - The dashboard isn't always mounted; keeping state out of
 *     `useChat` avoids re-rendering chat consumers on every
 *     `earning:earned` event.
 */

import { create } from "zustand";
import type {
  PoolView,
  RankRow,
  RankTierRow,
  RankUpRecord,
  EarningMeResponse,
} from "../lib/earning.js";
import {
  ackRankUpNotification,
  fetchEarningMe,
} from "../lib/earning.js";

/**
 * Fetch `/earning/me` for a specific server (Multi-Server Lift). When
 * `serverId` is null/empty the URL is the LITERAL `/earning/me` — byte-
 * identical to the legacy {@link fetchEarningMe} path — so a flag-off /
 * no-server context hits today's exact endpoint and behavior. When a
 * server is active the id rides as `?serverId=<id>` and the server
 * returns that server's pool in the same field shape.
 *
 * Lives here (the state slice) rather than in `lib/earning.ts` so the
 * per-server read threading stays inside the dashboard's own file set;
 * it reuses the exported `fetchEarningMe` for the unscoped path and only
 * inlines the scoped fetch.
 */
async function fetchEarningMeForServer(
  serverId: string | null | undefined,
): Promise<EarningMeResponse> {
  if (!serverId) return fetchEarningMe();
  const r = await fetch(`/earning/me?serverId=${encodeURIComponent(serverId)}`, {
    credentials: "include",
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(msg || `Request failed (${r.status}).`);
  }
  return (await r.json()) as EarningMeResponse;
}

interface EarningState {
  /** True while the first /earning/me fetch is in flight. */
  loading: boolean;
  /** Last load error message, if any. Cleared on successful fetch. */
  error: string | null;
  /** Last successful snapshot. null = never loaded yet. */
  snapshot: EarningMeResponse | null;
  /** Unacknowledged rank-up notifications, newest first. */
  unackRankUps: RankUpRecord[];
  /**
   * Monotonic counter bumped every time `applyEarned` fires. Surfaced
   * so the Activity (ledger) tab can refetch its first page when a
   * new credit lands, the ledger endpoint isn't push-based, but
   * keying a useEffect off this tick keeps the feed in sync with the
   * live wallet without a manual reload. Initialized at 0; only the
   * delta matters to listeners.
   */
  earnedTick: number;

  /**
   * Trigger a fresh fetch. Safe to call multiple times, guards against
   * overlap. Pass the active `serverId` (Multi-Server Lift) to scope the
   * snapshot to that server's economy; omit it (or pass null) for the
   * legacy unscoped `/earning/me` read used flag-off / when no server is
   * resolved.
   */
  refresh: (serverId?: string | null) => Promise<void>;
  /** Reset to initial state (call on logout). */
  reset: () => void;

  /** Apply a `earning:earned` socket payload, updating the relevant pool live. */
  applyEarned: (payload: {
    scope: "user" | "character";
    ownerId: string;
    xpDelta: number;
    currencyDelta: number;
    xpTotal: number;
    currencyTotal: number;
    rankKey: string | null;
    tier: number | null;
  }) => void;

  /** Apply a `earning:rankup` socket payload; pushes to the unack queue. */
  applyRankUp: (payload: {
    notificationId: string;
    scope: "user" | "character";
    characterId: string | null;
    fromRankKey: string | null;
    fromTier: number | null;
    toRankKey: string;
    toTier: number;
    newlyEligibleBorderKeys: string[];
  }) => void;

  /**
   * Dismiss a single rank-up by id (POST the ack + drop from local
   * queue). Fire-and-forget, UI optimistically removes; an ack
   * failure logs but doesn't restore the entry.
   */
  dismissRankUp: (notificationId: string) => Promise<void>;
  /** Dismiss every queued rank-up. */
  dismissAllRankUps: () => Promise<void>;
}

const INITIAL = {
  loading: false,
  error: null,
  snapshot: null,
  unackRankUps: [],
  earnedTick: 0,
};

let inFlight: Promise<void> | null = null;

export const useEarning = create<EarningState>((set, get) => ({
  ...INITIAL,

  refresh: async (serverId?: string | null) => {
    // Coalesce concurrent calls, multiple components mounting at the
    // same time should share one network round trip.
    if (inFlight) return inFlight;
    set({ loading: true, error: null });
    inFlight = (async () => {
      try {
        const snap = await fetchEarningMeForServer(serverId);
        set({
          snapshot: snap,
          unackRankUps: snap.notifications,
          loading: false,
          error: null,
        });
      } catch (err) {
        set({
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load Earning.",
        });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },

  reset: () => set({ ...INITIAL }),

  applyEarned: (payload) => {
    // Bump the live-tick regardless of whether we have a snapshot,
    // the Activity tab listens for it to refetch its page, and that
    // path should run on cold-cache states too (e.g. brand-new
    // character whose snapshot hasn't loaded yet but is already
    // accruing credits in the background).
    const earnedTick = get().earnedTick + 1;
    const snap = get().snapshot;
    if (!snap) {
      set({ earnedTick });
      return;
    }
    if (payload.scope === "user") {
      if (snap.master.ownerId !== payload.ownerId) {
        set({ earnedTick });
        return;
      }
      set({
        snapshot: {
          ...snap,
          master: applyToPool(snap.master, payload),
        },
        earnedTick,
      });
      return;
    }
    // Character scope: find the matching character entry and update it.
    const idx = snap.characters.findIndex((c) => c.ownerId === payload.ownerId);
    if (idx === -1) {
      set({ earnedTick });
      return;
    }
    const updated = [...snap.characters];
    updated[idx] = applyToPool(updated[idx]!, payload);
    set({ snapshot: { ...snap, characters: updated }, earnedTick });
  },

  applyRankUp: (payload) => {
    const queued = get().unackRankUps;
    // Dedupe by notification id so a socket race + a /earning/me
    // refetch don't double-queue the same event.
    if (queued.some((q) => q.id === payload.notificationId)) return;
    const record: RankUpRecord = {
      id: payload.notificationId,
      scope: payload.scope,
      characterId: payload.characterId,
      fromRankKey: payload.fromRankKey,
      fromTier: payload.fromTier,
      toRankKey: payload.toRankKey,
      toTier: payload.toTier,
      newlyEligibleBorderKeys: [...payload.newlyEligibleBorderKeys],
      createdAt: Date.now(),
    };
    set({ unackRankUps: [record, ...queued] });
  },

  dismissRankUp: async (notificationId) => {
    // Optimistic remove first so the ribbon disappears immediately;
    // ack errors stay in the console.
    set({ unackRankUps: get().unackRankUps.filter((n) => n.id !== notificationId) });
    try {
      await ackRankUpNotification(notificationId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[earning] ack failed", err);
    }
  },

  dismissAllRankUps: async () => {
    set({ unackRankUps: [] });
    try {
      await ackRankUpNotification();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[earning] ack-all failed", err);
    }
  },
}));

function applyToPool(
  pool: PoolView,
  payload: {
    xpDelta: number;
    currencyDelta: number;
    xpTotal: number;
    currencyTotal: number;
    rankKey: string | null;
    tier: number | null;
  },
): PoolView {
  // Prefer the server-authoritative totals if they came through; fall
  // back to incrementing locally if the engine ever emits deltas
  // without totals (shouldn't happen with the current shape but it's
  // cheap insurance).
  const xp = Number.isFinite(payload.xpTotal) ? payload.xpTotal : pool.xp + payload.xpDelta;
  const currency = Number.isFinite(payload.currencyTotal)
    ? payload.currencyTotal
    : Math.max(0, pool.currency + payload.currencyDelta);
  return {
    ...pool,
    xp,
    currency,
    rankKey: payload.rankKey,
    tier: payload.tier,
  };
}

/**
 * Resolve a (rankKey, tier) tuple to its display fields using the
 * cached catalog from the snapshot. Returns nulls when the snapshot
 * isn't loaded or the lookup misses, the caller renders gracefully.
 */
export function lookupRankTier(
  snap: EarningMeResponse | null,
  rankKey: string | null,
  tier: number | null,
): { rank: RankRow | null; tierRow: RankTierRow | null } {
  if (!snap || !rankKey || tier == null) return { rank: null, tierRow: null };
  const rank = snap.catalog.ranks.find((r) => r.key === rankKey) ?? null;
  const tierRow = snap.catalog.rankTiers.find((t) => t.rankKey === rankKey && t.tier === tier) ?? null;
  return { rank, tierRow };
}

/**
 * Compute the (xp progress, xp to next, percentage) tuple for a pool's
 * progress bar, finds the next-higher tier in the catalog and reports
 * progress between the current tier's threshold and that one. Returns
 * null when the pool is at the catalog's top tier (no "next").
 */
export function progressToNextTier(
  snap: EarningMeResponse | null,
  pool: PoolView,
): { inTier: number; tierSpan: number; pct: number; nextLabel: string | null } | null {
  if (!snap || !pool.rankKey || pool.tier == null) {
    // Below the first tier, find the lowest tier and report progress
    // toward it.
    const tiers = snap?.catalog.rankTiers ?? [];
    const lowest = [...tiers]
      .filter((t) => t.enabled)
      .sort((a, b) => a.xpThreshold - b.xpThreshold)[0];
    if (!lowest) return null;
    const lowestRank = snap?.catalog.ranks.find((r) => r.key === lowest.rankKey);
    return {
      inTier: pool.xp,
      tierSpan: lowest.xpThreshold,
      pct: Math.max(0, Math.min(1, pool.xp / Math.max(1, lowest.xpThreshold))),
      nextLabel: lowestRank ? `${lowestRank.name} ${lowest.label}` : null,
    };
  }
  // Find current tier row + the next higher one (by xpThreshold).
  const tiers = [...snap.catalog.rankTiers]
    .filter((t) => t.enabled)
    .sort((a, b) => a.xpThreshold - b.xpThreshold);
  const currentIdx = tiers.findIndex((t) => t.rankKey === pool.rankKey && t.tier === pool.tier);
  if (currentIdx === -1) return null;
  const current = tiers[currentIdx]!;
  const next = tiers[currentIdx + 1];
  if (!next) return null;
  const inTier = pool.xp - current.xpThreshold;
  const tierSpan = next.xpThreshold - current.xpThreshold;
  const pct = Math.max(0, Math.min(1, tierSpan > 0 ? inTier / tierSpan : 1));
  const nextRank = snap.catalog.ranks.find((r) => r.key === next.rankKey);
  const nextLabel = nextRank ? `${nextRank.name} ${next.label}` : null;
  return { inTier, tierSpan, pct, nextLabel };
}
