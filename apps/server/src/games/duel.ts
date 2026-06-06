/**
 * Duel, turn-based 1v1 combat with class-based weapons and dice-
 * resolved actions. Combat plays out as a chat-line transcript:
 * each action is logged as a system message showing the rolls,
 * so spectators can follow without opening a separate UI.
 *
 * Lifecycle:
 *   - `/duel <opponent> [class]` opens a challenge. The opponent has
 *     60s to `/duel accept [class]` or `/duel decline`. While the
 *     challenge is pending the registry's per-room slot is held so
 *     no other game can run in the room either.
 *   - On accept, both fighters are seeded with class-derived HP.
 *     Turns alternate; the active player runs `/duel <action>`; the
 *     server resolves dice and posts the result line; turn flips
 *     and the per-turn timer rearms.
 *   - 60s per-turn timeout: if the active player doesn't act, they
 *     forfeit and the other player wins by default.
 *   - Game ends when one player's HP hits zero or someone forfeits.
 *     The winner mints the admin-configured reward (XP / Currency /
 *     optional shop item).
 *
 * Classes (hardcoded baseline; no admin-tunable layer yet):
 *   - knight     sword   highest HP, balanced damage
 *   - archer     bow     medium HP, +to-hit
 *   - mage       magic   lowest HP, biggest damage dice
 *   - gunslinger pistol  low-medium HP, crits on 19-20
 *
 * Dice math (transparent in the result lines):
 *   - To-hit: 1d20 + classHitMod vs target's defense (12 base, +5
 *     while defending, +3 while in parry stance).
 *   - Miss: no damage. Crit on natural 20 (19-20 for gunslinger)
 *     doubles the damage roll.
 *   - Damage: per-class dice (e.g. knight 1d10+5).
 *   - Parry: if the parrier rolls strictly higher than the attacker's
 *     natural 1d20, the attack is negated AND the parrier counter-
 *     attacks for half damage.
 *   - Defend: incoming attacks do 50% damage.
 *   - Rest: skip your attack to recover 2d6 HP (capped at class max).
 *
 * Stamina was considered during design and intentionally cut, the
 * extra resource didn't add depth proportional to the bookkeeping
 * cost in a chat-line transcript. Re-introduce if a future tuning
 * pass shows fights resolve too quickly.
 */

import {
  cancel,
  registerGameKind,
  type GameSession,
  type ParticipantRef,
  type ResolveContext,
} from "./registry.js";
import { addSystemMessage } from "../realtime/broadcast.js";
import {
  formatWinningsLine,
  getBuiltinCommandConfig,
  mintRewardForWinner,
  rewardIsNonZero,
  type BuiltinCommandReward,
} from "./config.js";
import type { Db } from "../db/index.js";

export const DUEL_KIND = "duel";
export const DUEL_COMMAND_NAME = "duel";
/** Overall duel-session window, a safety net. Real per-turn timer
 *  is shorter (60s). The session-level expiry just keeps a forgotten
 *  duel from holding a room hostage forever. */
export const DUEL_WINDOW_MS = 30 * 60_000;
export const DUEL_TURN_MS = 60_000;
export const DUEL_CHALLENGE_MS = 60_000;

/**
 * Out-of-the-box reward for duels when the admin hasn't tuned the
 * Built-In Commands panel. The combat is long enough and the
 * damage-scaling multiplier sharp enough that a flat 15 XP / 5
 * Currency base feels meaningful in either direction: a clean win
 * lands closer to 75 XP / 25 Currency at the 5x cap, a loser at
 * 0.25x earns ~4 XP for their effort. An admin who wants more
 * generous payouts (or wants to add a shop item as the prize) sets
 * those values in the admin panel; an admin who wants no rewards
 * sets them to zero there.
 */
export const DUEL_DEFAULT_REWARD: BuiltinCommandReward = {
  xp: 15,
  currency: 5,
  itemKey: null,
  itemCount: 0,
};

export type DuelClassKey = "knight" | "archer" | "mage" | "gunslinger";

