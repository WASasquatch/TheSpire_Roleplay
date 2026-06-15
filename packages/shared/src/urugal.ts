/**
 * Urugal's Descent (Spire Arcade game #2) — shared constants, reward
 * curve, plausibility bounds, and wire types.
 *
 * Both the client (display / sending milestone events) and the server
 * (authoritative validation + crediting) import from here, so a single
 * source of truth governs what each milestone is worth, the hard daily
 * cap, and the bounds the server uses to reject implausible claims.
 *
 * The game itself is a vendored, untrusted client bundle (it only ever
 * *claims* progress); the server owns a run session and decides what to
 * pay. See plan.md and apps/server/src/routes/arcadeUrugal.ts.
 */

/** The one-time unlock cosmetic key (a "Flair" in the shop). Mirrors
 *  FLAIR_EIDOLON_TAMER. Wired as the purchase gate in a later phase. */
export const FLAIR_URUGAL_DESCENT = "flair_urugal_descent";

/** Display cost of the Urugal's Descent unlock. The real charge is
 *  server-side at purchase time (later phase). */
export const URUGAL_UNLOCK_COST = 2000;

/* ---------------------------------------------------------------------
 * Reward curve — deliberately modest, well below RP earning rates, and
 * hard daily-capped, so the game is a fun side-trickle and never
 * replaces roleplay as an income source. Tune here; both ends follow.
 * ------------------------------------------------------------------- */

/** Currency + XP awarded the FIRST time a run reaches a given floor.
 *  Gentle ramp: floor 1 → 2c, 5 → 3c, 10 → 5c, 20 → 8c. */
export function urugalFloorReward(floor: number): { currency: number; xp: number } {
  if (!Number.isFinite(floor) || floor < 1) return { currency: 0, xp: 0 };
  return { currency: 2 + Math.floor(floor / 3), xp: 1 + Math.floor(floor / 5) };
}

/** Bonus for CLEARING a boss floor (every 5th). boss@5 → 8c, @10 → 11c, @20 → 16c. */
export function urugalBossReward(floor: number): { currency: number; xp: number } {
  if (!Number.isFinite(floor) || floor < 1) return { currency: 0, xp: 0 };
  return { currency: 6 + Math.floor(floor / 2), xp: 3 + Math.floor(floor / 5) };
}

/** Hard ceiling on currency earned from this game per identity per UTC
 *  day. Sits well under the chat/presence daily cap on purpose. */
export const URUGAL_DAILY_CURRENCY_CAP = 150;

/* ---------------------------------------------------------------------
 * Plausibility bounds (server-enforced anti-abuse).
 * ------------------------------------------------------------------- */

/** Minimum elapsed wall-clock (ms) per floor reached, measured from the
 *  SERVER-recorded run start. Blocks "instant floor 99" claims without
 *  nitpicking genuinely fast play. floor N is only payable once
 *  (now - startedAt) >= N * this. */
export const URUGAL_MIN_MS_PER_FLOOR = 5_000;

/** Max floors a single `floor` event may advance past the last paid
 *  floor. The game's skip-exit can leap up to 5 boss-clamped floors, so
 *  allow a little headroom; anything larger is rejected as a bad claim. */
export const URUGAL_MAX_FLOOR_JUMP = 6;

/** A run with no events for this long is treated as abandoned and may be
 *  superseded by a new /start for the same identity. */
export const URUGAL_RUN_STALE_MS = 6 * 60 * 60 * 1000;

/* ---------------------------------------------------------------------
 * Wire types (client ↔ server).
 * ------------------------------------------------------------------- */

/** Milestone event kinds the server scores. (xp / levelup / death the
 *  bridge also emits are not rewarded server-side; death ends the run.) */
export type UrugalEventType = "floor" | "boss";

export interface UrugalStartResponse {
  runId: string;
}

export interface UrugalEventRequest {
  runId: string;
  type: UrugalEventType;
  floor: number;
}

export interface UrugalEventResponse {
  ok: boolean;
  /** Server's authoritative highest PAID floor after this event. */
  maxFloor: number;
  /** What this milestone was worth, after daily-cap clamping. */
  award: { currency: number; xp: number };
  /** True when the award was reduced (or zeroed) by the daily cap. */
  capped: boolean;
  /** Phase flag — false until reward crediting is switched on. */
  credited: boolean;
}
