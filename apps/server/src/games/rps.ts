/**
 * Rock-paper-scissors social game.
 *
 * Lifecycle:
 *   - `/rps` (or `/rps <throw>`) starts a 30-second window in the
 *     current room. The host's throw counts as the first entry when
 *     they supplied one with the start command.
 *   - During the window, any room occupant runs `/rps <throw>` to
 *     join. Throws are scoped per identity (master vs. each
 *     character can each enter once independently); a second `/rps
 *     <throw>` from the same identity overwrites their pick.
 *   - At expiry, the registry calls `resolveRps` here. We post a
 *     single inline-list system message to the room showing every
 *     entrant's throw + win/loss, computed by the "group
 *     elimination" rule below.
 *
 * Group-elimination rule:
 *   - Group entrants by throw. There are at most three groups:
 *     rock, paper, scissors.
 *   - All-three-present → nobody wins (round cancels).
 *   - Exactly two groups present → the group whose throw BEATS the
 *     other's wins. Every member of the winning group is a winner.
 *   - Exactly one group present (everyone threw the same) → tie,
 *     nobody wins.
 *   - Single-entry round → silent tie too; we still post the result
 *     so the host knows their game ran with zero takers.
 *
 * That rule scales from 2 to N players without weird edge cases, and
 * the inline-list result message reads like a transcript so people
 * who came in mid-round can see who threw what.
 */

