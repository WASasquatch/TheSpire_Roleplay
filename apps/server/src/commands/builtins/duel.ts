/**
 * /duel slash command, turn-based combat between two players.
 *
 * Subcommands:
 *   - /duel <opponent> [class]          challenge someone
 *   - /duel accept [class]              accept a pending challenge
 *   - /duel decline                     refuse a pending challenge
 *   - /duel attack | a                  attack the opponent
 *   - /duel defend | d                  brace (50% damage taken)
 *   - /duel parry  | p                  contest the next attack
 *   - /duel rest   | r                  recover 2d6 HP this turn
 *   - /duel status                      print HP / whose turn / etc.
 *   - /duel forfeit                     surrender (opponent wins)
 *
 * Identity scoping: per-identity via the registry's IdentityKey
 * model. A master and a character of the same user can each be in
 * separate duels, but the registry only allows one game per room
 * scope so a room can host at most one active duel at a time.
 *
 * Module split: combat math + state mutations live in
 * `apps/server/src/games/duel.ts`; this file is just the command-
 * surface wiring (parse args, route to the right state mutator,
 * post the resulting chat line).
 */

import {
  cancel,
  findRoomSession,
  startSession,
  SessionConflictError,
  type GameSession,
  type ParticipantRef,
} from "../../games/registry.js";
import {
  DUEL_CHALLENGE_MS,
  DUEL_CLASSES,
  DUEL_KIND,
  DUEL_WINDOW_MS,
  acceptChallenge,
  activeFighter,
  applyDuelAction,
  checkDuelEnd,
  declineChallenge,
  fighterIndexFor,
  flipTurn,
  forfeitDuel,
  newDuelState,
  parseClassArg,
  parseDuelAction,
  readDuelConfig,
  scheduleTurnTimeout,
  type DuelClassKey,
  type DuelState,
} from "../../games/duel.js";
import { addSystemMessage } from "../../realtime/broadcast.js";
import { emitAmbiguousIdentityModal, resolveIdentityArg } from "../identityArg.js";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { CommandContext, CommandHandler } from "../types.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

function notice(ctx: CommandContext, code: string, message: string): void {
  ctx.socket.emit("error:notice", { code, message });
}

function participantFor(ctx: CommandContext): ParticipantRef {
  return {
    userId: ctx.user.id,
    characterId: ctx.user.activeCharacterId,
    displayName: ctx.user.displayName,
  };
}

/**
 * Send a system message visible ONLY to the two duelists. Used for
 * per-turn action results + next-turn announces so the room isn't
 * spammed by a multi-minute fight playing out in plain chat. The
 * only events the room sees are: the initial challenge announce,
 * the accept announce, and the final result with winnings.
 *
 * Emission is fire-and-forget per duelist socket: each connected
 * socket belonging to the challenger or defender userId gets a
 * `message:new` event with `kind: "system"`. The message is NOT
 * persisted, refreshing mid-fight loses the transcript but the
 * final result captures the outcome so post-game review still
 * works.
 *
 * The roomId is rewritten per recipient to whichever tab they're
 * currently looking at, matching the whisper pattern, so the line
 * lands in the chat view they actually see rather than only the
 * room the duel started in.
 */
