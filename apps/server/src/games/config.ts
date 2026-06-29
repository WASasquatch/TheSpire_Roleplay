/**
 * Built-in command admin config, read + award helpers.
 *
 * Every social-game command is defined in code with sensible
 * defaults (window duration, zero rewards). Admins can override
 * those via the admin Commands tab's "Built-ins" panel; rows land
 * in `builtin_command_config` and are read here on each game
 * start (duration) and game end (reward minting).
 *
 * Two halves:
 *   - `getBuiltinCommandConfig(db, name, codeDefaults)`, resolves
 *     the effective config for a command. Returns the merged shape:
 *     admin-set values where present, code defaults where the admin
 *     left a field blank. The handler reads this once per game and
 *     passes it through the session state.
 *   - `mintRewardForWinner(db, io, winner, reward, source)`,
 *     credits the configured XP / Currency / item to a single
 *     winner. Multi-winner rounds (e.g. RPS group elim) call this
 *     once per winner, each gets the FULL configured amount, per
 *     the design decision baked in on day one.
 *
 * Idempotency: the caller is responsible for de-duplication. Each
 * mint writes a separate ledger row + inventory delta; calling
 * twice for the same (game, winner) double-pays.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { builtinCommandConfig, gameStats, identityInventory, items } from "../db/schema.js";
import { creditPool } from "../earning/award.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

export interface BuiltinCommandReward {
  /** XP to mint per winner. 0 = no XP award. */
  xp: number;
  /** Currency to mint per winner. 0 = no Currency award. */
  currency: number;
  /** Optional item from the shop catalog. Null = no item reward. */
  itemKey: string | null;
  /** Item count when itemKey is set. 0 with a non-null key is a
   *  no-op; the route handler normalizes to 0 itemCount when itemKey
   *  is null to keep the wire shape clean. */
  itemCount: number;
}

export interface BuiltinCommandConfig {
  /** Effective game window in ms. Falls back to the code default
   *  when the admin hasn't overridden. */
  durationMs: number;
  reward: BuiltinCommandReward;
}

/**
 * Resolve the live config for a command. Admin-set values win; code
 * defaults fill the gaps. `codeDefaults.durationMs` is the value
 * the game module would have used pre-config, it's what runs when
 * no row exists yet OR when the admin explicitly leaves duration
 * blank. `codeDefaults.reward` (optional) is the reward shape the
 * game ships with, used ONLY when no admin row exists at all — the
 * moment an admin touches the panel and saves, their values
 * (including explicit zeros) take precedence so an admin who wants
 * to disable rewards for a command can do so by saving an all-zero
 * config.
 */
export async function getBuiltinCommandConfig(
  db: Db,
  commandName: string,
  codeDefaults: { durationMs: number; reward?: BuiltinCommandReward },
): Promise<BuiltinCommandConfig> {
  const row = (await db
    .select()
    .from(builtinCommandConfig)
    .where(eq(builtinCommandConfig.commandName, commandName.toLowerCase()))
    .limit(1))[0];
  if (!row) {
    return {
      durationMs: codeDefaults.durationMs,
      reward: codeDefaults.reward ?? emptyReward(),
    };
  }
  return {
    durationMs: row.durationMs ?? codeDefaults.durationMs,
    reward: {
      xp: row.rewardXp,
      currency: row.rewardCurrency,
      itemKey: row.rewardItemKey,
      // Normalize: itemCount only matters when itemKey is set. A row
      // with a non-null key + zero count is a no-op item award.
      itemCount: row.rewardItemKey ? row.rewardItemCount : 0,
    },
  };
}

function emptyReward(): BuiltinCommandReward {
  return { xp: 0, currency: 0, itemKey: null, itemCount: 0 };
}

/** Whether a reward has any payout configured. Cheap pre-check so
 *  game modules can skip the mint pipeline entirely on the common
 *  "admin hasn't tuned this game yet" path. */
