/**
 * Per-message quality analysis for the award engine.
 *
 * Two outputs:
 *   1. `multiplier`, linear length bonus applied to the per-kind
 *      XP/Currency amount. Long thoughtful RP gets the bigger reward;
 *      short messages stay at base rate.
 *   2. `flaggedSpam`, heuristic flags that drop the award to zero.
 *      Catches the common keysmash / token-repeat / echo patterns
 *      without dinging legitimate short emphatic posts.
 *
 * Both behaviors are admin-tunable through `EarningConfig.messageQuality`
 * (see `config.ts`); pass `cfg.messageQuality` + the message kind in
 * and the helper does the rest.
 *
 * The echo cache is a per-user ring buffer kept in memory. Bounded by
 * `MAX_ECHO_CACHE_PER_USER` so a single chatty user can't blow memory;
 * server restarts wipe it (false negatives only, a user repeating
 * the exact same post 5 seconds after restart wouldn't be caught for
 * one cycle, then the next post primes the cache and detection resumes).
 */

import type { EarningConfig, LengthBonusSpec } from "./config.js";

/** Hard cap on the per-user echo buffer. Each entry is a trimmed
 *  body string; even at 1KB per message that's ~20KB per chatty user,
 *  which is bounded enough that 10k concurrent users is ~200MB, and
 *  the cfg knob only ever looks at the last N (default 3), so most
 *  installs sit much lower. */
const MAX_ECHO_CACHE_PER_USER = 20;

/** Per-user ring buffer of the most recently-awarded message bodies
 *  (trimmed + lowercased for case-insensitive echo match). Newest
 *  at the end. */
const echoCacheByUser = new Map<string, string[]>();

export interface QualityResult {
  /** Trimmed length used for multiplier + spam checks. */
  length: number;
  /** Multiplier to apply to xp + currency. 1.0 = base; <1 never
   *  emitted by this helper (the spam path returns flagged=true and
   *  the caller drops to 0). */
  multiplier: number;
  /** Drop the award to zero. Caller still writes a ledger row with
   *  this flag in metadata so admins can audit / tune. */
  flaggedSpam: boolean;
  /** Why the spam flag fired. Null when not flagged. Surfaced in
   *  ledger metadata for debugging. */
  spamReason: "echo" | "low_unique_chars" | "dominant_token" | null;
}

/**
 * Analyze a message body for length-bonus + spam. Pure aside from
 * the echo-cache write (which only happens when the message would
 * otherwise have been awarded, see caller).
 *
 *   cfg         , EarningConfig.messageQuality block
 *   spec        , the per-kind LengthBonusSpec (cfg.lengthBonus.say/action/whisper)
 *   userId      , for echo-cache keying
 *   body        , raw message body (we trim inside)
 */
export function analyzeMessageQuality(
  cfg: EarningConfig["messageQuality"],
  spec: LengthBonusSpec,
  userId: string,
  body: string,
): QualityResult {
  const trimmed = body.trim();
  const length = trimmed.length;
  const multiplier = computeLengthMultiplier(spec, length);

  // Spam checks. Order is cheapest-first: echo lookup is O(N) with N
  // tiny; unique-char ratio walks the body once; dominant-token
  // walks once for the split + a Map count.
  if (cfg.spam.enabled && length >= cfg.spam.minLengthToCheck) {
    if (cfg.spam.echoLookback > 0 && isEcho(userId, trimmed, cfg.spam.echoLookback)) {
      return { length, multiplier, flaggedSpam: true, spamReason: "echo" };
    }
    if (cfg.spam.uniqueCharRatioFloor > 0 && hasLowUniqueRatio(trimmed, cfg.spam.uniqueCharRatioFloor)) {
      return { length, multiplier, flaggedSpam: true, spamReason: "low_unique_chars" };
    }
    if (cfg.spam.dominantTokenRatioCap > 0 && hasDominantToken(trimmed, cfg.spam.dominantTokenRatioCap)) {
      return { length, multiplier, flaggedSpam: true, spamReason: "dominant_token" };
    }
  }
  return { length, multiplier, flaggedSpam: false, spamReason: null };
}

/**
 * Record a message body in the user's echo cache. Caller invokes this
 * AFTER deciding the message will be awarded, flagged-spam messages
 * intentionally don't poison the cache (otherwise an attacker could
 * spam once to lock everyone else out of saying the same thing later).
 */
export function recordAwardedMessage(userId: string, body: string): void {
  const trimmed = body.trim();
  if (trimmed.length === 0) return;
  const key = trimmed.toLowerCase();
  const buf = echoCacheByUser.get(userId) ?? [];
  buf.push(key);
  while (buf.length > MAX_ECHO_CACHE_PER_USER) buf.shift();
  echoCacheByUser.set(userId, buf);
}

