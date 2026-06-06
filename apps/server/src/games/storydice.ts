/**
 * Story Dice, the server picks four evocative prompt words; the
 * room writes IC snippets that weave all four in. Winner is decided
 * by the room itself: each `/storydice <text>` submission posts as
 * a stylized chat line (bolded header + indented body) so the
 * entry stands apart from normal chatter, the server seeds a 📖
 * reaction so the voting chip is right there for tappers, and the
 * room books-up whichever submissions they liked best. At expiry
 * the system counts 📖 reactions per submission (subtracting the
 * seed), crowns the top-voted entrant(s), and mints the
 * configured reward.
 *
 * Lifecycle:
 *   - `/storydice` opens a round in the current room with four
 *     random prompt words drawn from the bank below.
 *   - During the window, anyone runs `/storydice <text>` to submit
 *     a post. The text is posted to chat as a stylized `say` line
 *     attributed to the player (header + blockquoted body); the
 *     system seeds a 📖 reaction on it. One submission per
 *     identity, resubmitting is rejected so a player can't dilute
 *     their own vote with multiple posts.
 *   - At expiry, the resolver reads the 📖 count for each
 *     submission, subtracts 1 (the seed), and surfaces the result
 *     line listing each entrant and their vote total. The highest
 *     vote total (or tied set) wins; the reward mints to each
 *     winner. Empty vote pool → uniform random pick so the round
 *     always names someone.
 *
 * Why the host doesn't pick: an earlier draft had `/storydice pick
 * <name>` for the host to crown a winner. That defeated the
 * sociable point of the game, the ROOM should celebrate the post
 * it liked best, not one person. The current design also makes the
 * game self-balancing for tone: rooms vote up posts that match the
 * vibe they're after, so trolling submissions naturally lose.
 */

import { eq, and, inArray, sql } from "drizzle-orm";
import {
  registerGameKind,
  type GameSession,
  type IdentityKey,
  type ParticipantRef,
  type ResolveContext,
} from "./registry.js";
import { addSystemMessage } from "../realtime/broadcast.js";
import { messageReactions, users } from "../db/schema.js";
import {
  formatWinningsLine,
  getBuiltinCommandConfig,
  mintRewardForWinner,
  rewardIsNonZero,
  type BuiltinCommandReward,
} from "./config.js";
import { nanoid } from "nanoid";
import type { Db } from "../db/index.js";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ReactionEvent, ServerToClientEvents } from "@thekeep/shared";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

export const STORYDICE_KIND = "storydice";
export const STORYDICE_COMMAND_NAME = "storydice";
export const STORYDICE_WINDOW_MS = 180_000;
export const STORYDICE_PROMPT_COUNT = 4;

/** Out-of-the-box reward for the room-voted winner(s). Sits highest
 *  among the social games because the player actually wrote a piece
 *  of fiction the room judged best, that's a real creative effort
 *  compared to a guess or a throw. Ties split nothing here, each
 *  winner picks up the full amount independently. */
export const STORYDICE_DEFAULT_REWARD: BuiltinCommandReward = {
  xp: 20,
  currency: 10,
  itemKey: null,
  itemCount: 0,
};

/** The 📖 codepoint we use for the seed AND the count-target.
 *  Other emoji from the room still appear on the submission chip
 *  but don't influence the winner determination. The open-book
 *  glyph reads as "story / read / vote-for-this-tale" cleanly,
 *  which fits Story Dice's framing better than the generic thumbs
 *  up the system used at first launch. */
export const STORYDICE_VOTE_EMOJI = "📖";
const STORYDICE_VOTE_LABEL = "open book";

/** Prompt word bank. Curated for breadth + evocativeness; mostly
 *  concrete nouns + a few abstract concepts so players have hooks
 *  to write around without the prompts dictating tone. */
const PROMPT_BANK: ReadonlyArray<string> = [
  // Settings + places
  "lantern", "tavern", "harbor", "alley", "rooftop", "garden", "crossroads",
  "bridge", "ruins", "library", "marketplace", "shrine", "tower", "graveyard",
  // Objects
  "letter", "mirror", "compass", "feather", "blade", "key", "mask", "coin",
  "music box", "locket", "scroll", "bell", "ring", "candle", "ledger",
  // Weather + time
  "fog", "frost", "thunder", "twilight", "dawn", "eclipse", "rain",
  // Abstract / emotional
  "oath", "regret", "promise", "secret", "rumor", "memory", "echo", "rust",
  "grief", "mercy", "hunger", "fortune", "betrayal", "homecoming",
  // Creatures + presences
  "raven", "wolf", "owl", "stranger", "ghost", "messenger", "fugitive",
  // Materials + textures
  "velvet", "iron", "salt", "silver", "ink", "ash", "honey", "crimson",
];

export interface StoryDiceSubmission {
  participant: ParticipantRef;
  /** Chat-message id the player's text was posted as. The resolver
   *  reads reaction counts off this row to determine the vote
   *  tally; the seed 📖 was already attached at submission time. */
  messageId: string;
  /** Verbatim text the player submitted. Stored for the result
   *  line so the resolver doesn't need to re-fetch the message row
   *  for transcript display. */
  text: string;
}