export interface DuelClass {
  key: DuelClassKey;
  label: string;
  weapon: string;
  weaponEmoji: string;
  maxHp: number;
  hitMod: number;
  /** Inclusive natural-roll threshold for a critical (20-only for
   *  most classes; gunslingers crit on 19-20). */
  critOn: number;
  /** Damage dice format: { count, faces, bonus }. Damage = NdF + B. */
  damage: { count: number; faces: number; bonus: number };
}

export const DUEL_CLASSES: Record<DuelClassKey, DuelClass> = {
  knight: {
    key: "knight",
    label: "Knight",
    weapon: "sword",
    weaponEmoji: "⚔️",
    maxHp: 120,
    hitMod: 2,
    critOn: 20,
    damage: { count: 1, faces: 10, bonus: 5 },
  },
  archer: {
    key: "archer",
    label: "Archer",
    weapon: "bow",
    weaponEmoji: "🏹",
    maxHp: 100,
    hitMod: 3,
    critOn: 20,
    damage: { count: 1, faces: 8, bonus: 3 },
  },
  mage: {
    key: "mage",
    label: "Mage",
    weapon: "magic",
    weaponEmoji: "✨",
    maxHp: 80,
    hitMod: 1,
    critOn: 20,
    damage: { count: 1, faces: 12, bonus: 2 },
  },
  gunslinger: {
    key: "gunslinger",
    label: "Gunslinger",
    weapon: "pistol",
    weaponEmoji: "🔫",
    maxHp: 90,
    hitMod: 1,
    critOn: 19,
    damage: { count: 1, faces: 8, bonus: 4 },
  },
};

/** Parse a free-form class arg (e.g. "knight", "Mage", "k") to the
 *  canonical class key. Returns null on no match. Short forms work
 *  so a quick `/duel @opponent k` is enough. */
export function parseClassArg(arg: string): DuelClassKey | null {
  const norm = arg.trim().toLowerCase();
  if (!norm) return null;
  if (norm === "knight" || norm === "k") return "knight";
  if (norm === "archer" || norm === "a") return "archer";
  if (norm === "mage" || norm === "m" || norm === "wizard") return "mage";
  if (norm === "gunslinger" || norm === "g" || norm === "gun") return "gunslinger";
  return null;
}

/** Per-fighter combat state. */
export interface Fighter {
  participant: ParticipantRef;
  classKey: DuelClassKey;
  hp: number;
  /** "defend" reduces incoming damage 50% this turn; "parry" gives a
   *  chance to negate + counter. Set on the fighter's last action;
   *  cleared when their turn comes back around. */
  stance: "none" | "defend" | "parry";
}

export interface DuelState {
  /** Set to "challenge" until the opponent accepts. Then flips to
   *  "active". On either expiry or forfeit, the session resolves. */
  phase: "challenge" | "active" | "ended";
  challenger: Fighter;
  /** Defender is partial during challenge phase, class isn't known
   *  until they accept. */
  defender: Fighter | null;
  /** Pending opponent identity during the challenge phase, captured
   *  from the `/duel <opponent>` arg so the accept handler can
   *  verify the caller is the named target. */
  pendingOpponent: ParticipantRef | null;
  /** Optional class the challenger suggested for the opponent. The
   *  opponent can override on /duel accept <class>. */
  suggestedOpponentClass: DuelClassKey | null;
  /** 0 → challenger's turn; 1 → defender's turn. Only meaningful in
   *  "active" phase. */
  turn: 0 | 1;
  /** Wall-clock timestamp the active turn must act before. Read by
   *  the turn-timer (see scheduleTurnTimeout). */
  turnExpiresAt: number;
  /** Turn-timeout handle so the next turn can clear before
   *  scheduling its own. */
  turnTimer: ReturnType<typeof setTimeout> | null;
  /** Decision tree winner. Set once before the session resolves. */
  winner: ParticipantRef | null;
  /** Why the duel ended. Drives the result-line phrasing. */
  endReason: "ko" | "forfeit" | "challenge_expired" | "challenge_declined" | null;
  /** Running transcript of action lines, posted to chat as each one
   *  fires. Kept here so the final result line can summarize damage
   *  taken / dealt without re-replaying. */
  totalDamageDealt: [number, number];
  reward: BuiltinCommandReward;
}

