/**
 * Escalating chat anti-spam ladder.
 *
 * The base per-user rate limit in `dispatch.ts` is a coarse always-on cap
 * (`RATE_MAX` = 12 msgs / 10s for ordinary users). This is the sharper,
 * admin-toggled layer that catches a genuine SUSTAINED flood - traffic that
 * goes BEYOND the base cap - and escalates through warnings into an automatic
 * mute, so a raid or a copy-paste bot can't blow out a room while the mods are
 * offline.
 *
 * Crucially this is an ESCALATION layer, not a stricter first gate: anti-spam
 * runs AFTER the base rate limit in `dispatch.ts`, so it only ever counts
 * messages the base cap already allowed. Its burst threshold therefore sits
 * ABOVE that cap (`burstMax` = 19 inside a 10s window, i.e. a strike on the
 * 20th message) so a normal fast-but-legal chatter - who the base limiter
 * already holds to 12/10s - can NEVER be warned or muted here. Only a client
 * exceeding the base rate (a bot, a spoofed sender, or the base cap raised)
 * ever trips a strike.
 *
 * Shape of the ladder (all tunable via the config below):
 *   - A user may send up to `burstMax` messages inside `burstWindowMs`. The
 *     next one in that window is a "strike" (a flood beyond the base cap).
 *   - Each strike issues a warning AND a short cooldown "block". The block
 *     GROWS with every strike (10s → 20s → 40s), so continuing after a block
 *     costs more each time.
 *   - After `warningsBeforeMute` warnings, the next strike is an automatic
 *     mute (5m), and the mute duration GROWS on repeat offenders (5m → 10m →
 *     20m …, capped).
 *   - Calm resets it: after `resetMs` of no strikes the warning + block ladder
 *     resets, and after `muteDecayMs` with no mute the mute-escalation resets,
 *     so an ordinary fast-typing burst never slowly accretes into a mute.
 *
 * State is in-memory (per process) exactly like the base rate limiter. Only the
 * resulting mute is persisted (in the `mutes` table), so a restart forgives the
 * escalation counters but a live 5m mute still stands.
 *
 * The core (`stepAntiSpam`) is a pure function of (state, now, config) so the
 * escalation logic can be unit-tested without timers - auto-muting real users
 * is unforgiving, so the ladder is covered by tests.
 */

export interface AntiSpamConfig {
  /**
   * Messages allowed inside the window before a strike. Set ABOVE the base
   * `dispatch.ts` rate cap (12 / 10s) so a legal fast chatter, already held by
   * that cap, never trips this layer - a strike means a flood beyond the base.
   */
  burstMax: number;
  /** Sliding window for the burst count. Matched to the base rate window (10s). */
  burstWindowMs: number;
  /** Warnings issued before the next strike escalates to a mute. */
  warningsBeforeMute: number;
  /** First cooldown-block length; doubles each strike. */
  blockBaseMs: number;
  /** Cap on the cooldown-block length. */
  blockMaxMs: number;
  /** First automatic mute length; doubles each repeat mute. */
  muteBaseMs: number;
  /** Cap on the automatic mute length. */
  muteMaxMs: number;
  /** No strikes for this long resets the warning + block ladder. */
  resetMs: number;
  /** No mute for this long resets the mute-escalation. */
  muteDecayMs: number;
}

export const DEFAULT_ANTI_SPAM_CONFIG: AntiSpamConfig = {
  // A strike lands on the 20th message inside 10s. The base rate limit
  // (12 / 10s) already stops ordinary users well short of this, so anti-spam
  // only fires on a flood that exceeds the base cap - never on legal traffic.
  burstMax: 19,
  burstWindowMs: 10_000,
  warningsBeforeMute: 3,
  blockBaseMs: 10_000,
  blockMaxMs: 5 * 60_000,
  muteBaseMs: 5 * 60_000,
  muteMaxMs: 60 * 60_000,
  // No strikes for a stretch a few burst-windows long resets the ladder.
  resetMs: 60_000,
  muteDecayMs: 30 * 60_000,
};