import { addSystemMessage } from "../realtime/broadcast.js";
import {
  registerGameKind,
  type GameSession,
  type IdentityKey,
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

export const RPS_KIND = "rps";
export const RPS_COMMAND_NAME = "rps";
/** Code default for the round window. The admin Built-ins panel can
 *  override this via `builtin_command_config.duration_ms`. */
export const RPS_WINDOW_MS = 30_000;

/** Out-of-the-box reward, applied per winner when admin hasn't
 *  configured the Built-Ins panel. Modest because RPS is short and
 *  group-elim can produce multiple winners; each picks up the full
 *  amount independently. Admin can override (or zero out) in the
 *  panel. */
export const RPS_DEFAULT_REWARD: BuiltinCommandReward = {
  xp: 8,
  currency: 3,
  itemKey: null,
  itemCount: 0,
};

export type RpsThrow = "rock" | "paper" | "scissors";

export interface RpsEntry {
  participant: ParticipantRef;
  throw: RpsThrow;
}

/** Per-session state shape. The framework casts `session.state` to
 *  this when calling our hooks. */
export interface RpsState {
  entries: Map<IdentityKey, RpsEntry>;
  /** Reward config snapshotted at game start so a mid-round admin
   *  edit doesn't retroactively change what the round was worth. */
  reward: BuiltinCommandReward;
}

/**
 * Resolve admin overrides for `/rps`. The command handler calls this
 * once per `startSession` to (a) pick the actual window duration
 * for `setTimeout` and (b) snapshot the reward config into the
 * session state so the resolver doesn't re-read DB rows under the
 * timer callback.
 */
export async function readRpsConfig(db: import("../db/index.js").Db, serverId?: string | null): Promise<{
  windowMs: number;
  reward: BuiltinCommandReward;
}> {
  const cfg = await getBuiltinCommandConfig(db, RPS_COMMAND_NAME, {
    durationMs: RPS_WINDOW_MS,
    reward: RPS_DEFAULT_REWARD,
  }, serverId);
  return { windowMs: cfg.durationMs, reward: cfg.reward };
}

/** Normalize a free-form arg ("r", "rock", "ROCK", "🪨") to a canonical
 *  throw, or null when it doesn't match. The picker accepts a small
 *  set of aliases on top of the three full words so a quick `/rps r`
 *  works without forcing memorization. */
export function parseRpsThrow(arg: string): RpsThrow | null {
  const norm = arg.trim().toLowerCase();
  if (norm === "rock" || norm === "r" || norm === "🪨") return "rock";
  if (norm === "paper" || norm === "p" || norm === "📄") return "paper";
  if (norm === "scissors" || norm === "scissor" || norm === "s" || norm === "✂️" || norm === "✂") {
    return "scissors";
  }
  return null;
}

/** Record (or overwrite) an entry on the active session. Caller is
 *  responsible for verifying the session is RPS-kind before calling
 * , we don't re-check here. */
export function recordRpsEntry(session: GameSession, key: IdentityKey, entry: RpsEntry): void {
  const state = session.state as RpsState;
  state.entries.set(key, entry);
}

/** Build the initial state for a new RPS session. `seedEntry` is the
 *  host's own throw when they started the game with one (e.g.
 *  `/rps rock`); null when they used the bare `/rps` to open the
 *  window for others without throwing themselves yet. `reward` is
 *  the snapshotted admin-set reward, what each winner mints when
 *  the round resolves. */
export function newRpsState(
  seedEntry: RpsEntry | null,
  hostKey: IdentityKey,
  reward: BuiltinCommandReward,
): RpsState {
  const entries = new Map<IdentityKey, RpsEntry>();
  if (seedEntry) entries.set(hostKey, seedEntry);
  return { entries, reward };
}

/* ---------- Resolution ---------- */

interface RpsOutcome {
  winnerThrow: RpsThrow | null; // null = nobody won (all three present, or tie)
  reason: "winner" | "all-three" | "tie" | "no-entries";
}

/**
 * Pure function, no side effects. Exported for unit-testability and
 * for the result-message builder to call once it knows the entries.
 */
export function resolveRpsOutcome(throws: ReadonlyArray<RpsThrow>): RpsOutcome {
  if (throws.length === 0) return { winnerThrow: null, reason: "no-entries" };
  const hasRock = throws.includes("rock");
  const hasPaper = throws.includes("paper");
  const hasScissors = throws.includes("scissors");
  const presentCount = (hasRock ? 1 : 0) + (hasPaper ? 1 : 0) + (hasScissors ? 1 : 0);
  if (presentCount === 1) return { winnerThrow: null, reason: "tie" };
  if (presentCount === 3) return { winnerThrow: null, reason: "all-three" };
  // Exactly two groups present. Standard pairwise: rock beats scissors,
  // paper beats rock, scissors beats paper.
  if (hasRock && hasScissors) return { winnerThrow: "rock", reason: "winner" };
  if (hasPaper && hasRock) return { winnerThrow: "paper", reason: "winner" };
  if (hasScissors && hasPaper) return { winnerThrow: "scissors", reason: "winner" };
  // Unreachable: presentCount === 2 means exactly one of the three
  // pairs above matched. Return tie as a defensive default.
  return { winnerThrow: null, reason: "tie" };
}

/** Pick an icon for a throw so the inline-list reads at a glance.
 *  The fallback `?` is used when an entry's stored throw drifted
 *  outside the known set, defensive only; the parser rejects junk
 *  upstream. */
function throwIcon(t: RpsThrow): string {
  return t === "rock" ? "🪨" : t === "paper" ? "📄" : "✂️";
}

function throwLabel(t: RpsThrow): string {
  return t === "rock" ? "rock" : t === "paper" ? "paper" : "scissors";
}

async function resolveRps(session: GameSession, ctx: ResolveContext): Promise<void> {
  if (session.scope.kind !== "room") return; // RPS is room-only by design.
  const state = session.state as RpsState;
  const entries = Array.from(state.entries.values());
  const outcome = resolveRpsOutcome(entries.map((e) => e.throw));

  // Build the inline list. Format chosen for transparency, every
  // entrant gets a line so spectators can see exactly who threw what.
  const lines: string[] = [];
  const headline = entries.length === 0
    ? `🎲 Rock-paper-scissors: ${session.host.displayName} opened a round but nobody played.`
    : `🎲 Rock-paper-scissors round (${entries.length} ${entries.length === 1 ? "player" : "players"}):`;
  lines.push(headline);

  // Collect winners while we walk the entries, saves a second pass
  // when we need to mint rewards below.
  const winners: ParticipantRef[] = [];
  if (entries.length > 0) {
    for (const entry of entries) {
      const won = outcome.winnerThrow !== null && entry.throw === outcome.winnerThrow;
      const lost = outcome.winnerThrow !== null && entry.throw !== outcome.winnerThrow;
      const tag = won ? " ✓ win" : lost ? " ✗ lose" : "";
      lines.push(`  • ${entry.participant.displayName}: ${throwIcon(entry.throw)} ${throwLabel(entry.throw)}${tag}`);
      if (won) winners.push(entry.participant);
    }
    if (outcome.reason === "winner" && outcome.winnerThrow) {
      const losingThrow = beatableBy(outcome.winnerThrow);
      lines.push(`${throwLabel(outcome.winnerThrow)} beats ${throwLabel(losingThrow)}.`);
    } else if (outcome.reason === "all-three") {
      lines.push("All three throws present, round cancels, nobody wins.");
    } else if (outcome.reason === "tie") {
      lines.push("Everyone threw the same, tie.");
    }
  }

  // Reward minting. Each winner gets the FULL configured reward,
  // group-elim ties don't split, by design.
  if (winners.length > 0 && rewardIsNonZero(state.reward)) {
    for (const w of winners) {
      await mintRewardForWinner(ctx.db, ctx.io, w, state.reward, "rps_win", { serverId: ctx.serverId });
    }
  }
  // Always broadcast a winnings line when there's at least one
  // winner, even if the admin hasn't configured rewards. Falls back
  // to a bragging-rights phrasing so the room sees the outcome
  // clearly instead of an awkward silent reward slot. This call
  // also records each winner's stat row (see formatWinningsLine).
  if (winners.length > 0) {
    const line = await formatWinningsLine(
      ctx.db,
      RPS_KIND,
      winners,
      state.reward,
      { serverId: ctx.serverId },
    );
    if (line) lines.push(line);
  }

  await addSystemMessage(ctx.io, ctx.db, session.scope.roomId, lines.join("\n"));
}

/** What does `winner` beat? Used only for the result-line phrasing
 *  ("paper beats rock"). Mirror of the resolution rule. */
function beatableBy(winner: RpsThrow): RpsThrow {
  if (winner === "rock") return "scissors";
  if (winner === "paper") return "rock";
  return "paper";
}

/** Module init, called once at server boot from `index.ts`. */
export function registerRps(): void {
  registerGameKind(RPS_KIND, { onResolve: resolveRps });
}