export async function readDuelConfig(db: Db): Promise<{
  challengeMs: number;
  reward: BuiltinCommandReward;
}> {
  const cfg = await getBuiltinCommandConfig(db, DUEL_COMMAND_NAME, {
    durationMs: DUEL_CHALLENGE_MS,
    reward: DUEL_DEFAULT_REWARD,
  });
  return { challengeMs: cfg.durationMs, reward: cfg.reward };
}

/* ---------- State construction ---------- */

export function newDuelState(
  challenger: ParticipantRef,
  challengerClass: DuelClassKey,
  pendingOpponent: ParticipantRef,
  suggestedOpponentClass: DuelClassKey | null,
  reward: BuiltinCommandReward,
): DuelState {
  const klass = DUEL_CLASSES[challengerClass];
  return {
    phase: "challenge",
    challenger: { participant: challenger, classKey: challengerClass, hp: klass.maxHp, stance: "none" },
    defender: null,
    pendingOpponent,
    suggestedOpponentClass,
    turn: 0,
    turnExpiresAt: 0,
    turnTimer: null,
    winner: null,
    endReason: null,
    totalDamageDealt: [0, 0],
    reward,
  };
}

/**
 * Accept a pending challenge. Returns true on success; the caller
 * (the /duel accept handler) is expected to then start the first
 * turn timer. Returns false when the accepter isn't the named
 * pendingOpponent OR the duel isn't in challenge phase.
 */
export function acceptChallenge(
  session: GameSession,
  accepter: ParticipantRef,
  accepterClass: DuelClassKey,
): { ok: true } | { ok: false; reason: string } {
  const state = session.state as DuelState;
  if (state.phase !== "challenge") {
    return { ok: false, reason: "Challenge already resolved." };
  }
  if (!state.pendingOpponent
    || state.pendingOpponent.userId !== accepter.userId
    || (state.pendingOpponent.characterId ?? null) !== (accepter.characterId ?? null)) {
    return { ok: false, reason: "This challenge isn't addressed to you." };
  }
  const klass = DUEL_CLASSES[accepterClass];
  state.defender = { participant: accepter, classKey: accepterClass, hp: klass.maxHp, stance: "none" };
  state.phase = "active";
  state.pendingOpponent = null;
  state.turn = 0; // challenger goes first
  return { ok: true };
}

export function declineChallenge(session: GameSession): void {
  const state = session.state as DuelState;
  state.phase = "ended";
  state.endReason = "challenge_declined";
  state.winner = null;
}

/* ---------- Combat actions ---------- */

export type DuelActionKind = "attack" | "defend" | "parry" | "rest";

export function parseDuelAction(arg: string): DuelActionKind | null {
  const norm = arg.trim().toLowerCase();
  if (norm === "attack" || norm === "a") return "attack";
  if (norm === "defend" || norm === "d") return "defend";
  if (norm === "parry" || norm === "p") return "parry";
  if (norm === "rest" || norm === "r") return "rest";
  return null;
}

/** Result of a combat action. Defensive stances (defend, parry) post
 *  a deliberately vague PUBLIC line so the opposing player can't tell
 *  the two apart, plus a PRIVATE confirmation to the actor with the
 *  specific mechanics. Non-defensive actions (attack, rest) leave
 *  `privateLine` null and put the full detail in `publicLine`. */
export interface DuelActionResult {
  publicLine: string | null;
  privateLine: string | null;
}

/** Apply a single combat action. Updates state, returns the chat
 *  lines to surface (publicly to the room, and optionally privately
 *  to the actor). Does NOT flip turn or check win, the command
 *  handler does both after reading the return. */
