/**
 * Word Scramble, multi-round word game.
 *
 * Lifecycle:
 *   - `/scramble [rounds]` opens a round in the current room. Rounds
 *     defaults to 3, capped at SCRAMBLE_MAX_ROUNDS. Difficulty
 *     scales with round number, round 1 picks from short-word tier,
 *     later rounds pull from longer-word tiers.
 *   - During each round, players run `/scramble <word>` to claim
 *     points for words they spot in the scramble. Each guess must
 *     (a) only use letters present in the source word, counting
 *     duplicates, (b) be at least 3 letters long, and (c) appear in
 *     the curated dictionary. Per-player per-round dedup keeps the
 *     same word from scoring twice.
 *   - Each round ends after perRoundMs; the round timer posts a
 *     between-round summary (current scores) and rolls a new word.
 *   - After the final round, the registry's session timer fires the
 *     resolver, final scoreboard + top-score(s) crowned, reward
 *     minted with the point-multiplier curve applied.
 *
 * Scoring (per word guessed):
 *   3-letter = 1, 4 = 3, 5 = 6, 6 = 10, 7 = 15, 8 = 21, 9+ = 28
 *   Exact match to the source word: score × 2.
 *
 * Reward scaling: the winner's accumulated total points feeds
 * `computePointMultiplier` so a player who found lots of long words
 * gets a meaningful XP/Currency bump over someone who eked out a
 * minimum-points win. Item rewards (if configured) are unscaled,
 * see the docs on `computePointMultiplier` for the reasoning.
 *
 * Round-timer architecture: scramble uses TWO timers per session.
 * The registry's session timer is set for the full
 * `totalRounds × perRoundMs` window and triggers final resolution.
 * A separate `nextRoundTimer` (stored in state) fires at each
 * round boundary to rotate the source word and post the transition
 * message. The session timer is the authoritative end-of-game; the
 * round timer is purely for inter-round announcements and word
 * rotation. If a host cancels mid-game, the cancel hook clears the
 * round timer explicitly so it can't fire post-resolution.
 */

import {
  registerGameKind,
  type GameSession,
  type IdentityKey,
  type ParticipantRef,
  type ResolveContext,
  identityKeyFor,
} from "./registry.js";
import { addSystemMessage } from "../realtime/broadcast.js";
import {
  computePointMultiplier,
  formatWinningsLine,
  getBuiltinCommandConfig,
  mintRewardForWinner,
  rewardIsNonZero,
  type BuiltinCommandReward,
} from "./config.js";
import { pickSourceWord, SCRAMBLE_DICTIONARY } from "./scrambleDictionary.js";
import type { Db } from "../db/index.js";

export const SCRAMBLE_KIND = "scramble";
export const SCRAMBLE_COMMAND_NAME = "scramble";
/** Code default for the PER-ROUND window. Admin Built-ins panel can
 *  override via `builtin_command_config.duration_ms`. */
export const SCRAMBLE_PER_ROUND_MS = 60_000;
/** Cap on host-requested rounds. A 5-round game at 60s per round is
 *  five minutes of attention, long enough; longer requests get
 *  clamped to keep one game from monopolizing a room. */
export const SCRAMBLE_MAX_ROUNDS = 5;
export const SCRAMBLE_DEFAULT_ROUNDS = 3;

/** Out-of-the-box reward, applied per top-scorer. Lower base than
 *  Trivia because Scramble's point multiplier (see
 *  computePointMultiplier in config.ts) can already push payouts up
 *  to 10x for a high-scoring game, so the BASE here multiplied
 *  through stays in a reasonable range. Admin override / disable in
 *  the panel. */
export const SCRAMBLE_DEFAULT_REWARD: BuiltinCommandReward = {
  xp: 10,
  currency: 4,
  itemKey: null,
  itemCount: 0,
};

export interface ScramblePlayer {
  participant: ParticipantRef;
  /** Running total across all rounds played so far. The reward
   *  multiplier reads off this at end-of-game. */
  totalPoints: number;
  /** Per-round set of words this player has already scored, keyed
   *  by round number. Lets us dedup at the round boundary without
   *  re-scanning the player's full history. */
  perRoundGuesses: Map<number, Set<string>>;
}