export interface StoryDiceState {
  prompts: string[];
  submissions: Map<IdentityKey, StoryDiceSubmission>;
  reward: BuiltinCommandReward;
}

export async function readStoryDiceConfig(db: Db): Promise<{
  windowMs: number;
  reward: BuiltinCommandReward;
}> {
  const cfg = await getBuiltinCommandConfig(db, STORYDICE_COMMAND_NAME, {
    durationMs: STORYDICE_WINDOW_MS,
    reward: STORYDICE_DEFAULT_REWARD,
  });
  return { windowMs: cfg.durationMs, reward: cfg.reward };
}

/** Pick N distinct prompts from the bank. Fisher-Yates partial
 *  shuffle so order doesn't bias the first few words. */
export function rollPrompts(): string[] {
  const pool = PROMPT_BANK.slice();
  const out: string[] = [];
  for (let i = 0; i < STORYDICE_PROMPT_COUNT && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool[idx]!);
    pool.splice(idx, 1);
  }
  return out;
}

export function newStoryDiceState(reward: BuiltinCommandReward): StoryDiceState {
  return {
    prompts: rollPrompts(),
    submissions: new Map(),
    reward,
  };
}

/**
 * Record a new submission. Returns false when the identity already
 * has an entry on this round, story dice is one-submission-per-
 * identity by design (a resubmit would dilute their own vote).
 * Caller has already posted the chat message + seeded the 📖
 * reaction before calling.
 */
export function recordStorySubmission(
  session: GameSession,
  key: IdentityKey,
  submission: StoryDiceSubmission,
): boolean {
  const state = session.state as StoryDiceState;
  if (state.submissions.has(key)) return false;
  state.submissions.set(key, submission);
  return true;
}

/**
 * Attach the seed vote reaction (📖) to a freshly-posted
 * submission. The reactor is the singleton `system` user (the same
 * row `addSystemMessage` uses) so the chip renders as a generic
 * 1-count 📖 the room can tap to add their own vote. Returns true
 * on success; false (silently) on a missing system user row, which
 * means the round still runs but the chip won't be pre-seeded.
 *
 * Note on the inserted row's `displayName`: we use "system" so the
 * reactor-list tooltip ("Reactors: …") reads cleanly without
 * leaking real account names from server-authored votes.
 */
export async function seedSubmissionVote(
  db: Db,
  io: Io,
  roomId: string,
  messageId: string,
): Promise<boolean> {
  const sysUser = (await db.select().from(users).where(eq(users.username, "system")).limit(1))[0];
  if (!sysUser) return false;
  const now = new Date();
  // Defensive: idempotent against double-seed (which shouldn't
  // happen, submissions are one-per-identity, but a hot-reload
  // mid-development could re-run the seeding).
  const existing = (await db.select({ id: messageReactions.id })
    .from(messageReactions)
    .where(and(
      eq(messageReactions.targetKind, "chat_message"),
      eq(messageReactions.targetId, messageId),
      eq(messageReactions.userId, sysUser.id),
      eq(messageReactions.unicodeChar, STORYDICE_VOTE_EMOJI),
    ))
    .limit(1))[0];
  if (existing) return true;
  await db.insert(messageReactions).values({
    id: nanoid(),
    targetKind: "chat_message",
    targetId: messageId,
    userId: sysUser.id,
    characterId: null,
    displayName: "system",
    sheetId: null,
    cellIndex: null,
    unicodeChar: STORYDICE_VOTE_EMOJI,
    createdAt: now,
  });
  // Broadcast the new reaction so live viewers see the chip
  // immediately. Matches the wire shape the toggle endpoint emits
  // so the renderer doesn't need a special path.
  const event: ReactionEvent = {
    targetKind: "chat_message",
    targetId: messageId,
    ref: { kind: "unicode", char: STORYDICE_VOTE_EMOJI },
    label: STORYDICE_VOTE_LABEL,
    op: "add",
    actor: {
      userId: sysUser.id,
      characterId: null,
      displayName: "system",
      reactedAt: +now,
    },
  };
  io.to(`room:${roomId}`).emit("reaction:update", event);
  return true;
}

/**
 * Load the 📖 reaction count for a set of message ids in one query.
 * Returns a Map<messageId, count>. Counts include the system seed,
 * so the resolver subtracts 1 to get the "real" room votes.
 *
 * We constrain on `unicodeChar = "📖"` so other reactions the room
 * added (a 🔥 for an exceptional submission, a 💀 for a meme-y one)
 * still render on the chip but don't count toward Story Dice
 * winner selection. The vote is specifically the open-book glyph.
 */