export function applyDuelAction(
  session: GameSession,
  actorIdx: 0 | 1,
  action: DuelActionKind,
): DuelActionResult {
  const state = session.state as DuelState;
  const actor = actorIdx === 0 ? state.challenger : state.defender!;
  const targetIdx: 0 | 1 = actorIdx === 0 ? 1 : 0;
  const target = targetIdx === 0 ? state.challenger : state.defender!;

  if (action === "defend") {
    actor.stance = "defend";
    // Public line is identical to parry's so the opponent can't tell
    // them apart, this preserves the strategic value of both stances.
    // The actor sees the specific mechanics in their private line.
    return {
      publicLine: `🛡 ${actor.participant.displayName} takes a guarded stance.`,
      privateLine: `🛡 You brace for impact. Incoming damage will be halved this round.`,
    };
  }
  if (action === "parry") {
    // Mutual parry. If the target is ALREADY in a parry stance from
    // their previous turn, both fighters are lunging at each other
    // expecting an attack that never comes. Resolve as a contested
    // parry exchange: both roll 1d20, the higher-rolling fighter
    // overpowers the other and lands a half-damage counter. Ties
    // are a stalemate. Both stances clear afterward, so the next
    // turn starts clean. The result line is public to both duelists
    // (via the command handler's private broadcast); the opponent
    // doesn't get a separate private confirmation here because the
    // public line already names both fighters explicitly.
    if (target.stance === "parry") {
      const actorRoll = rollDice(1, 20);
      const targetRoll = rollDice(1, 20);
      const actorClassMP = DUEL_CLASSES[actor.classKey];
      const targetClassMP = DUEL_CLASSES[target.classKey];
      let publicLine: string;
      if (actorRoll.total > targetRoll.total) {
        const counter = rollDamage(actorClassMP, false);
        const halved = Math.floor(counter.total / 2);
        target.hp = Math.max(0, target.hp - halved);
        state.totalDamageDealt[actorIdx] += halved;
        publicLine = `🤺 Mutual parry, ${actor.participant.displayName} (1d20=${actorRoll.total}) overpowers ${target.participant.displayName}'s parry (1d20=${targetRoll.total}) and lands a counter with ${actorClassMP.weaponEmoji} ${actorClassMP.weapon} (${counter.expr} → ${counter.total}, halved = ${halved}). ${target.participant.displayName} HP ${target.hp}/${targetClassMP.maxHp}.`;
      } else if (targetRoll.total > actorRoll.total) {
        const counter = rollDamage(targetClassMP, false);
        const halved = Math.floor(counter.total / 2);
        actor.hp = Math.max(0, actor.hp - halved);
        state.totalDamageDealt[targetIdx] += halved;
        publicLine = `🤺 Mutual parry, ${target.participant.displayName} (1d20=${targetRoll.total}) overpowers ${actor.participant.displayName}'s parry (1d20=${actorRoll.total}) and lands a counter with ${targetClassMP.weaponEmoji} ${targetClassMP.weapon} (${counter.expr} → ${counter.total}, halved = ${halved}). ${actor.participant.displayName} HP ${actor.hp}/${actorClassMP.maxHp}.`;
      } else {
        publicLine = `🤺 Mutual parry, both ${actor.participant.displayName} and ${target.participant.displayName} rolled ${actorRoll.total}. Stalemate, no damage.`;
      }
      // Both stances clear, the round is fully resolved.
      actor.stance = "none";
      target.stance = "none";
      return { publicLine, privateLine: null };
    }
    actor.stance = "parry";
    // Same public line as defend, see above.
    return {
      publicLine: `🛡 ${actor.participant.displayName} takes a guarded stance.`,
      privateLine: `🤺 You set a parry stance. If your opponent attacks, you'll contest with 1d20 to negate the hit and counter for half damage.`,
    };
  }
  if (action === "rest") {
    actor.stance = "none";
    const heal = rollDice(2, 6);
    const klass = DUEL_CLASSES[actor.classKey];
    const newHp = Math.min(klass.maxHp, actor.hp + heal.total);
    const actualHeal = newHp - actor.hp;
    actor.hp = newHp;
    return {
      publicLine: `💤 ${actor.participant.displayName} rests (2d6 = ${heal.rolls.join("+")} = ${heal.total}) and recovers ${actualHeal} HP. HP now ${actor.hp}/${klass.maxHp}.`,
      privateLine: null,
    };
  }

  // Attack path.
  const actorClass = DUEL_CLASSES[actor.classKey];
  const targetClass = DUEL_CLASSES[target.classKey];
  const baseDefense = 12;
  const stanceDefense = target.stance === "defend" ? 5 : target.stance === "parry" ? 3 : 0;
  const defense = baseDefense + stanceDefense;

  const attackRoll = rollDice(1, 20);
  const natural = attackRoll.total;
  const totalToHit = natural + actorClass.hitMod;
  const isCrit = natural >= actorClass.critOn;

  // Parry interception: the target rolls 1d20 too; if their roll is
  // strictly greater than the attacker's natural, parry succeeds.
  let parried = false;
  let parryLine = "";
  if (target.stance === "parry") {
    const parryRoll = rollDice(1, 20);
    if (parryRoll.total > natural) {
      parried = true;
      const counter = rollDamage(targetClass, false); // counter never crits
      const halved = Math.floor(counter.total / 2);
      actor.hp = Math.max(0, actor.hp - halved);
      state.totalDamageDealt[targetIdx] += halved;
      parryLine = `🛡 ${target.participant.displayName} parries (1d20=${parryRoll.total} vs ${natural}) and counters with ${targetClass.weaponEmoji} ${targetClass.weapon} (${counter.expr} → ${counter.total}, halved = ${halved}). ${actor.participant.displayName} HP ${actor.hp}/${actorClass.maxHp}.`;
    } else {
      parryLine = `${target.participant.displayName}'s parry fails (1d20=${parryRoll.total} ≤ ${natural}).`;
    }
  }

  let hitLine = "";
  if (!parried) {
    if (totalToHit < defense && natural < 20) {
      hitLine = `${actorClass.weaponEmoji} ${actor.participant.displayName} attacks ${target.participant.displayName} with ${actorClass.weapon} (1d20=${natural}+${actorClass.hitMod}=${totalToHit} vs ${defense}), MISS.`;
    } else {
      const dmg = rollDamage(actorClass, isCrit);
      const reduced = target.stance === "defend" ? Math.floor(dmg.total / 2) : dmg.total;
      target.hp = Math.max(0, target.hp - reduced);
      state.totalDamageDealt[actorIdx] += reduced;
      const critTag = isCrit ? ", CRIT (damage doubled)" : "";
      const reducedTag = target.stance === "defend" ? ` (halved from defend → ${reduced})` : "";
      hitLine = `${actorClass.weaponEmoji} ${actor.participant.displayName} hits ${target.participant.displayName} with ${actorClass.weapon} (1d20=${natural}+${actorClass.hitMod}=${totalToHit} vs ${defense}, ${dmg.expr} → ${dmg.total}${critTag}${reducedTag}). HP ${target.hp}/${targetClass.maxHp}.`;
    }
  }

  // Clear the target's stance, defend/parry only last the inbound
  // turn, not into the next one.
  target.stance = "none";
  // Actor's stance is cleared too (an attack consumes any stance
  // they had set the previous turn).
  actor.stance = "none";

  return {
    publicLine: [parryLine, hitLine].filter(Boolean).join(" "),
    privateLine: null,
  };
}