export interface ScrambleState {
  totalRounds: number;
  /** 1-indexed current round number. Set to 1 by the start handler
   *  before `beginScrambleRound` runs for the first time. */
  currentRound: number;
  /** The unscrambled source word for the current round. Players
   *  who type this verbatim get an exact-match bonus. */
  currentSourceWord: string;
  /** Uppercase scrambled letters as broadcast in the round-start
   *  message. Stored so `/scramble status` can repeat it without
   *  re-randomizing. */
  currentLetters: string;
  currentRoundEndsAt: number;
  players: Map<IdentityKey, ScramblePlayer>;
  reward: BuiltinCommandReward;
  perRoundMs: number;
  /** Timer that advances to the next round. Null when the FINAL
   *  round is in progress (the registry's session timer handles
   *  end-of-game) or when the game has resolved. */
  nextRoundTimer: ReturnType<typeof setTimeout> | null;
  /** Host-supplied source words for upcoming rounds, indexed by
   *  (round - 1). Empty array (or a slot the host didn't fill)
   *  means the game module picks for that round. Stored so the
   *  round-transition uses host's pick first, then falls back. */
  hostWords: ReadonlyArray<string>;
}

export async function readScrambleConfig(db: Db, serverId?: string | null): Promise<{
  perRoundMs: number;
  reward: BuiltinCommandReward;
}> {
  const cfg = await getBuiltinCommandConfig(db, SCRAMBLE_COMMAND_NAME, {
    durationMs: SCRAMBLE_PER_ROUND_MS,
    reward: SCRAMBLE_DEFAULT_REWARD,
  }, serverId);
  return { perRoundMs: cfg.durationMs, reward: cfg.reward };
}

/** Clamp + default a host-supplied rounds argument. Empty / NaN /
 *  too-small all become SCRAMBLE_DEFAULT_ROUNDS; over-the-cap clamps
 *  down. */
export function parseScrambleRounds(arg: string | undefined): number {
  if (!arg) return SCRAMBLE_DEFAULT_ROUNDS;
  const n = Number.parseInt(arg, 10);
  if (!Number.isFinite(n) || n < 1) return SCRAMBLE_DEFAULT_ROUNDS;
  return Math.min(SCRAMBLE_MAX_ROUNDS, Math.max(1, n));
}

export const SCRAMBLE_MIN_HOST_WORD_LEN = 4;
export const SCRAMBLE_MAX_HOST_WORD_LEN = 12;

/** Whether a host-supplied source word is acceptable. Length
 *  bounds keep games sensible: anything under 4 letters has nearly
 *  no sub-words to find, anything over 12 makes the scramble too
 *  noisy. Letters only, digits/punctuation can't be scrambled
 *  meaningfully. */
export function isValidHostSourceWord(raw: string): boolean {
  const w = raw.trim().toLowerCase();
  if (w.length < SCRAMBLE_MIN_HOST_WORD_LEN) return false;
  if (w.length > SCRAMBLE_MAX_HOST_WORD_LEN) return false;
  return /^[a-z]+$/.test(w);
}

/**
 * Parse the host's `/scramble [...]` start args into rounds count
 * and the optional host word list.
 *
 * Forms accepted:
 *   - `[]`                       → default rounds, no host words
 *   - `[<rounds>]`               → that many rounds, no host words
 *   - `[<rounds>, <w1>, ...]`    → that many rounds, host words
 *                                   fill the first N slots
 *   - `[<w1>, <w2>, ...]`        → rounds = number of words
 *
 * Returns either `{ rounds, hostWords }` on success or
 * `{ error }` when something rejects: too many words for the
 * requested rounds count, or any word fails the validator
 * (length / charset). On error, the caller surfaces the message
 * verbatim as a notice; nothing partial is accepted.
 */
export function parseScrambleStartArgs(
  args: ReadonlyArray<string>,
): { rounds: number; hostWords: string[] } | { error: string } {
  if (args.length === 0) {
    return { rounds: SCRAMBLE_DEFAULT_ROUNDS, hostWords: [] };
  }
  let rounds: number;
  let wordArgs: ReadonlyArray<string>;
  if (/^\d+$/.test(args[0]!)) {
    rounds = parseScrambleRounds(args[0]);
    wordArgs = args.slice(1);
  } else {
    wordArgs = args;
    rounds = Math.min(SCRAMBLE_MAX_ROUNDS, Math.max(1, wordArgs.length));
  }
  const hostWords: string[] = [];
  const invalid: string[] = [];
  for (const w of wordArgs) {
    if (isValidHostSourceWord(w)) {
      hostWords.push(w.trim().toLowerCase());
    } else {
      invalid.push(w);
    }
  }
  if (invalid.length > 0) {
    const list = invalid.map((w) => `"${w}"`).join(", ");
    return {
      error: `Word${invalid.length === 1 ? "" : "s"} ${list} won't work as a source word. Use ${SCRAMBLE_MIN_HOST_WORD_LEN} to ${SCRAMBLE_MAX_HOST_WORD_LEN} letters, no digits or punctuation.`,
    };
  }
  if (hostWords.length > rounds) {
    return {
      error: `You gave ${hostWords.length} words but asked for ${rounds} rounds. Drop ${hostWords.length - rounds}, or raise the rounds count.`,
    };
  }
  return { rounds, hostWords };
}