export function rewardIsNonZero(reward: BuiltinCommandReward): boolean {
  return reward.xp > 0
    || reward.currency > 0
    || (!!reward.itemKey && reward.itemCount > 0);
}

/**
 * Round-based games (currently /scramble) produce a "winner score"
 * instead of a binary win. The score scales XP and Currency payouts
 * via this multiplier, players who accumulate more points across
 * the multi-round chain earn proportionally more, capped so a single
 * marathon run can't drain the configured pool.
 *
 * Curve:
 *   - 0 points (lost or didn't play): 1× (floor, still awards the
 *     configured base if reward is set; we don't punish lousy luck).
 *   - 100 points: 1×.
 *   - 200 points: 2×.
 *   - 1000+ points: 10× (cap).
 *
 * Item rewards are deliberately NOT scaled, a winner either gets
 * the configured item count or none. Scaling item counts would let
 * a single high-scoring game flood inventory in ways admins can't
 * predict at config time.
 */
export function computePointMultiplier(points: number): number {
  if (points <= 100) return 1;
  return Math.min(10, points / 100);
}

/**
 * Identity ref the mint pipeline accepts. Mirrors the
 * `ParticipantRef` shape from the registry but trimmed to the
 * fields actually needed for crediting: master id + character id
 * pin the pool, displayName is used only for ledger labels +
 * result-line phrasing the caller already does.
 */
export interface RewardTarget {
  userId: string;
  characterId: string | null;
}

/**
 * Credit one winner with the configured reward. XP/Currency go
 * through `creditPool` (which writes the ledger row + recomputes
 * rank + fires the socket events); the optional item is added
 * directly to the winner's inventory.
 *
 * `source` is a short tag like "rps_win" or "duel_win", embedded
 * into the credit's `reason` field so the activity ledger reads
 * cleanly ("Won at Rock-paper-scissors" / "Won a Duel" / etc.).
 * The caller passes a human label for the result message; the tag
 * is the machine-readable side.
 *
 * Errors are logged but never thrown, a failed reward shouldn't
 * tear down the result-message broadcast or crash the resolver.
 */
export async function mintRewardForWinner(
  db: Db,
  io: Io,
  winner: RewardTarget,
  reward: BuiltinCommandReward,
  source: string,
  options?: {
    multiplier?: number;
    /** Per-server economy partition the reward lands on. Defaults to the
     *  default server; with the servers flag off it's the only pool, so the
     *  reward credits exactly today's pool. (Game callers can pass the
     *  room's serverId in a later pass.) */
    serverId?: string;
  },
): Promise<void> {
  if (!rewardIsNonZero(reward)) return;
  const serverId = options?.serverId ?? DEFAULT_SERVER_ID;
  // Floor at 0 (not 1) so the duel system can pass a sub-1
  // multiplier for sloppy fights or for the loser's partial-credit
  // payout. Callers that want a >=1 floor pre-clamp before calling.
  const multiplier = Math.max(0, options?.multiplier ?? 1);
  const scaledXp = Math.round(reward.xp * multiplier);
  const scaledCurrency = Math.round(reward.currency * multiplier);
  const winnerScope: "user" | "character" = winner.characterId ? "character" : "user";
  const winnerOwnerId = winner.characterId ?? winner.userId;
  try {
    if (scaledXp > 0 || scaledCurrency > 0) {
      await creditPool(db, io as never, {
        serverId,
        scope: winnerScope,
        ownerId: winnerOwnerId,
        xpDelta: scaledXp,
        currencyDelta: scaledCurrency,
        reason: source,
        notifyUserId: winner.userId,
      });
    }
    if (reward.itemKey && reward.itemCount > 0) {
      // Item count deliberately unscaled, see computePointMultiplier docs.
      await creditItem(db, serverId, winnerScope, winnerOwnerId, reward.itemKey, reward.itemCount);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[games] mintRewardForWinner failed", {
      source,
      winnerUserId: winner.userId,
      err,
    });
  }
}