export function checkDuelEnd(session: GameSession): boolean {
  const state = session.state as DuelState;
  if (state.phase !== "active") return false;
  if (state.challenger.hp <= 0) {
    state.winner = state.defender!.participant;
    state.endReason = "ko";
    state.phase = "ended";
    return true;
  }
  if (state.defender!.hp <= 0) {
    state.winner = state.challenger.participant;
    state.endReason = "ko";
    state.phase = "ended";
    return true;
  }
  return false;
}

export function flipTurn(session: GameSession): void {
  const state = session.state as DuelState;
  state.turn = state.turn === 0 ? 1 : 0;
  state.turnExpiresAt = Date.now() + DUEL_TURN_MS;
}

export function activeFighter(session: GameSession): Fighter | null {
  const state = session.state as DuelState;
  if (state.phase !== "active") return null;
  return state.turn === 0 ? state.challenger : state.defender!;
}

export function fighterIndexFor(session: GameSession, p: ParticipantRef): 0 | 1 | null {
  const state = session.state as DuelState;
  if (state.challenger.participant.userId === p.userId
    && (state.challenger.participant.characterId ?? null) === (p.characterId ?? null)) return 0;
  if (state.defender
    && state.defender.participant.userId === p.userId
    && (state.defender.participant.characterId ?? null) === (p.characterId ?? null)) return 1;
  return null;
}

/* ---------- Forfeit + turn-timeout ---------- */