async function emitDuelPrivate(io: Io, session: GameSession, body: string): Promise<void> {
  const state = session.state as DuelState;
  const userIds = new Set<string>();
  userIds.add(state.challenger.participant.userId);
  if (state.defender) userIds.add(state.defender.participant.userId);
  const fallbackRoom = session.scope.kind === "room" ? session.scope.roomId : "";
  const sockets = await io.fetchSockets();
  const out = {
    id: `duel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    userId: "system",
    characterId: null,
    displayName: "system",
    kind: "system" as const,
    body,
    color: null,
    createdAt: Date.now(),
  };
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (!uid || !userIds.has(uid)) continue;
    const tabRoom = (s.data as { roomId?: string }).roomId ?? fallbackRoom;
    s.emit("message:new", { ...out, roomId: tabRoom });
  }
}

/**
 * Parse the post-opponent args into the challenger's class plus an
 * optional suggested opponent class. Supports two syntaxes side by
 * side so old muscle memory and new explicit phrasing both work:
 *
 *   Positional (legacy):   /duel Casey knight        ← you = knight
 *                          /duel Casey mage knight   ← you = mage,
 *                                                      opponent
 *                                                      suggested
 *                                                      knight
 *
 *   Explicit (clearer):    /duel Casey as mage
 *                          /duel Casey as mage vs knight
 *
 * Explicit phrases take precedence: an `as`-tagged class can't be
 * overwritten by a later bare positional. Unknown tokens are
 * silently dropped (the caller already validated the opponent
 * name; everything after it is class-related).
 */
function parseDuelStartArgs(rest: ReadonlyArray<string>): {
  challengerClass: DuelClassKey;
  opponentClass: DuelClassKey | null;
} {
  let challengerClass: DuelClassKey = "knight";
  let challengerSetExplicitly = false;
  let opponentClass: DuelClassKey | null = null;
  const lower = rest.map((s) => s.toLowerCase());
  let i = 0;
  while (i < lower.length) {
    const tok = lower[i]!;
    if (tok === "as" && i + 1 < lower.length) {
      const klass = parseClassArg(lower[i + 1]!);
      if (klass) {
        challengerClass = klass;
        challengerSetExplicitly = true;
      }
      i += 2;
      continue;
    }
    if ((tok === "vs" || tok === "versus") && i + 1 < lower.length) {
      const klass = parseClassArg(lower[i + 1]!);
      if (klass) opponentClass = klass;
      i += 2;
      continue;
    }
    // Bare positional, first one fills challenger (unless `as` already
    // locked it), second fills opponent suggestion.
    const klass = parseClassArg(lower[i]!);
    if (klass) {
      if (!challengerSetExplicitly) {
        challengerClass = klass;
        challengerSetExplicitly = true;
      } else if (!opponentClass) {
        opponentClass = klass;
      }
    }
    i++;
  }
  return { challengerClass, opponentClass };
}

export const duelCommand: CommandHandler = {
  name: "duel",
  usage: "/duel <opponent> [as <your class>] [vs <suggested opponent class>] | /duel accept [class] | /duel attack|defend|parry|rest | /duel status | /duel forfeit",
  description:
    "Turn-based 1v1 combat. Challenge someone with /duel <name>; the opponent accepts with /duel accept and picks their own class. As the challenger, set your own class right in the start line: /duel Casey as mage. Everyone starts at 20 HP; classes (knight/archer/mage/gunslinger) differ by weapon, damage dice, and crit range. Winner mints the configured XP / Currency / item reward; the loser earns a reduced consolation.",
  subcommands: [
    { verb: "<opponent>", usage: "/duel Casey", description: "Challenge someone with the default class (knight). Use a name, or paste an identity token to disambiguate when multiple identities share the name." },
    { verb: "<opponent> as <class>", usage: "/duel Casey as mage", description: "Challenge someone and set YOUR class for the fight. Classes: knight, archer, mage, gunslinger." },
    { verb: "<opponent> as <class> vs <class>", usage: "/duel Casey as mage vs knight", description: "Same as above, plus a suggested class for the opponent. They can still pick their own on accept." },
    { verb: "accept [class]", usage: "/duel accept mage", description: "Accept a pending challenge. Pick your class (defaults to knight or whatever the challenger suggested)." },
    { verb: "decline", usage: "/duel decline", description: "Refuse a pending challenge." },
    { verb: "attack", usage: "/duel attack", description: "Attack the opponent. Server rolls 1d20 + your hit mod vs their defense." },
    { verb: "defend", usage: "/duel defend", description: "Brace this turn, incoming damage halved. Your opponent sees only a generic guarded stance." },
    { verb: "parry",  usage: "/duel parry",  description: "Contest the next attack, 1d20 vs attacker's roll to negate + counter. Your opponent sees only a generic guarded stance." },
    { verb: "rest",   usage: "/duel rest",   description: "Recover 2d6 HP. Skip your attack this turn." },
    { verb: "status", usage: "/duel status", description: "Print HP, classes, whose turn it is, and seconds left." },
    { verb: "forfeit", usage: "/duel forfeit", description: "Surrender. Opponent wins; you get nothing." },
  ],
  async run(ctx) {
    if (ctx.user.incognitoMode) {
      return notice(ctx, "DUEL_INCOGNITO", "You can't /duel while in /incognito, every turn line names the participants.");
    }
    const [sub, ...rest] = ctx.args;
    const subLower = (sub ?? "").toLowerCase();
    const active = findRoomSession(ctx.roomId);

    if (!sub) {
      return notice(ctx, "DUEL_USAGE", "Usage: /duel <opponent> [class]");
    }

    // Routing, accept / decline / combat actions / status / forfeit
    // first, then fall through to "challenge a new opponent."
    if (subLower === "accept") {
      if (!active || active.kind !== DUEL_KIND) {
        return notice(ctx, "DUEL_NONE", "No duel challenge is pending in this room.");
      }
      const classArg = rest[0] ?? "";
      const requestedClass = parseClassArg(classArg);
      const state = active.state as DuelState;
      // If accepter didn't pick a class, fall back to the
      // challenger's suggestion or to "knight" as a sensible default.
      const klass = requestedClass ?? state.suggestedOpponentClass ?? "knight";
      const result = acceptChallenge(active, participantFor(ctx), klass);
      if (!result.ok) return notice(ctx, "DUEL_ACCEPT", result.reason);
      // Schedule the first turn's timeout.
      scheduleTurnTimeout(active, { db: ctx.db, io: ctx.io });
      await addSystemMessage(
        ctx.io,
        ctx.db,
        ctx.roomId,
        `⚔️ ${state.defender!.participant.displayName} (${DUEL_CLASSES[klass].label}) accepts ${state.challenger.participant.displayName}'s duel! Round 1: ${state.challenger.participant.displayName} (HP ${state.challenger.hp}/${DUEL_CLASSES[state.challenger.classKey].maxHp}) goes first. Choose /duel attack | defend | parry | rest.`,
      );
      return;
    }

    if (subLower === "decline") {
      if (!active || active.kind !== DUEL_KIND) {
        return notice(ctx, "DUEL_NONE", "No duel challenge is pending in this room.");
      }
      const state = active.state as DuelState;
      if (state.phase !== "challenge") {
        return notice(ctx, "DUEL_DECLINE", "That duel is already underway.");
      }
      if (!state.pendingOpponent || state.pendingOpponent.userId !== ctx.user.id) {
        return notice(ctx, "DUEL_DECLINE_PERM", "This challenge isn't addressed to you.");
      }
      declineChallenge(active);
      await cancel(active, { db: ctx.db, io: ctx.io });
      return;
    }

    // Combat actions / status / forfeit must be inside an active
    // duel where the caller is one of the two fighters.
    const action = parseDuelAction(sub!);
    if (action || subLower === "status" || subLower === "forfeit") {
      if (!active || active.kind !== DUEL_KIND) {
        return notice(ctx, "DUEL_NONE", "No duel is running in this room.");
      }
      const state = active.state as DuelState;
      if (state.phase !== "active") {
        return notice(ctx, "DUEL_NOT_ACTIVE", "That duel hasn't started, opponent still hasn't accepted.");
      }
      const callerIdx = fighterIndexFor(active, participantFor(ctx));
      if (callerIdx === null) {
        return notice(ctx, "DUEL_NOT_FIGHTER", "Only the two duelists can act here.");
      }

      if (subLower === "status") {
        const cMax = DUEL_CLASSES[state.challenger.classKey].maxHp;
        const dMax = DUEL_CLASSES[state.defender!.classKey].maxHp;
        const turnName = activeFighter(active)?.participant.displayName ?? "?";
        const secsLeft = Math.max(0, Math.ceil((state.turnExpiresAt - Date.now()) / 1000));
        return notice(
          ctx,
          "DUEL_STATUS",
          `${state.challenger.participant.displayName} (${DUEL_CLASSES[state.challenger.classKey].label}) HP ${state.challenger.hp}/${cMax} vs ${state.defender!.participant.displayName} (${DUEL_CLASSES[state.defender!.classKey].label}) HP ${state.defender!.hp}/${dMax}. ${turnName}'s turn, ${secsLeft}s left.`,
        );
      }

      if (subLower === "forfeit") {
        forfeitDuel(active, participantFor(ctx));
        await cancel(active, { db: ctx.db, io: ctx.io });
        return;
      }

      // Combat action.
      if (action) {
        if (callerIdx !== state.turn) {
          const activeName = activeFighter(active)?.participant.displayName ?? "?";
          return notice(ctx, "DUEL_OUT_OF_TURN", `Not your turn, waiting on ${activeName}.`);
        }
        const result = applyDuelAction(active, callerIdx, action);
        // Action result goes to BOTH duelists privately. Room and
        // spectators see nothing for per-turn events, only the
        // initial challenge + final result land publicly.
        if (result.publicLine) {
          await emitDuelPrivate(ctx.io, active, result.publicLine);
        }
        // Specific mechanics (defend / parry confirmations) go to
        // the actor only; opponent sees just the public line.
        if (result.privateLine) {
          ctx.socket.emit("message:new", {
            id: `duel-${Date.now()}`,
            roomId: ctx.roomId,
            userId: "system",
            characterId: null,
            displayName: "system",
            kind: "system",
            body: result.privateLine,
            color: null,
            createdAt: Date.now(),
          });
        }
        if (checkDuelEnd(active)) {
          await cancel(active, { db: ctx.db, io: ctx.io });
          return;
        }
        // Flip turn + arm timer immediately so the inbound player
        // CAN act, but delay the "your turn" announce a beat so the
        // action result has time to breathe instead of slamming
        // into the next line. Without the delay the dueler reads
        // both lines as one wall of text.
        flipTurn(active);
        scheduleTurnTimeout(active, { db: ctx.db, io: ctx.io });
        const nextFighter = activeFighter(active);
        if (nextFighter) {
          const sessionRef = active;
          const io = ctx.io;
          const turnAnnounce = `${nextFighter.participant.displayName}'s turn (HP ${nextFighter.hp}/${DUEL_CLASSES[nextFighter.classKey].maxHp}). /duel attack | defend | parry | rest.`;
          setTimeout(() => {
            // Bail if the duel ended during the delay (KO, forfeit,
            // cancel, etc.). The registry sets `resolved` on cancel
            // / timer-fire so this check is enough to prevent a
            // stale next-turn line from landing after resolution.
            if (sessionRef.resolved) return;
            void emitDuelPrivate(io, sessionRef, turnAnnounce);
          }, 1500);
        }
        return;
      }
    }

    // Fall-through: bare /duel <opponent> [as <class>] [vs <class>],
    // open a challenge. The opponent argument runs through the shared
    // identity resolver so a bare name that matches more than one
    // identity surfaces a disambiguation modal listing token-form
    // pasteables for each match, rather than silently picking the
    // first hit. Identity tokens (@id:userId / @cid:characterId) pin
    // a specific identity even when names collide.
    if (active) {
      return notice(
        ctx,
        "DUEL_CONFLICT",
        `A ${active.kind} session is already running in this room. Wait for it to finish.`,
      );
    }
    const opponentName = sub!;
    const resolution = await resolveIdentityArg(ctx.db, opponentName);
    if (resolution.kind === "none") {
      return notice(ctx, "DUEL_NO_OPPONENT", `No user or character matched "${opponentName}".`);
    }
    if (resolution.kind === "ambiguous") {
      emitAmbiguousIdentityModal(ctx, opponentName, resolution.matches);
      return;
    }
    const opponent: ParticipantRef = {
      userId: resolution.target.userId,
      characterId: resolution.target.characterId,
      displayName: resolution.target.displayName,
    };
    if (opponent.userId === ctx.user.id
      && (opponent.characterId ?? null) === (ctx.user.activeCharacterId ?? null)) {
      return notice(ctx, "DUEL_SELF", "You can't duel yourself.");
    }
    const { challengerClass, opponentClass } = parseDuelStartArgs(rest);
    const { challengeMs, reward } = await readDuelConfig(ctx.db);
    try {
      startSession({
        kind: DUEL_KIND,
        host: participantFor(ctx),
        scope: { kind: "room", roomId: ctx.roomId },
        state: newDuelState(
          participantFor(ctx),
          challengerClass,
          opponent,
          opponentClass,
          reward,
        ),
        windowMs: Math.max(challengeMs, DUEL_WINDOW_MS),
        db: ctx.db,
        io: ctx.io,
      });
    } catch (err) {
      if (err instanceof SessionConflictError) {
        return notice(ctx, "DUEL_CONFLICT", err.message);
      }
      throw err;
    }
    const suggestion = opponentClass ? ` (suggested class: ${DUEL_CLASSES[opponentClass].label})` : "";
    await addSystemMessage(
      ctx.io,
      ctx.db,
      ctx.roomId,
      `⚔️ ${ctx.user.displayName} challenges ${opponent.displayName} to a duel as ${DUEL_CLASSES[challengerClass].label}${suggestion}! ${opponent.displayName}, run /duel accept [class] in the next ${Math.round(challengeMs / 1000)}s, or /duel decline. Classes: knight / archer / mage / gunslinger.`,
    );
  },
};
