/**
 * Grimhold (Spire Arcade game #3) — a vendored cabinet of six small
 * score-based canvas games. Shared constants, per-game reward curve,
 * plausibility bounds, and wire types. Both client and server import
 * from here so a single source of truth governs payouts + caps.
 *
 * Like Urugal's Descent, the game is a vendored, UNTRUSTED static bundle
 * (apps/web/public/games/grimhold). It only ever *claims* a final score
 * per game; the server clamps each claim to a per-game sane maximum,
 * requires a minimum play time, caps per-run currency, and enforces a
 * hard per-UTC-day cap shared across all six games. Client scores stay
 * spoofable up to those bounds; the daily cap is what bounds the damage.
 */

/** One-time unlock cosmetic key (a "Flair" in the shop), gates all six
 *  games. Mirrors FLAIR_URUGAL_DESCENT. */
export const FLAIR_GRIMHOLD = "flair_grimhold";

/** Display cost of the cabinet unlock. Real charge is the `cosmetics`
 *  row cost, server-side at purchase time; keep the two in sync. */
export const GRIMHOLD_UNLOCK_COST = 3000;

/** The six games, keyed by the bundle's internal registry keys. */
export type GrimholdGame = "tetris" | "snake" | "archer" | "spire" | "graveward" | "voidwake";

export interface GrimholdGameConfig {
  /** Display title (matches the bundle's GAMES registry). */
  title: string;
  /** Scores above this are clamped before reward, an anti-spoof ceiling
   *  set generously above realistic high scores per game. */
  maxScore: number;
  /** Score points per 1 currency. Tuned per game so a strong run pays a
   *  similar modest trickle across the cabinet. Higher = stingier. */
  perCurrency: number;
}

/** Per-game tuning. The scales differ wildly (Tetris line-clear points
 *  vs. Snake's +10/orb), so each game gets its own divisor + clamp.
 *  Deliberately conservative; the daily cap is the real ceiling. */
export const GRIMHOLD_GAMES: Record<GrimholdGame, GrimholdGameConfig> = {
  tetris:    { title: "Runefall",   maxScore: 150_000, perCurrency: 240 },
  snake:     { title: "Loong",      maxScore: 12_000,  perCurrency: 18 },
  archer:    { title: "Arrowstorm", maxScore: 60_000,  perCurrency: 100 },
  spire:     { title: "The Spire",  maxScore: 30_000,  perCurrency: 18 },
  graveward: { title: "Graveward",  maxScore: 40_000,  perCurrency: 60 },
  voidwake:  { title: "Voidwake",   maxScore: 60_000,  perCurrency: 100 },
};

export function isGrimholdGame(key: string): key is GrimholdGame {
  return Object.prototype.hasOwnProperty.call(GRIMHOLD_GAMES, key);
}

/** Most currency a single game-over can pay, regardless of score, so one
 *  monster run can't dump the whole daily cap at once (paces earning
 *  across several games / sittings). */
export const GRIMHOLD_MAX_CURRENCY_PER_RUN = 75;

/** Hard per-identity per-UTC-day currency ceiling across ALL six games. */
export const GRIMHOLD_DAILY_CURRENCY_CAP = 500;

/** A score claim for a game that "lasted" less than this is rejected as
 *  implausible (blocks instant-score spoofs). Genuinely fast deaths
 *  score near zero anyway, so this costs real play nothing. */
export const GRIMHOLD_MIN_PLAY_MS = 3_000;

/** Minimum wall-clock between two scored submissions on one run, a light
 *  rate-limit so a script can't spam game-overs. */
export const GRIMHOLD_MIN_MS_BETWEEN_SCORES = 3_000;

/** A run with no activity for this long is considered abandoned. */
export const GRIMHOLD_RUN_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * Reward for a finished game. `score` is clamped to the game's `maxScore`,
 * divided by `perCurrency`, then capped at {@link GRIMHOLD_MAX_CURRENCY_PER_RUN}.
 * XP is granted 1:1 with currency. Returns zero for unknown games or
 * sub-threshold play (caller checks play time).
 */
export function grimholdReward(game: string, score: number): { currency: number; xp: number } {
  if (!isGrimholdGame(game) || !Number.isFinite(score) || score <= 0) return { currency: 0, xp: 0 };
  const cfg = GRIMHOLD_GAMES[game];
  const clamped = Math.min(Math.max(0, Math.floor(score)), cfg.maxScore);
  const currency = Math.min(Math.floor(clamped / cfg.perCurrency), GRIMHOLD_MAX_CURRENCY_PER_RUN);
  if (currency <= 0) return { currency: 0, xp: 0 };
  // XP tracks currency 1:1 — a real run should feel like real progress.
  const xp = currency;
  return { currency, xp };
}

/* ---------------------------------------------------------------------
 * Wire types (client ↔ server).
 * ------------------------------------------------------------------- */

export interface GrimholdStartResponse {
  runId: string;
}

export interface GrimholdScoreRequest {
  runId: string;
  game: GrimholdGame;
  score: number;
  /** Game-reported play duration (ms) for the just-finished game. */
  elapsedMs: number;
  characterId?: string | null;
}

export interface GrimholdScoreResponse {
  ok: boolean;
  award: { currency: number; xp: number };
  /** True when the daily cap clipped the payout. */
  capped: boolean;
  credited: boolean;
}