export function forfeitDuel(session: GameSession, forfeiter: ParticipantRef): void {
  const state = session.state as DuelState;
  state.phase = "ended";
  state.endReason = "forfeit";
  const idx = fighterIndexFor(session, forfeiter);
  state.winner = idx === 0
    ? (state.defender?.participant ?? null)
    : (state.challenger.participant);
}

/**
 * Schedule a turn-timeout that auto-forfeits the active player when
 * fired. Caller must clear the previous timer first by reading
 * `state.turnTimer` and `clearTimeout`. The closure captures the
 * session id so a cancellation race can't mutate a torn-down
 * session.
 */
export function scheduleTurnTimeout(
  session: GameSession,
  ctx: ResolveContext,
): void {
  const state = session.state as DuelState;
  if (state.turnTimer) clearTimeout(state.turnTimer);
  state.turnTimer = setTimeout(async () => {
    const active = activeFighter(session);
    if (!active || state.phase !== "active") return;
    // Treat timeout as a forfeit by the active player.
    forfeitDuel(session, active.participant);
    await cancel(session, ctx);
  }, DUEL_TURN_MS);
}

/* ---------- Resolution ---------- */

async function resolveDuel(session: GameSession, ctx: ResolveContext): Promise<void> {
  if (session.scope.kind !== "room") return;
  const state = session.state as DuelState;
  if (state.turnTimer) clearTimeout(state.turnTimer);
  const lines: string[] = [];

  // Timer expired with no acceptance yet → stamp the endReason so
  // any future audit / inspector reads the right "why" instead of
  // inferring it from the phase. The legacy `state.phase ===
  // "challenge"` branch below still handles the case for back-
  // compat.
  if (state.phase === "challenge" && !state.endReason) {
    state.endReason = "challenge_expired";
  }
  // Same posture for the (very rare) case where the registry-level
  // 30-min session timer fires while the duel is still mid-fight,
  // the per-turn timer chain should have forfeited someone long
  // before, but if for any reason it didn't we mark the endReason
  // here and fall through to the no-winner branch so the room sees
  // a sensible line.
  if (state.phase === "active" && !state.endReason) {
    state.endReason = "forfeit";
  }

  if (state.endReason === "challenge_expired") {
    lines.push(`⚔️ ${state.challenger.participant.displayName}'s duel challenge to ${state.pendingOpponent?.displayName ?? "their opponent"} expired with no response.`);
    await addSystemMessage(ctx.io, ctx.db, session.scope.roomId, lines.join("\n"));
    return;
  }
  if (state.endReason === "challenge_declined") {
    lines.push(`⚔️ ${state.challenger.participant.displayName}'s duel challenge was declined.`);
    await addSystemMessage(ctx.io, ctx.db, session.scope.roomId, lines.join("\n"));
    return;
  }

  // Winner / loser. Identify by (userId, characterId) tuple rather
  // than object identity, `state.winner` is currently always
  // assigned from one of the two fighter slots and so reference
  // equality works today, but a future code path that constructed
  // a fresh ParticipantRef would silently flip every duel into the
  // "no clear winner" branch. id-based comparison is robust to
  // that drift.
  const winner = state.winner;
  const winnerIsChallenger = winner != null
    && winner.userId === state.challenger.participant.userId
    && (winner.characterId ?? null) === (state.challenger.participant.characterId ?? null);
  const loser = winner
    ? (winnerIsChallenger ? state.defender?.participant : state.challenger.participant)
    : undefined;
  const reasonText = state.endReason === "ko" ? "down" : "forfeits";

  const defenderLabel = state.defender ? DUEL_CLASSES[state.defender.classKey].label : "?";
  lines.push(`⚔️ Duel, ${state.challenger.participant.displayName} (${DUEL_CLASSES[state.challenger.classKey].label}) vs ${state.defender?.participant.displayName ?? "?"} (${defenderLabel}).`);
  if (winner && loser) {
    lines.push(`${loser.displayName} ${reasonText}. ${winner.displayName} wins!`);
    lines.push(`Damage dealt, ${state.challenger.participant.displayName}: ${state.totalDamageDealt[0]}, ${state.defender?.participant.displayName ?? "?"}: ${state.totalDamageDealt[1]}.`);
    // Reward scaling. Both fighters get a multiplier from the
    // damage stats, but the loser only gets XP at 0.25x of their
    // own calculation, no currency or item. KO and forfeit are
    // treated the same here, the forfeit-by-quit and the forfeit-
    // by-turn-timeout both still count as a win for the other side
    // so the winner is paid and the loser still earns some XP for
    // their effort. Quiet game (no admin-configured reward) skips
    // the mint pipeline entirely but still surfaces the winnings
    // line via formatWinningsLine below.
    const winnerIdx: 0 | 1 = winnerIsChallenger ? 0 : 1;
    const loserIdx: 0 | 1 = winnerIsChallenger ? 1 : 0;
    const winnerMult = duelMultiplier(state.totalDamageDealt[winnerIdx], state.totalDamageDealt[loserIdx]);
    const loserMult = duelMultiplier(state.totalDamageDealt[loserIdx], state.totalDamageDealt[winnerIdx]) * 0.25;
    if (rewardIsNonZero(state.reward)) {
      await mintRewardForWinner(ctx.db, ctx.io, winner, state.reward, "duel_win", { multiplier: winnerMult });
      if (state.reward.xp > 0) {
        // Loser's XP-only consolation reward. Strip currency + item
        // so the loser doesn't walk away with the shop prize they
        // didn't win; the XP rewards the time spent in the fight.
        const loserReward: BuiltinCommandReward = {
          xp: state.reward.xp,
          currency: 0,
          itemKey: null,
          itemCount: 0,
        };
        await mintRewardForWinner(ctx.db, ctx.io, loser, loserReward, "duel_loss", { multiplier: loserMult });
      }
    }
    const winningsLine = await formatWinningsLine(
      ctx.db,
      DUEL_KIND,
      [winner],
      state.reward,
      { multiplier: winnerMult },
    );
    if (winningsLine) lines.push(winningsLine);
    if (state.reward.xp > 0) {
      const loserXp = Math.round(state.reward.xp * loserMult);
      if (loserXp > 0) {
        lines.push(`📚 ${loser.displayName} earns ${loserXp} XP for the effort.`);
      }
    }
  } else {
    lines.push("Duel ended with no clear winner.");
  }

  await addSystemMessage(ctx.io, ctx.db, session.scope.roomId, lines.join("\n"));
}