/** Pick the source word for a given round. Host-supplied words fill
 *  the first N slots in order; rounds beyond that fall back to the
 *  tier-based random picker. */
function sourceForRound(roundNumber: number, hostWords: ReadonlyArray<string>): string {
  const idx = roundNumber - 1;
  if (idx >= 0 && idx < hostWords.length && hostWords[idx]) {
    return hostWords[idx];
  }
  return pickSourceWord(roundNumber);
}

/**
 * Fisher-Yates scramble that re-rolls if the result equals the
 * source. Capped at 10 attempts so a degenerate input (e.g. all
 * identical letters) doesn't loop forever, at that point the
 * "scramble" being identical is the honest answer.
 */
export function scrambleWord(word: string): string {
  const letters = word.toLowerCase().split("");
  for (let attempt = 0; attempt < 10; attempt++) {
    for (let i = letters.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [letters[i], letters[j]] = [letters[j]!, letters[i]!];
    }
    if (letters.join("") !== word.toLowerCase()) break;
  }
  return letters.join("").toUpperCase();
}

/**
 * Check whether `guess` can be assembled from `source`'s letter
 * pool, respecting letter counts. "OOO" cannot be made from "HOUR"
 * even though "O" is present once.
 */
export function canMakeFromLetters(guess: string, source: string): boolean {
  const counts: Record<string, number> = {};
  for (const c of source.toLowerCase()) counts[c] = (counts[c] ?? 0) + 1;
  for (const c of guess.toLowerCase()) {
    if (!counts[c]) return false;
    counts[c]--;
  }
  return true;
}

/**
 * Length-tier scoring. Short words are easy to spot so they're worth
 * little; long words scale up. The exact-match bonus rewards the
 * player who unscrambles the source itself, usually the hardest
 * find at longer lengths.
 */
export function scoreForWord(guess: string, source: string): number {
  const len = guess.length;
  let base = 0;
  if (len <= 2) return 0;
  if (len === 3) base = 1;
  else if (len === 4) base = 3;
  else if (len === 5) base = 6;
  else if (len === 6) base = 10;
  else if (len === 7) base = 15;
  else if (len === 8) base = 21;
  else base = 28;
  if (guess.toLowerCase() === source.toLowerCase()) base *= 2;
  return base;
}

/** Discriminated guess outcome, handler picks a notice based on
 *  the variant. */
export type GuessOutcome =
  | { kind: "ok"; word: string; points: number; exactMatch: boolean; total: number }
  | { kind: "tooshort" }
  | { kind: "letters" }
  | { kind: "notword" }
  | { kind: "duplicate"; word: string };

export function recordScrambleGuess(
  session: GameSession,
  participant: ParticipantRef,
  rawGuess: string,
): GuessOutcome {
  const state = session.state as ScrambleState;
  const guess = rawGuess.trim().toLowerCase();
  if (guess.length < 3) return { kind: "tooshort" };
  if (!/^[a-z]+$/.test(guess)) return { kind: "notword" };
  if (!canMakeFromLetters(guess, state.currentSourceWord)) return { kind: "letters" };
  // Source word always counts even if the curated dictionary doesn't
  // happen to have it, the host already vouched for it by placing
  // it in the source pool, and the exact-match bonus would be dead
  // weight otherwise.
  const isSource = guess === state.currentSourceWord.toLowerCase();
  if (!isSource && !SCRAMBLE_DICTIONARY.has(guess)) return { kind: "notword" };
  const key = identityKeyFor(participant.userId, participant.characterId);
  let player = state.players.get(key);
  if (!player) {
    player = {
      participant,
      totalPoints: 0,
      perRoundGuesses: new Map(),
    };
    state.players.set(key, player);
  }
  let roundSet = player.perRoundGuesses.get(state.currentRound);
  if (!roundSet) {
    roundSet = new Set<string>();
    player.perRoundGuesses.set(state.currentRound, roundSet);
  }
  if (roundSet.has(guess)) return { kind: "duplicate", word: guess };
  roundSet.add(guess);
  const points = scoreForWord(guess, state.currentSourceWord);
  player.totalPoints += points;
  const exactMatch = guess === state.currentSourceWord.toLowerCase();
  return { kind: "ok", word: guess, points, exactMatch, total: player.totalPoints };
}

