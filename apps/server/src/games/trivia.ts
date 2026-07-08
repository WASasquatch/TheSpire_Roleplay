/**
 * Trivia, host posts a question + a hidden answer, players race
 * to /answer with the correct text. First exact-or-fuzzy match wins.
 *
 * Lifecycle:
 *   - `/trivia <question> | <answer>` opens a 60s window in the
 *     current room. The question is broadcast as a system line;
 *     the answer is stashed in session state, never echoed.
 *   - During the window, any room occupant runs `/answer <text>`.
 *     Each guess fires a quiet notice back to the guesser; the
 *     room only sees a public chat line WHEN someone wins (so
 *     the room learns what the answer was).
 *   - On a correct match, the round resolves IMMEDIATELY (server
 *     calls the registry's `cancel` path so the timer stops and
 *     the result line + reward post right away).
 *   - On timeout with no match, the result line surfaces the answer
 *     so the room learns it anyway.
 *
 * Match rule: case-insensitive equality after whitespace + leading
 * "the / a / an" trimming. Tight enough that "the eiffel tower" and
 * "Eiffel Tower" both match; loose enough that we don't need a full
 * NLP dependency.
 */

import { addSystemMessage } from "../realtime/broadcast.js";
import type { Db } from "../db/index.js";
import {
  registerGameKind,
  type GameSession,
  type ParticipantRef,
  type ResolveContext,
} from "./registry.js";
import {
  formatWinningsLine,
  getBuiltinCommandConfig,
  mintRewardForWinner,
  rewardIsNonZero,
  type BuiltinCommandReward,
} from "./config.js";

export const TRIVIA_KIND = "trivia";
export const TRIVIA_COMMAND_NAME = "trivia";
export const TRIVIA_WINDOW_MS = 60_000;

/** Out-of-the-box reward for the single round winner. Recall-game
 *  payouts sit a notch above RPS to reflect that one player snagged
 *  the answer first while everyone else watched their guesses miss. */
export const TRIVIA_DEFAULT_REWARD: BuiltinCommandReward = {
  xp: 12,
  currency: 5,
  itemKey: null,
  itemCount: 0,
};

/** Each guess gets recorded so the result line can show who tried
 *  what, and so a repeat-guesser doesn't get credit twice. */
export interface TriviaGuess {
  participant: ParticipantRef;
  text: string;
  at: number;
}

export interface TriviaState {
  question: string;
  answer: string;
  /** Pre-normalized answer for cheap equality checks on /answer. */
  normalizedAnswer: string;
  guesses: TriviaGuess[];
  /** Set when someone wins. We still run the timer-driven resolver
   *  but it short-circuits on `winner != null`. The cancel path
   *  (used to early-resolve on a correct answer) bypasses this and
   *  fires the result line synchronously. */
  winner: ParticipantRef | null;
  reward: BuiltinCommandReward;
}

export async function readTriviaConfig(db: Db, serverId?: string | null): Promise<{
  windowMs: number;
  reward: BuiltinCommandReward;
}> {
  const cfg = await getBuiltinCommandConfig(db, TRIVIA_COMMAND_NAME, {
    durationMs: TRIVIA_WINDOW_MS,
    reward: TRIVIA_DEFAULT_REWARD,
  }, serverId);
  return { windowMs: cfg.durationMs, reward: cfg.reward };
}

/**
 * Parse `/trivia <question> | <answer>` into its two halves. Returns
 * null when the pipe is missing OR either half is empty. The pipe
 * is the only separator; any internal pipes in the question or
 * answer have to be escaped (or just not used).
 */
export function parseTriviaArgs(argsText: string): { question: string; answer: string } | null {
  const pipeIdx = argsText.indexOf("|");
  if (pipeIdx < 0) return null;
  const question = argsText.slice(0, pipeIdx).trim();
  const answer = argsText.slice(pipeIdx + 1).trim();
  if (!question || !answer) return null;
  return { question, answer };
}