/**
 * Small upsert helper for crediting an item to a winner's
 * inventory. Same pattern the raffle uses, kept inline here so
 * the games module doesn't have to import out of `commands/builtins/items`.
 *
 * Stack-cap deliberately NOT enforced (matches the site-wide rule
 * that lifted item caps; see migration 0193 era).
 */
async function creditItem(
  db: Db,
  serverId: string,
  scope: "user" | "character",
  ownerId: string,
  itemKey: string,
  count: number,
): Promise<void> {
  // Verify the item still exists (an admin could have deleted it
  // between configuration and game-end). Silent no-op when the
  // referenced item is gone.
  const itemRow = (await db.select().from(items).where(eq(items.key, itemKey)).limit(1))[0];
  if (!itemRow) return;
  const existing = (await db
    .select({ qty: identityInventory.quantity })
    .from(identityInventory)
    .where(and(
      eq(identityInventory.serverId, serverId),
      eq(identityInventory.ownerScope, scope),
      eq(identityInventory.ownerId, ownerId),
      eq(identityInventory.itemKey, itemKey),
    ))
    .limit(1))[0];
  if (existing) {
    await db.update(identityInventory)
      .set({ quantity: existing.qty + count, updatedAt: new Date() })
      .where(and(
        eq(identityInventory.serverId, serverId),
        eq(identityInventory.ownerScope, scope),
        eq(identityInventory.ownerId, ownerId),
        eq(identityInventory.itemKey, itemKey),
      ));
  } else {
    await db.insert(identityInventory).values({
      serverId,
      ownerScope: scope,
      ownerId,
      itemKey,
      quantity: count,
    });
  }
}

/**
 * Render a reward as a chat-friendly suffix the result-message
 * builder appends. Returns empty string when nothing was awarded so
 * the caller can concatenate unconditionally. Item display uses the
 * catalog `name`; admins set the key but readers see the friendly
 * name in the result line.
 */
export async function describeReward(
  db: Db,
  reward: BuiltinCommandReward,
  options?: { multiplier?: number },
): Promise<string> {
  const multiplier = Math.max(0, options?.multiplier ?? 1);
  const scaledXp = Math.round(reward.xp * multiplier);
  const scaledCurrency = Math.round(reward.currency * multiplier);
  const parts: string[] = [];
  if (scaledXp > 0) parts.push(`${scaledXp} XP`);
  if (scaledCurrency > 0) parts.push(`${scaledCurrency} Currency`);
  if (reward.itemKey && reward.itemCount > 0) {
    const itemRow = (await db.select({ name: items.name }).from(items).where(eq(items.key, reward.itemKey)).limit(1))[0];
    const itemName = itemRow?.name ?? reward.itemKey;
    parts.push(reward.itemCount === 1 ? itemName : `${itemName} ×${reward.itemCount}`);
  }
  if (parts.length === 0) return "";
  const suffix = multiplier > 1
    ? ` (${multiplier.toFixed(1)}× bonus)`
    : multiplier < 1
      ? ` (${multiplier.toFixed(2)}×)`
      : "";
  return ` Reward: ${parts.join(" + ")}.${suffix}`;
}

/**
 * A winner of a single game round. Combines the identity tuple
 * needed for stats recording (userId / characterId) with the
 * display name used for the broadcast line.
 */
export interface GameWinner {
  userId: string;
  characterId: string | null;
  displayName: string;
  /** Optional game-specific score. Defaults to 1 (binary win). For
   *  accumulating-score games like /scramble, pass the winner's
   *  total points; rankings can then sort by score as well as
   *  raw win count. */
  points?: number;
}

/**
 * Record one win in `game_stats` for the given winner + game kind.
 * Upserts the row: creates fresh with wins=1 / points=delta on
 * first win, increments both on subsequent wins. Idempotent at the
 * statement level but NOT at the call level, calling twice for the
 * same (winner, game) double-counts. The resolver is the single
 * caller per game end, so double-call only happens on a coding
 * error.
 *
 * The owner_scope vs owner_id split mirrors the rest of the per-
 * identity model: a master playing OOC credits themselves, a
 * character credits the character. Master and characters do NOT
 * share rows, viewing a master's profile shows only their OOC
 * wins, viewing a character's profile shows only that character's
 * wins.
 */