/* ---------- Reward scaling ---------- */

/**
 * Compute the duel reward multiplier from a fighter's damage stats.
 * Rewards rise with damage DEALT and fall with damage RECEIVED, so
 * a long methodical fight where the fighter took little damage pays
 * out more than a sloppy back-and-forth that ended luckily. Used by
 * BOTH the winner (full payout) and the loser (XP-only at 0.25x of
 * this same calculation, see resolveDuel).
 *
 * Formula:
 *   raw = damageDealt / max(damageReceived, 25)
 *   clamped to [0.5, 5]
 *
 * The denominator floor of 25 keeps a flawless sweep (took zero) from
 * blowing the multiplier to infinity. The [0.5, 5] clamp keeps any
 * single duel's payout within a 10× window end-to-end, so the admin
 * can tune base rewards without worrying about a single lucky fight
 * draining the configured pool.
 */
export function duelMultiplier(damageDealt: number, damageReceived: number): number {
  const raw = damageDealt / Math.max(damageReceived, 25);
  return Math.max(0.5, Math.min(5, raw));
}

/* ---------- Dice + damage helpers ---------- */

function rollDice(count: number, faces: number): { rolls: number[]; total: number } {
  const rolls: number[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const r = 1 + Math.floor(Math.random() * faces);
    rolls.push(r);
    total += r;
  }
  return { rolls, total };
}

function rollDamage(klass: DuelClass, crit: boolean): { rolls: number[]; total: number; expr: string } {
  const base = rollDice(klass.damage.count, klass.damage.faces);
  const damage = base.total + klass.damage.bonus;
  const finalTotal = crit ? damage * 2 : damage;
  const expr = `${klass.damage.count}d${klass.damage.faces}${klass.damage.bonus ? `+${klass.damage.bonus}` : ""}${crit ? " ×2" : ""}`;
  return { rolls: base.rolls, total: finalTotal, expr };
}

export function registerDuel(): void {
  registerGameKind(DUEL_KIND, {
    onResolve: resolveDuel,
    onCancel: resolveDuel,
  });
}