/**
 * Normalize an answer for comparison. Lowercases, strips outer
 * whitespace, drops leading articles ("the", "a", "an") and
 * trailing punctuation. Two strings whose normalized form is equal
 * count as a match.
 */
export function normalizeAnswer(s: string): string {
  let out = s.trim().toLowerCase();
  out = out.replace(/^(the|a|an)\s+/, "");
  out = out.replace(/[.?!,;:]+$/g, "");
  out = out.replace(/\s+/g, " ");
  return out;
}

export function newTriviaState(
  question: string,
  answer: string,
  reward: BuiltinCommandReward,
): TriviaState {
  return {
    question,
    answer,
    normalizedAnswer: normalizeAnswer(answer),
    guesses: [],
    winner: null,
    reward,
  };
}

/**
 * Record a guess + check whether it wins. Returns a discriminated
 * result so the command handler can pick the right notice for the
 * guesser without rebuilding state knowledge.
 */
export type GuessResult =
  | { kind: "win" }
  | { kind: "miss" }
  | { kind: "duplicate" };

export function recordTriviaGuess(
  session: GameSession,
  guess: TriviaGuess,
): GuessResult {
  const state = session.state as TriviaState;
  if (state.winner) return { kind: "duplicate" }; // round is over
  // Each identity can guess as many times as they want during the
  // window, but the dedupe below quiets the result-line spam from
  // a repeat-same-text guess.
  const dup = state.guesses.some(
    (g) =>
      g.participant.userId === guess.participant.userId
      && g.participant.characterId === guess.participant.characterId
      && g.text.toLowerCase() === guess.text.toLowerCase(),
  );
  if (!dup) state.guesses.push(guess);
  if (normalizeAnswer(guess.text) === state.normalizedAnswer) {
    state.winner = guess.participant;
    return { kind: "win" };
  }
  return { kind: "miss" };
}

async function resolveTrivia(session: GameSession, ctx: ResolveContext): Promise<void> {
  if (session.scope.kind !== "room") return;
  const state = session.state as TriviaState;
  const lines: string[] = [];
  if (state.winner) {
    lines.push(`🧠 Trivia, ${session.host.displayName} asked: ${state.question}`);
    lines.push(`Correct! ${state.winner.displayName} got it: "${state.answer}".`);
    if (state.guesses.length > 1) {
      const tried = state.guesses
        .filter((g) => g.participant.userId !== state.winner!.userId || g.participant.characterId !== state.winner!.characterId)
        .map((g) => `${g.participant.displayName}: "${g.text}"`)
        .join("; ");
      if (tried) lines.push(`Other tries, ${tried}.`);
    }
    if (rewardIsNonZero(state.reward)) {
      await mintRewardForWinner(ctx.db, ctx.io, state.winner, state.reward, "trivia_win", { serverId: ctx.serverId });
    }
    const winningsLine = await formatWinningsLine(
      ctx.db,
      TRIVIA_KIND,
      [state.winner],
      state.reward,
      { serverId: ctx.serverId },
    );
    if (winningsLine) lines.push(winningsLine);
  } else {
    lines.push(`🧠 Trivia, ${session.host.displayName} asked: ${state.question}`);
    lines.push(`Nobody got it. The answer was: "${state.answer}".`);
    if (state.guesses.length > 0) {
      const tried = state.guesses
        .map((g) => `${g.participant.displayName}: "${g.text}"`)
        .join("; ");
      lines.push(`Tries, ${tried}.`);
    }
  }
  await addSystemMessage(ctx.io, ctx.db, session.scope.roomId, lines.join("\n"));
}

export function registerTrivia(): void {
  // Trivia uses the same resolve hook for both timer-expiry and
  // early-win paths, the cancel call in the win path runs onCancel
  // by default, so we register the same function for both.
  registerGameKind(TRIVIA_KIND, {
    onResolve: resolveTrivia,
    onCancel: resolveTrivia,
  });
}