/**
 * Build the initial state. The first round's source word + scrambled
 * letters are picked here so the start-of-game broadcast can include
 * them without an extra round-1 transition.
 */
export function newScrambleState(
  totalRounds: number,
  perRoundMs: number,
  reward: BuiltinCommandReward,
  hostWords: ReadonlyArray<string> = [],
): ScrambleState {
  const source = sourceForRound(1, hostWords);
  return {
    totalRounds,
    currentRound: 1,
    currentSourceWord: source,
    currentLetters: scrambleWord(source),
    currentRoundEndsAt: Date.now() + perRoundMs,
    players: new Map(),
    reward,
    perRoundMs,
    nextRoundTimer: null,
    hostWords: hostWords.slice(),
  };
}

/**
 * Schedule the timer that ends round N and starts round N+1. Called
 * after `startSession` returns, and again at each successful
 * transition. No-op when the current round is the final round (the
 * registry's session timer handles the end-of-game transition).
 */
export function scheduleScrambleRoundTimer(
  session: GameSession,
  ctx: ResolveContext,
): void {
  const state = session.state as ScrambleState;
  if (state.currentRound >= state.totalRounds) {
    state.nextRoundTimer = null;
    return;
  }
  state.nextRoundTimer = setTimeout(
    () => { void advanceScrambleRound(session, ctx); },
    state.perRoundMs,
  );
}

async function advanceScrambleRound(session: GameSession, ctx: ResolveContext): Promise<void> {
  if (session.resolved) return;
  if (session.scope.kind !== "room") return;
  const state = session.state as ScrambleState;
  // Post end-of-round summary using the SOON-TO-BE-OLD round values.
  await postRoundEndSummary(session, ctx);
  state.currentRound += 1;
  if (state.currentRound > state.totalRounds) {
    // Shouldn't happen, the (N-1)th transition fires the start of
    // round N, then the session timer ends round N. Defensive guard.
    state.nextRoundTimer = null;
    return;
  }
  // Roll the next round's source word + post the round-start line.
  // Host-supplied words take priority over the random picker.
  const source = sourceForRound(state.currentRound, state.hostWords);
  state.currentSourceWord = source;
  state.currentLetters = scrambleWord(source);
  state.currentRoundEndsAt = Date.now() + state.perRoundMs;
  await addSystemMessage(
    ctx.io,
    ctx.db,
    session.scope.roomId,
    formatRoundStartLine(state),
  );
  scheduleScrambleRoundTimer(session, ctx);
}

async function postRoundEndSummary(session: GameSession, ctx: ResolveContext): Promise<void> {
  if (session.scope.kind !== "room") return;
  const state = session.state as ScrambleState;
  const lines: string[] = [];
  lines.push(`🔡 Scramble, round ${state.currentRound}/${state.totalRounds} ended. The word was: ${state.currentSourceWord.toUpperCase()}.`);
  if (state.players.size > 0) {
    const ranked = [...state.players.values()].sort((a, b) => b.totalPoints - a.totalPoints);
    const scores = ranked.map((p) => `${p.participant.displayName}: ${p.totalPoints}`).join(", ");
    lines.push(`Standings, ${scores}.`);
  } else {
    lines.push("No guesses scored this round.");
  }
  if (state.currentRound < state.totalRounds) {
    lines.push(`Round ${state.currentRound + 1} starts now…`);
  }
  await addSystemMessage(ctx.io, ctx.db, session.scope.roomId, lines.join("\n"));
}

/** Format the round-start announce. Exported so the command handler
 *  can produce the same line for round 1 at startSession time. */