/* ============================================================
 *  Helpers
 * ============================================================ */

/** Linear interp from (floor, 1.0x) to (ceil, max). Below floor =
 *  1.0x. Above ceil = max. Disabled or max<=1 = always 1.0x. */
function computeLengthMultiplier(spec: LengthBonusSpec, length: number): number {
  if (!spec.enabled || spec.maxMultiplier <= 1) return 1.0;
  if (spec.ceilChars <= spec.floorChars) return 1.0;
  if (length <= spec.floorChars) return 1.0;
  if (length >= spec.ceilChars) return spec.maxMultiplier;
  const range = spec.ceilChars - spec.floorChars;
  const above = length - spec.floorChars;
  return 1.0 + (spec.maxMultiplier - 1.0) * (above / range);
}

function isEcho(userId: string, body: string, lookback: number): boolean {
  const buf = echoCacheByUser.get(userId);
  if (!buf || buf.length === 0) return false;
  const key = body.toLowerCase();
  const start = Math.max(0, buf.length - lookback);
  for (let i = start; i < buf.length; i++) {
    if (buf[i] === key) return true;
  }
  return false;
}

/** unique-chars / total-chars ratio. Lowercased + whitespace-
 *  collapsed so "AAA" and "aaa  a" both count as 1 unique char
 *  over 3-4 chars. Whitespace itself is ignored in BOTH numerator
 *  and denominator so " ".repeat(50) doesn't pass the floor by
 *  hiding behind blanks. */
function hasLowUniqueRatio(body: string, floor: number): boolean {
  let total = 0;
  const seen = new Set<string>();
  for (const ch of body.toLowerCase()) {
    if (/\s/.test(ch)) continue;
    total += 1;
    seen.add(ch);
  }
  if (total === 0) return false;
  return seen.size / total < floor;
}

/** Largest token's share of total tokens > cap. Tokens are
 *  whitespace-split; punctuation IS stripped from each token so
 *  "spam!" and "spam." count as the same dominant token. */
function hasDominantToken(body: string, cap: number): boolean {
  const tokens = body
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter((t) => t.length > 0);
  if (tokens.length < 3) return false;
  const counts = new Map<string, number>();
  let max = 0;
  for (const t of tokens) {
    const next = (counts.get(t) ?? 0) + 1;
    counts.set(t, next);
    if (next > max) max = next;
  }
  return max / tokens.length > cap;
}

/* ============================================================
 *  Long-form (Scriptorium) spam detection.
 * ============================================================
 *
 * The chat spam path leans on a per-CHARACTER unique-ratio that's only
 * meaningful for short bodies — a long chapter always has a tiny
 * distinct-char/total ratio (the alphabet is finite), so that check would
 * flag every real chapter. For prose we instead look at WORD-level signals
 * that stay clean on genuine writing but spike on padding:
 *   - dominant token: one word is an outsized share of the text
 *     ("reward reward reward …").
 *   - low lexical diversity: distinct-words / total-words is tiny, which is
 *     what a sentence/paragraph pasted over and over to inflate the count
 *     looks like.
 * Returns the reason, or null when the prose looks legitimate. */
export function detectProseSpam(
  text: string,
  cfg: { minWords: number; dominantTokenRatioCap: number; uniqueWordRatioFloor: number },
): "dominant_token" | "low_lexical_diversity" | null {
  const tokens = text
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter((t) => t.length > 0);
  if (tokens.length < Math.max(3, cfg.minWords)) return null;
  const counts = new Map<string, number>();
  let max = 0;
  for (const t of tokens) {
    const next = (counts.get(t) ?? 0) + 1;
    counts.set(t, next);
    if (next > max) max = next;
  }
  if (cfg.dominantTokenRatioCap > 0 && max / tokens.length > cfg.dominantTokenRatioCap) {
    return "dominant_token";
  }
  if (cfg.uniqueWordRatioFloor > 0 && counts.size / tokens.length < cfg.uniqueWordRatioFloor) {
    return "low_lexical_diversity";
  }
  return null;
}

/* ============================================================
 *  Test helper, exposed for unit tests / admin debug only.
 * ============================================================ */

/** Drop the entire echo cache. Used by `admin/earning/reset-user`
 *  so a reset doesn't leave stale echoes attributed to the wiped
 *  user. */
export function clearEchoCacheFor(userId: string): void {
  echoCacheByUser.delete(userId);
}