export interface SpamState {
  /** Timestamps of recent messages, trimmed to the burst window. */
  hits: number[];
  /** Warnings accrued in the current (un-decayed) cycle. */
  warnings: number;
  /** How many strikes have blocked them (drives the growing block length). */
  blockLevel: number;
  /** How many times auto-muted (drives the growing mute length). */
  muteCount: number;
  /** Epoch ms until which sends are rejected (an active cooldown block). */
  blockedUntil: number;
  /** Last strike time, for the warning/block decay. */
  lastStrikeAt: number;
  /** Last auto-mute time, for the mute-escalation decay. */
  lastMuteAt: number;
}

export function freshSpamState(): SpamState {
  return {
    hits: [],
    warnings: 0,
    blockLevel: 0,
    muteCount: 0,
    blockedUntil: 0,
    lastStrikeAt: 0,
    lastMuteAt: 0,
  };
}

export type SpamVerdict =
  | { action: "allow" }
  | { action: "blocked"; retryMs: number }
  | { action: "warn"; warning: number; limit: number; blockMs: number }
  | { action: "mute"; muteMs: number };

/**
 * Advance the ladder by one message. MUTATES `state` and returns the verdict.
 * Pure w.r.t. (state, now, cfg) - no clock, no globals - so it's testable.
 */
export function stepAntiSpam(state: SpamState, now: number, cfg: AntiSpamConfig): SpamVerdict {
  // Decay after a calm stretch so an ordinary fast-typing burst doesn't slowly
  // accumulate into a mute over a long, well-behaved session.
  if (state.lastStrikeAt && now - state.lastStrikeAt > cfg.resetMs) {
    state.warnings = 0;
    state.blockLevel = 0;
  }
  if (state.lastMuteAt && now - state.lastMuteAt > cfg.muteDecayMs) {
    state.muteCount = 0;
  }

  // Serving an escalating cooldown: reject without recording a hit, so
  // hammering during the block neither counts nor extends it.
  if (state.blockedUntil > now) {
    return { action: "blocked", retryMs: state.blockedUntil - now };
  }

  // Record this message; drop anything that has aged out of the window.
  const cutoff = now - cfg.burstWindowMs;
  state.hits = state.hits.filter((t) => t > cutoff);
  state.hits.push(now);

  if (state.hits.length <= cfg.burstMax) {
    return { action: "allow" };
  }

  // Burst exceeded: a strike. Clear the burst so one long flood is a single
  // strike rather than a strike on every subsequent message.
  state.hits = [];
  state.warnings += 1;
  state.lastStrikeAt = now;

  if (state.warnings > cfg.warningsBeforeMute) {
    const muteMs = Math.min(cfg.muteBaseMs * 2 ** state.muteCount, cfg.muteMaxMs);
    state.muteCount += 1;
    state.lastMuteAt = now;
    // The mute itself is the block now; reset the warning ladder so post-mute
    // behavior starts fresh (the mute-escalation is what carries repeat guilt).
    state.warnings = 0;
    state.blockLevel = 0;
    state.blockedUntil = 0;
    return { action: "mute", muteMs };
  }

  const blockMs = Math.min(cfg.blockBaseMs * 2 ** state.blockLevel, cfg.blockMaxMs);
  state.blockLevel += 1;
  state.blockedUntil = now + blockMs;
  return { action: "warn", warning: state.warnings, limit: cfg.warningsBeforeMute, blockMs };
}

/* ============================================================ *
 *  Stateful wrapper used by the dispatch path.
 * ============================================================ */

const states = new Map<string, SpamState>();

function isClean(s: SpamState, now: number): boolean {
  return (
    s.hits.length === 0 &&
    s.warnings === 0 &&
    s.blockLevel === 0 &&
    s.muteCount === 0 &&
    s.blockedUntil <= now
  );
}

/**
 * Evaluate one incoming message for a user against the shared ladder. Keeps a
 * per-user entry alive only while it carries state, so the map self-prunes for
 * users who calm down or disconnect.
 */
export function evaluateAntiSpam(
  userId: string,
  now: number,
  cfg: AntiSpamConfig = DEFAULT_ANTI_SPAM_CONFIG,
): SpamVerdict {
  const state = states.get(userId) ?? freshSpamState();
  const verdict = stepAntiSpam(state, now, cfg);
  if (isClean(state, now)) states.delete(userId);
  else states.set(userId, state);
  return verdict;
}

/** Test-only: wipe the in-memory ladder between cases. */
export function __resetAntiSpamState(): void {
  states.clear();
}