export function formatRoundStartLine(state: ScrambleState): string {
  const secs = Math.round(state.perRoundMs / 1000);
  return (
    `🔡 Scramble round ${state.currentRound}/${state.totalRounds}, letters: `
    + `**${state.currentLetters}** (${state.currentSourceWord.length} long). `
    + `Guess words with \`/scramble <word>\`. ${secs}s to find as many as you can.`
  );
}

async function resolveScramble(session: GameSession, ctx: ResolveContext): Promise<void> {
  if (session.scope.kind !== "room") return;
  const state = session.state as ScrambleState;
  // Clear any pending round timer so a late round-transition can't
  // fire after we've already posted the final scoreboard.
  if (state.nextRoundTimer) {
    clearTimeout(state.nextRoundTimer);
    state.nextRoundTimer = null;
  }
  const lines: string[] = [];
  lines.push(
    `🔡 Scramble, round ${state.currentRound}/${state.totalRounds} ended. `
    + `The word was: ${state.currentSourceWord.toUpperCase()}.`,
  );
  if (state.players.size === 0) {
    lines.push("Nobody scored this game.");
    await addSystemMessage(ctx.io, ctx.db, session.scope.roomId, lines.join("\n"));
    return;
  }

  const ranked = [...state.players.values()].sort((a, b) => b.totalPoints - a.totalPoints);
  const topPoints = ranked[0]!.totalPoints;
  const winners = ranked.filter((p) => p.totalPoints === topPoints);
  const board = ranked.map((p) => `${p.participant.displayName}: ${p.totalPoints}`).join(", ");
  lines.push(`Final scoreboard, ${board}.`);
  if (topPoints === 0) {
    lines.push("Nobody scored any points. Drawn at random.");
    const pick = ranked[Math.floor(Math.random() * ranked.length)]!;
    if (rewardIsNonZero(state.reward)) {
      await mintRewardForWinner(ctx.db, ctx.io, pick.participant, state.reward, "scramble_win", { serverId: ctx.serverId });
    }
    const winningsLine = await formatWinningsLine(
      ctx.db,
      SCRAMBLE_KIND,
      [{ ...pick.participant, points: 0 }],
      state.reward,
      { serverId: ctx.serverId },
    );
    if (winningsLine) lines.push(winningsLine);
    await addSystemMessage(ctx.io, ctx.db, session.scope.roomId, lines.join("\n"));
    return;
  }

  if (winners.length === 1) {
    lines.push(`🏆 ${winners[0]!.participant.displayName} wins with ${topPoints} points.`);
  } else {
    lines.push(`🏆 Tied at ${topPoints} points, winners: ${winners.map((w) => w.participant.displayName).join(", ")}.`);
  }

  const multiplier = computePointMultiplier(topPoints);
  if (rewardIsNonZero(state.reward)) {
    for (const w of winners) {
      await mintRewardForWinner(
        ctx.db,
        ctx.io,
        w.participant,
        state.reward,
        "scramble_win",
        { multiplier, serverId: ctx.serverId },
      );
    }
  }
  // Pass the winner's accumulated points so scramble's stats row
  // reflects actual score progress, not just a +1 win counter.
  const winningsLine = await formatWinningsLine(
    ctx.db,
    SCRAMBLE_KIND,
    winners.map((w) => ({ ...w.participant, points: topPoints })),
    state.reward,
    { multiplier, serverId: ctx.serverId },
  );
  if (winningsLine) lines.push(winningsLine);

  await addSystemMessage(ctx.io, ctx.db, session.scope.roomId, lines.join("\n"));
}

async function cancelScramble(session: GameSession, ctx: ResolveContext): Promise<void> {
  if (session.scope.kind !== "room") return;
  const state = session.state as ScrambleState;
  if (state.nextRoundTimer) {
    clearTimeout(state.nextRoundTimer);
    state.nextRoundTimer = null;
  }
  const lines: string[] = [`🔡 Scramble cancelled by ${session.host.displayName}.`];
  if (state.players.size > 0) {
    const ranked = [...state.players.values()].sort((a, b) => b.totalPoints - a.totalPoints);
    const board = ranked.map((p) => `${p.participant.displayName}: ${p.totalPoints}`).join(", ");
    lines.push(`Final standings, ${board}.`);
  }
  await addSystemMessage(ctx.io, ctx.db, session.scope.roomId, lines.join("\n"));
}

export function registerScramble(): void {
  registerGameKind(SCRAMBLE_KIND, {
    onResolve: resolveScramble,
    onCancel: cancelScramble,
  });
}