async function loadVoteCounts(
  db: Db,
  messageIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (messageIds.length === 0) return out;
  // Constrain the SQL scan to just the submission message ids the
  // resolver cares about. A pre-fix version filtered in memory,
  // which scanned the entire site-wide 👍 history on every round,
  // fine on a fresh install, terrible as reactions accumulate.
  const rows = await db
    .select({
      targetId: messageReactions.targetId,
      n: sql<number>`COUNT(*)`,
    })
    .from(messageReactions)
    .where(and(
      eq(messageReactions.targetKind, "chat_message"),
      eq(messageReactions.unicodeChar, STORYDICE_VOTE_EMOJI),
      inArray(messageReactions.targetId, messageIds),
    ))
    .groupBy(messageReactions.targetId);
  for (const r of rows) {
    out.set(r.targetId, Number(r.n ?? 0));
  }
  return out;
}

function usesAllPrompts(text: string, prompts: ReadonlyArray<string>): boolean {
  const lower = text.toLowerCase();
  return prompts.every((p) => lower.includes(p.toLowerCase()));
}

async function resolveStoryDice(session: GameSession, ctx: ResolveContext): Promise<void> {
  if (session.scope.kind !== "room") return;
  const state = session.state as StoryDiceState;
  const subs = Array.from(state.submissions.values());
  const lines: string[] = [];
  lines.push(`📜 Story Dice, ${session.host.displayName}'s prompts: ${state.prompts.join(", ")}.`);

  if (subs.length === 0) {
    lines.push("No submissions. The room was quiet today.");
    await addSystemMessage(ctx.io, ctx.db, session.scope.roomId, lines.join("\n"));
    return;
  }

  // Count the real (non-seed) votes per submission. The seed adds 1,
  // so we subtract, a submission nobody else voted on reads as 0.
  const countByMessageId = await loadVoteCounts(ctx.db, subs.map((s) => s.messageId));
  interface TalliedSub {
    submission: StoryDiceSubmission;
    /** Total 👍 reactions on the chat message, including the seed. */
    rawCount: number;
    /** rawCount - 1 (the seed). Clamped at 0 in case the seed was
     *  missing (no system user, idempotent skip, etc.). */
    votes: number;
    usedAllPrompts: boolean;
  }
  const tallied: TalliedSub[] = subs.map((s) => {
    const raw = countByMessageId.get(s.messageId) ?? 0;
    return {
      submission: s,
      rawCount: raw,
      votes: Math.max(0, raw - 1),
      usedAllPrompts: usesAllPrompts(s.text, state.prompts),
    };
  });

  // Sort: votes DESC, then "used all four prompts" first so a tied
  // pair where only one wove all four prompts gets the nod. Final
  // tiebreaker is preserve-insertion-order so the result line reads
  // in submission order at the top.
  tallied.sort((a, b) => {
    if (b.votes !== a.votes) return b.votes - a.votes;
    if (a.usedAllPrompts !== b.usedAllPrompts) return a.usedAllPrompts ? -1 : 1;
    return 0;
  });

  // Transcript: every submission with its vote count + prompt-
  // completion check. Vote count shown as just the room votes so
  // readers don't have to mentally subtract the seed.
  for (const t of tallied) {
    const completeMark = t.usedAllPrompts ? "" : " (missed a prompt)";
    const vote = t.votes === 0 ? "no extra votes" : t.votes === 1 ? "1 vote" : `${t.votes} votes`;
    lines.push(` , ${t.submission.participant.displayName} (${vote}${completeMark}): ${t.submission.text}`);
  }

  // Winner determination. Highest vote tally wins; ties share the
  // win. If nobody got any extra votes, pick uniformly at random
  // among submissions that wove all four prompts (or all if none
  // did) so the round always names someone.
  let winners: ParticipantRef[];
  const topVotes = tallied[0]?.votes ?? 0;
  if (topVotes > 0) {
    winners = tallied
      .filter((t) => t.votes === topVotes)
      .map((t) => t.submission.participant);
  } else {
    const compliant = tallied.filter((t) => t.usedAllPrompts);
    const pool = compliant.length > 0 ? compliant : tallied;
    const pick = pool[Math.floor(Math.random() * pool.length)]!;
    winners = [pick.submission.participant];
  }

  if (topVotes > 0) {
    if (winners.length === 1) {
      lines.push(`The room crowned ${winners[0]!.displayName} with ${topVotes === 1 ? "1 vote" : `${topVotes} votes`}.`);
    } else {
      const names = winners.map((w) => w.displayName).join(", ");
      lines.push(`Tied at ${topVotes === 1 ? "1 vote" : `${topVotes} votes`} each, winners: ${names}.`);
    }
  } else {
    lines.push(`No room votes, drawn at random: ${winners[0]!.displayName}.`);
  }

  if (rewardIsNonZero(state.reward)) {
    for (const w of winners) {
      await mintRewardForWinner(ctx.db, ctx.io, w, state.reward, "storydice_win");
    }
  }
  const winningsLine = await formatWinningsLine(
    ctx.db,
    STORYDICE_KIND,
    winners,
    state.reward,
  );
  if (winningsLine) lines.push(winningsLine);

  await addSystemMessage(ctx.io, ctx.db, session.scope.roomId, lines.join("\n"));
}

export function registerStoryDice(): void {
  registerGameKind(STORYDICE_KIND, {
    onResolve: resolveStoryDice,
    onCancel: resolveStoryDice,
  });
}