async function recordGameWin(
  db: Db,
  gameKind: string,
  winner: GameWinner,
): Promise<void> {
  const scope: "user" | "character" = winner.characterId ? "character" : "user";
  const ownerId = winner.characterId ?? winner.userId;
  const pointDelta = Math.max(1, winner.points ?? 1);
  const now = new Date();
  try {
    await db
      .insert(gameStats)
      .values({
        ownerScope: scope,
        ownerId,
        gameKind,
        wins: 1,
        points: pointDelta,
        lastWonAt: now,
      })
      .onConflictDoUpdate({
        target: [gameStats.ownerScope, gameStats.ownerId, gameStats.gameKind],
        set: {
          wins: sql`${gameStats.wins} + 1`,
          points: sql`${gameStats.points} + ${pointDelta}`,
          lastWonAt: now,
        },
      });
  } catch (err) {
    // Non-fatal, missing a stat row shouldn't fail the broadcast.
    // eslint-disable-next-line no-console
    console.error("[games] recordGameWin failed", {
      gameKind,
      winnerUserId: winner.userId,
      err,
    });
  }
}

/**
 * Build the end-of-game winnings line that EVERY social-game
 * resolver broadcasts when a winner is named, AND record the win
 * in `game_stats` so the rankings page picks it up automatically.
 * Adding a new game kind = wiring its resolver to call this; no
 * extra plumbing for rankings is needed.
 *
 * Unlike `describeReward` (which returns empty when nothing was
 * configured), this always returns a complete sentence so the
 * room sees what the winner walked away with. Zero-reward games
 * get a bragging-rights line.
 *
 * Group-elim winners (RPS) and tied winners (scramble, story dice)
 * pass the full list; each winner is credited the same amount via
 * the mint pipeline AND each gets their own stat row update.
 */
export async function formatWinningsLine(
  db: Db,
  gameKind: string,
  winners: ReadonlyArray<GameWinner>,
  reward: BuiltinCommandReward,
  options?: { multiplier?: number },
): Promise<string> {
  if (winners.length === 0) return "";
  // Record stats for each winner. Failures are logged + swallowed
  // inside recordGameWin so a DB hiccup can't tear down the broadcast.
  for (const w of winners) {
    await recordGameWin(db, gameKind, w);
  }
  const multiplier = Math.max(0, options?.multiplier ?? 1);
  const scaledXp = Math.round(reward.xp * multiplier);
  const scaledCurrency = Math.round(reward.currency * multiplier);
  const parts: string[] = [];
  if (scaledXp > 0) parts.push(`${scaledXp} XP`);
  if (scaledCurrency > 0) parts.push(`${scaledCurrency} Currency`);
  if (reward.itemKey && reward.itemCount > 0) {
    const itemRow = (await db.select({ name: items.name }).from(items).where(eq(items.key, reward.itemKey)).limit(1))[0];
    const itemName = itemRow?.name ?? reward.itemKey;
    parts.push(reward.itemCount === 1 ? itemName : `${itemName} ×${reward.itemCount}`);
  }
  const names = winners.map((w) => w.displayName);
  const subject = names.length === 1
    ? names[0]
    : names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  const verbWalks = names.length === 1 ? "walks" : "walk";
  if (parts.length === 0) {
    return `🎁 ${subject} ${verbWalks} away with bragging rights this round.`;
  }
  const each = names.length === 1 ? "" : " each";
  const bonus = multiplier > 1
    ? ` (${multiplier.toFixed(1)}× bonus)`
    : multiplier < 1
      ? ` (${multiplier.toFixed(2)}×)`
      : "";
  return `🎁 ${subject}${each} ${verbWalks} away with ${parts.join(" + ")}.${bonus}`;
}
