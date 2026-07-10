/**
 * Social-game slash commands: /rps, /raffle, /claim, /announceraffle.
 *
 * The game logic + escrow primitives live in apps/server/src/games/;
 * this file is just the command-surface glue, parse args, validate,
 * stand up a session via the registry, post the start notice,
 * and (for `/claim`) bind to whichever raffle is active in the
 * caller's scope.
 *
 * Permission posture (matches the spirit of the existing /give and
 * /announce gating):
 *   - /rps, /raffle, /claim, no perm gate. Open to anyone who can
 *     post in chat. Anti-spam relies on (a) the one-active-session-
 *     per-room cap in the registry and (b) the same mute/role
 *     mechanism that gates every other chat command.
 *   - /announceraffle, `announce_sitewide` permission, mirroring
 *     /announce all. Same admin-tier gate, same audit posture.
 *
 * State + escrow:
 *   - RPS keeps a Map<identityKey, RpsEntry> in the session state;
 *     overwriting an existing entry is fine (you can change your
 *     mind before time runs out).
 *   - Raffles debit the host's inventory (item raffle) or wallet
 *     (currency raffle) at start time. Refunds and payouts run from
 *     the per-kind onResolve / onCancel hooks the modules registered.
 */

import { eq } from "drizzle-orm";
import {
  cancel,
  findActiveForRoom,
  findRoomSession,
  findSitewideSession,
  identityKeyFor,
  startSession,
  SessionConflictError,
  type ParticipantRef,
} from "../../games/registry.js";
import {
  RPS_KIND,
  newRpsState,
  parseRpsThrow,
  readRpsConfig,
  recordRpsEntry,
  type RpsState,
} from "../../games/rps.js";
import {
  TRIVIA_KIND,
  newTriviaState,
  parseTriviaArgs,
  readTriviaConfig,
  recordTriviaGuess,
} from "../../games/trivia.js";
import {
  STORYDICE_KIND,
  newStoryDiceState,
  readStoryDiceConfig,
  recordStorySubmission,
  seedSubmissionVote,
  type StoryDiceState,
} from "../../games/storydice.js";
import {
  SCRAMBLE_KIND,
  SCRAMBLE_DEFAULT_ROUNDS,
  SCRAMBLE_MAX_ROUNDS,
  formatRoundStartLine,
  newScrambleState,
  parseScrambleStartArgs,
  readScrambleConfig,
  recordScrambleGuess,
  scheduleScrambleRoundTimer,
  type ScrambleState,
} from "../../games/scramble.js";
import { getBuiltinCommandConfig } from "../../games/config.js";
import {
  ROOM_RAFFLE_KIND,
  ROOM_RAFFLE_WINDOW_MS,
  SITEWIDE_RAFFLE_KIND,
  SITEWIDE_RAFFLE_WINDOW_MS,
  creditItemToInventory,
  debitItemFromInventory,
  prizeLabel,
  recordClaimant,
  type Prize,
  type RaffleState,
} from "../../games/raffle.js";
import { addMessage, addMessageDirect, addSystemMessage } from "../../realtime/broadcast.js";
import { rooms, users } from "../../db/schema.js";
import { creditPool } from "../../earning/award.js";
import { readPool, resolveRoomServerId } from "../../earning/pool.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";
import { findItem } from "./items.js";

function notice(ctx: CommandContext, code: string, message: string): void {
  ctx.socket.emit("error:notice", { code, message });
}

/** Pull a clean ParticipantRef out of the current ctx. The
 *  display name is whatever the user is currently voicing (character
 *  if active, master username otherwise), same posture every
 *  identity-keyed command uses. */
function participantFor(ctx: CommandContext): ParticipantRef {
  return {
    userId: ctx.user.id,
    characterId: ctx.user.activeCharacterId,
    displayName: ctx.user.displayName,
  };
}

function identityScope(ctx: CommandContext): { scope: "user" | "character"; ownerId: string } {
  return ctx.user.activeCharacterId
    ? { scope: "character", ownerId: ctx.user.activeCharacterId }
    : { scope: "user", ownerId: ctx.user.id };
}

async function readWalletBalance(
  ctx: CommandContext,
  scope: "user" | "character",
  ownerId: string,
): Promise<number> {
  // Read the wallet from the SAME server the raffle debit lands on
  // (the crediting room's server, else DEFAULT_SERVER_ID). Flag-off:
  // the room homes to the default server, so this is today's pool.
  const sid = await resolveRoomServerId(ctx.db, ctx.roomId);
  const row = await readPool(ctx.db, sid, scope, ownerId);
  return row?.currency ?? 0;
}

/* ============================================================ *
 *                            /rps                              *
 * ============================================================ */

export const rpsCommand: CommandHandler = {
  name: "rps",
  usage: "/rps | /rps <rock|paper|scissors>",
  description:
    "Start a rock-paper-scissors round in this room (30s window), or enter your throw when a round is live. With 3+ players the standard rule scales: throws are grouped, and the group whose throw beats the other wins.",
  subcommands: [
    { verb: "(no args)", usage: "/rps", description: "Open a round so others can join. You can /rps <throw> any time before the timer ends." },
    { verb: "rock | paper | scissors", usage: "/rps paper", description: "Enter your throw. If no round is live, starts one with your throw counted." },
  ],
  async run(ctx) {
    const arg = ctx.argsText.trim();

    // Incognito hosts would leak their identity in the start
    // announce ("🎲 Avery opened…"), defeating the whole point of
    // /incognito. Entering a round started by someone ELSE is also
    // blocked because the result line names every entrant by
    // display name. The only sane posture is: leave incognito to
    // host or play.
    if (ctx.user.incognitoMode) {
      return notice(
        ctx,
        "RPS_INCOGNITO",
        tFor(ctx.user.locale, "commands:rps.incognito"),
      );
    }

    const active = findRoomSession(ctx.roomId);

    // No-arg: start a new round (or surface a notice if one's already running).
    if (!arg) {
      if (active) {
        return notice(
          ctx,
          "RPS_ACTIVE",
          tFor(ctx.user.locale, "commands:rps.active", { seconds: secondsLeft(active.expiresAt) }),
        );
      }
      // Resolve admin overrides + snapshot rewards into the session.
      const { windowMs, reward } = await readRpsConfig(ctx.db, (ctx.socket.data as { serverId?: string }).serverId);
      try {
        startSession({
          kind: RPS_KIND,
          host: participantFor(ctx),
          scope: { kind: "room", roomId: ctx.roomId },
          state: newRpsState(null, identityKeyFor(ctx.user.id, ctx.user.activeCharacterId), reward),
          windowMs,
          db: ctx.db,
          io: ctx.io,
        });
      } catch (err) {
        if (err instanceof SessionConflictError) {
          return notice(ctx, "RPS_CONFLICT", err.message);
        }
        throw err;
      }
      await addSystemMessage(
        ctx.io,
        ctx.db,
        ctx.roomId,
        `🎲 ${ctx.user.displayName} opened a rock-paper-scissors round. Run /rps <rock|paper|scissors> in the next ${Math.round(windowMs / 1000)}s to play.`,
      );
      return;
    }

    // Throw argument: parse and record. If no round is live, this
    // also opens one with the host's throw as the seed entry.
    const choice = parseRpsThrow(arg);
    if (!choice) {
      return notice(ctx, "RPS_USAGE", tFor(ctx.user.locale, "commands:rps.usage"));
    }
    const key = identityKeyFor(ctx.user.id, ctx.user.activeCharacterId);
    if (active && active.kind === RPS_KIND) {
      const state = active.state as RpsState;
      const replacing = state.entries.has(key);
      recordRpsEntry(active, key, { participant: participantFor(ctx), throw: choice });
      // Quiet confirmation back to the entrant. Public chat stays
      // clean, the result line at expiry surfaces every throw.
      return notice(
        ctx,
        replacing ? "RPS_UPDATED" : "RPS_ENTERED",
        replacing
          ? tFor(ctx.user.locale, "commands:rps.updated", { choice, seconds: secondsLeft(active.expiresAt) })
          : tFor(ctx.user.locale, "commands:rps.entered", { choice, seconds: secondsLeft(active.expiresAt) }),
      );
    }
    if (active && active.kind !== RPS_KIND) {
      return notice(
        ctx,
        "GAME_CONFLICT",
        tFor(ctx.user.locale, "commands:rps.gameConflict", { kind: active.kind }),
      );
    }
    // No active session: start one and seed the host's throw.
    const { windowMs, reward } = await readRpsConfig(ctx.db, (ctx.socket.data as { serverId?: string }).serverId);
    try {
      startSession({
        kind: RPS_KIND,
        host: participantFor(ctx),
        scope: { kind: "room", roomId: ctx.roomId },
        state: newRpsState({ participant: participantFor(ctx), throw: choice }, key, reward),
        windowMs,
        db: ctx.db,
        io: ctx.io,
      });
    } catch (err) {
      if (err instanceof SessionConflictError) {
        return notice(ctx, "RPS_CONFLICT", err.message);
      }
      throw err;
    }
    await addSystemMessage(
      ctx.io,
      ctx.db,
      ctx.roomId,
      `🎲 ${ctx.user.displayName} opened a rock-paper-scissors round (entered ${choice}). Run /rps <rock|paper|scissors> in the next ${Math.round(windowMs / 1000)}s to play.`,
    );
  },
};

/* ============================================================ *
 *                          /raffle                             *
 * ============================================================ */

export const raffleCommand: CommandHandler = {
  name: "raffle",
  usage: "/raffle item <name> [count] | /raffle currency <amount> | /raffle cancel | /raffle status",
  description:
    "Put an item or Currency up for a 60-second room raffle. People run /claim to enter. At expiry one entrant is drawn at random and wins the prize; with no claimants the prize returns to you. The prize leaves your inventory / wallet immediately.",
  subcommands: [
    { verb: "item", usage: "/raffle item <name> [count]", description: "Raffle one (or N) of an item from your active inventory. Item can be slug, display name, or alias, same parsing as /give." },
    { verb: "currency", usage: "/raffle currency <amount>", description: "Raffle a Currency amount from your active wallet (master or character pool, whichever you're voicing)." },
    { verb: "cancel", usage: "/raffle cancel", description: "End your active raffle early and refund the prize. Host only." },
    { verb: "status", usage: "/raffle status", description: "Show the current room's active raffle (prize, claimants, seconds left)." },
  ],
  async run(ctx) {
    await runRaffleStart(ctx, { kind: ROOM_RAFFLE_KIND, scopeKind: "room", windowMs: ROOM_RAFFLE_WINDOW_MS });
  },
};

/* ============================================================ *
 *                       /announceraffle                        *
 * ============================================================ */

export const announceRaffleCommand: CommandHandler = {
  name: "announceraffle",
  aliases: ["raffleall"],
  usage: "/announceraffle item <name> [count] | /announceraffle currency <amount> | /announceraffle cancel",
  description:
    "Admin-only sitewide raffle. The prize is broadcast as an announce line to every room, and anyone in any room can /claim. Longer window (3 minutes) so people outside the host room have time to see it. The prize is debited from your active inventory / wallet just like /raffle.",
  permission: "announce_sitewide",
  subcommands: [
    { verb: "item", usage: "/announceraffle item <name> [count]", description: "Sitewide item raffle." },
    { verb: "currency", usage: "/announceraffle currency <amount>", description: "Sitewide Currency raffle." },
    { verb: "cancel", usage: "/announceraffle cancel", description: "End the sitewide raffle early and refund the prize. Host only." },
    { verb: "status", usage: "/announceraffle status", description: "Show the active sitewide raffle (prize, claimants, seconds left)." },
  ],
  async run(ctx) {
    await runRaffleStart(ctx, { kind: SITEWIDE_RAFFLE_KIND, scopeKind: "sitewide", windowMs: SITEWIDE_RAFFLE_WINDOW_MS });
  },
};

/**
 * Shared body for /raffle and /announceraffle. Branches on the
 * subcommand verb and stands up the right session shape. The two
 * commands differ only in scope (room vs sitewide), window length,
 * and the kind tag they pass into the registry.
 */
async function runRaffleStart(
  ctx: CommandContext,
  opts: { kind: typeof ROOM_RAFFLE_KIND | typeof SITEWIDE_RAFFLE_KIND; scopeKind: "room" | "sitewide"; windowMs: number },
): Promise<void> {
  // Resolve admin-set window override. Raffles deliberately ignore
  // the reward fields of the config (their prize IS the host's
  // stake), but the duration_ms is honored. Each subcommand variant
  // is registered under its own command name so the Built-ins panel
  // can tune room and sitewide windows independently.
  const cfgName = opts.scopeKind === "room" ? "raffle" : "announceraffle";
  const cfg = await getBuiltinCommandConfig(ctx.db, cfgName, { durationMs: opts.windowMs }, (ctx.socket.data as { serverId?: string }).serverId);
  const windowMs = cfg.durationMs;
  // Incognito hosts would attribute the raffle announce to their
  // display name, same leak as RPS. The cancel and status
  // subcommands are read-mostly and don't leak identity, so we let
  // them through.
  const [sub, ...rest] = ctx.args;
  const subLower = (sub ?? "").toLowerCase();
  if (ctx.user.incognitoMode && (subLower === "item" || subLower === "currency" || subLower === "coin" || subLower === "coins")) {
    return notice(
      ctx,
      "RAFFLE_INCOGNITO",
      tFor(ctx.user.locale, "commands:raffle.incognito"),
    );
  }

  if (subLower === "" || subLower === "help") {
    return notice(
      ctx,
      "RAFFLE_USAGE",
      tFor(ctx.user.locale, "commands:raffle.usage"),
    );
  }

  if (subLower === "status") {
    // /raffle status: look at the room first, then fall through to
    // the sitewide raffle when the room has none, same precedence
    // as /claim, so the user's mental model stays consistent. The
    // sitewide path used /announceraffle status will also land here
    // since the second branch reads sitewideSession directly.
    let active = opts.scopeKind === "room"
      ? findRoomSession(ctx.roomId)
      : findSitewideSession();
    let scopeNoteFor: "room" | "sitewide" | null = active ? opts.scopeKind : null;
    if (!active && opts.scopeKind === "room") {
      const sitewide = findSitewideSession();
      if (sitewide) {
        active = sitewide;
        scopeNoteFor = "sitewide";
      }
    }
    if (!active || (active.kind !== ROOM_RAFFLE_KIND && active.kind !== SITEWIDE_RAFFLE_KIND)) {
      return notice(ctx, "RAFFLE_NONE", tFor(ctx.user.locale, "commands:raffle.noneRunning"));
    }
    const state = active.state as RaffleState;
    const scopeNote = scopeNoteFor === "sitewide" ? tFor(ctx.user.locale, "commands:raffle.sitewideNote") : "";
    return notice(
      ctx,
      "RAFFLE_STATUS",
      tFor(ctx.user.locale, "commands:raffle.status", {
        name: active.host.displayName,
        scopeNote,
        prize: prizeLabel(state.prize),
        claimants: state.claimants.size,
        seconds: secondsLeft(active.expiresAt),
      }),
    );
  }

  if (subLower === "cancel") {
    const active = opts.scopeKind === "room"
      ? findRoomSession(ctx.roomId)
      : findSitewideSession();
    if (!active || (active.kind !== ROOM_RAFFLE_KIND && active.kind !== SITEWIDE_RAFFLE_KIND)) {
      return notice(ctx, "RAFFLE_NONE", tFor(ctx.user.locale, "commands:raffle.noneToCancel"));
    }
    if (active.host.userId !== ctx.user.id) {
      return notice(ctx, "RAFFLE_PERM", tFor(ctx.user.locale, "commands:raffle.cancelPermission"));
    }
    await cancel(active, { db: ctx.db, io: ctx.io });
    return;
  }

  // Start path. Validate the scope precondition before we even
  // look at the prize args, so an invalid `/raffle item` doesn't
  // waste an inventory read when a conflicting session is already
  // running.
  if (opts.scopeKind === "room") {
    const existing = findRoomSession(ctx.roomId);
    if (existing) {
      return notice(
        ctx,
        "RAFFLE_CONFLICT",
        tFor(
          ctx.user.locale,
          existing.kind === RPS_KIND ? "commands:raffle.conflictRps" : "commands:raffle.conflictRaffle",
        ),
      );
    }
  } else {
    const existing = findSitewideSession();
    if (existing) {
      return notice(
        ctx,
        "RAFFLE_CONFLICT",
        tFor(ctx.user.locale, "commands:raffle.conflictSitewide"),
      );
    }
  }

  let prize: Prize | null = null;
  const { scope, ownerId } = identityScope(ctx);
  // The economy the prize is escrowed from — snapshotted so the winner is
  // credited (and refunds returned) on the SAME server (no cross-server leak).
  const hostServerId = await resolveRoomServerId(ctx.db, ctx.roomId);

  if (subLower === "item") {
    const parsed = parseItemPrizeArgs(rest);
    if (!parsed) {
      return notice(ctx, "RAFFLE_USAGE", tFor(ctx.user.locale, "commands:raffle.itemUsage"));
    }
    const item = await findItem(ctx.db, parsed.itemQuery, hostServerId);
    if (!item) {
      return notice(ctx, "RAFFLE_ITEM_NOT_FOUND", tFor(ctx.user.locale, "commands:shared.itemNotFound", { name: parsed.itemQuery }));
    }
    if (!item.enabled) {
      return notice(ctx, "RAFFLE_ITEM_DISABLED", tFor(ctx.user.locale, "commands:shared.itemNotUsable", { name: item.name }));
    }
    const debit = debitItemFromInventory(ctx.db, scope, ownerId, item.key, parsed.count, hostServerId);
    if (!debit.ok) {
      return notice(
        ctx,
        "RAFFLE_NOT_ENOUGH",
        tFor(ctx.user.locale, "commands:raffle.notEnoughItems", { have: debit.have, item: item.name, tried: parsed.count }),
      );
    }
    prize = { kind: "item", itemKey: item.key, itemName: item.name, count: parsed.count };
  } else if (subLower === "currency" || subLower === "coin" || subLower === "coins") {
    const amt = parseInt(rest.join(" ").trim(), 10);
    if (!Number.isFinite(amt) || amt <= 0) {
      return notice(ctx, "RAFFLE_USAGE", tFor(ctx.user.locale, "commands:raffle.currencyUsage"));
    }
    const balance = await readWalletBalance(ctx, scope, ownerId);
    if (balance < amt) {
      return notice(
        ctx,
        "RAFFLE_NOT_ENOUGH",
        tFor(ctx.user.locale, "commands:raffle.notEnoughCurrency", { balance, amount: amt }),
      );
    }
    // Debit. creditPool clips at zero so a concurrent spend can't
    // drag the balance negative; the balance check above keeps the
    // common-case error message friendly.
    await creditPool(ctx.db, ctx.io as never, {
      serverId: hostServerId,
      scope,
      ownerId,
      xpDelta: 0,
      currencyDelta: -amt,
      reason: "raffle_escrow",
      notifyUserId: ctx.user.id,
    });
    prize = { kind: "currency", amount: amt };
  } else {
    return notice(ctx, "RAFFLE_USAGE", tFor(ctx.user.locale, "commands:raffle.firstArg"));
  }

  const state: RaffleState = {
    prize: prize!,
    hostScope: scope,
    hostOwnerId: ownerId,
    hostUserId: ctx.user.id,
    hostServerId,
    claimants: new Map(),
  };

  try {
    startSession({
      kind: opts.kind,
      host: participantFor(ctx),
      scope: opts.scopeKind === "room" ? { kind: "room", roomId: ctx.roomId } : { kind: "sitewide" },
      state,
      windowMs,
      db: ctx.db,
      io: ctx.io,
    });
  } catch (err) {
    // Refund on conflict, the debit went through but the session
    // couldn't start. Without the refund here the host would lose
    // the prize and the registry would also have nothing to
    // resolve.
    await refundOnStartFailure(ctx, state);
    if (err instanceof SessionConflictError) {
      return notice(ctx, "RAFFLE_CONFLICT", err.message);
    }
    throw err;
  }

  const announce = `🎟 ${ctx.user.displayName} is raffling ${prizeLabel(prize!)}, type /claim in the next ${Math.round(windowMs / 1000)}s to enter.`;
  if (opts.scopeKind === "room") {
    await addSystemMessage(ctx.io, ctx.db, ctx.roomId, announce);
    return;
  }
  // Sitewide, broadcast to every room.
  const sysUser = (await ctx.db.select().from(users).where(eq(users.username, "system")).limit(1))[0];
  if (!sysUser) return;
  const allRooms = await ctx.db.select({ id: rooms.id }).from(rooms);
  for (const r of allRooms) {
    await addMessageDirect({
      db: ctx.db,
      io: ctx.io,
      roomId: r.id,
      userId: sysUser.id,
      displayName: "system",
      kind: "announce",
      body: announce,
    });
  }
}

/* ============================================================ *
 *                            /claim                            *
 * ============================================================ */

export const claimCommand: CommandHandler = {
  name: "claim",
  aliases: ["enter"],
  usage: "/claim",
  description:
    "Enter the active raffle. The room's own raffle wins precedence when both a room raffle and a sitewide raffle are running here; in that case, head to a room with no local raffle to /claim the sitewide one. One entry per identity per raffle, running it twice is a no-op.",
  async run(ctx) {
    // Incognito claimants would land on the result line by display
    // name (and as the winner, would expose their identity to every
    // viewer of the result). Block.
    if (ctx.user.incognitoMode) {
      return notice(
        ctx,
        "CLAIM_INCOGNITO",
        tFor(ctx.user.locale, "commands:claim.incognito"),
      );
    }
    // Room first; fall back to sitewide.
    const active = findActiveForRoom(ctx.roomId);
    if (!active) {
      return notice(ctx, "CLAIM_NONE", tFor(ctx.user.locale, "commands:raffle.noneRunning"));
    }
    if (active.kind !== ROOM_RAFFLE_KIND && active.kind !== SITEWIDE_RAFFLE_KIND) {
      return notice(
        ctx,
        "CLAIM_NONE",
        tFor(ctx.user.locale, "commands:claim.notRaffle", { kind: active.kind }),
      );
    }
    const key = identityKeyFor(ctx.user.id, ctx.user.activeCharacterId);
    const { firstTime } = recordClaimant(active, key, participantFor(ctx));
    const left = secondsLeft(active.expiresAt);
    if (firstTime) {
      return notice(
        ctx,
        "CLAIM_OK",
        tFor(ctx.user.locale, "commands:claim.entered", { seconds: left }),
      );
    }
    return notice(
      ctx,
      "CLAIM_ALREADY",
      tFor(ctx.user.locale, "commands:claim.already", { seconds: left }),
    );
  },
};

/* ============================================================ *
 *                            Helpers                           *
 * ============================================================ */

function secondsLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

/** Parse "<name>" or "<name> <count>" or "<count> <name>" from a
 *  raffle item arg list. Mirrors the loose parsing /give uses so
 *  users don't have to remember a strict order. Returns null when
 *  the args don't yield a non-empty name. */
function parseItemPrizeArgs(args: readonly string[]): { itemQuery: string; count: number } | null {
  if (args.length === 0) return null;
  // Try "<name> <count>", last token is a positive integer.
  if (args.length >= 2) {
    const tail = args[args.length - 1]!;
    const n = parseInt(tail, 10);
    if (Number.isFinite(n) && String(n) === tail && n > 0) {
      const name = args.slice(0, -1).join(" ").trim();
      if (name) return { itemQuery: name, count: n };
    }
    // Try "<count> <name>", first token is a positive integer.
    const head = args[0]!;
    const n2 = parseInt(head, 10);
    if (Number.isFinite(n2) && String(n2) === head && n2 > 0) {
      const name = args.slice(1).join(" ").trim();
      if (name) return { itemQuery: name, count: n2 };
    }
  }
  // Bare "<name>", count defaults to 1.
  const name = args.join(" ").trim();
  if (!name) return null;
  return { itemQuery: name, count: 1 };
}

/** Refund the host on a start-time failure (conflict raised AFTER
 *  the debit went through). Mirrors the refund path in `cancelRaffle`
 *  but synchronous + inline so the command handler can recover the
 *  caller's prize before bouncing the notice back. Uses the same
 *  primitives the resolution hook uses so behavior matches. */
async function refundOnStartFailure(ctx: CommandContext, state: RaffleState): Promise<void> {
  if (state.prize.kind === "currency") {
    await creditPool(ctx.db, ctx.io as never, {
      serverId: state.hostServerId,
      scope: state.hostScope,
      ownerId: state.hostOwnerId,
      xpDelta: 0,
      currencyDelta: state.prize.amount,
      reason: "raffle_refund",
      notifyUserId: state.hostUserId,
    });
    return;
  }
  // Item refund, use the same helper the resolution path uses so
  // we don't drift behavior between the two refund sites. Returns to the
  // SAME server the escrow debited (hostServerId), matching the debit above.
  creditItemToInventory(ctx.db, state.hostScope, state.hostOwnerId, state.prize.itemKey, state.prize.count, state.hostServerId);
}

/* ============================================================ *
 *                          /trivia                             *
 * ============================================================ */

export const triviaCommand: CommandHandler = {
  name: "trivia",
  usage: "/trivia <question> | <answer>",
  description:
    "Open a 60-second trivia round in this room. The question is broadcast; the answer is hidden until someone guesses it (or the timer runs out). Players race to /answer <text>; first correct match wins. The answer match is forgiving, case-insensitive with leading articles stripped, so 'the eiffel tower' and 'Eiffel Tower' both count.",
  subcommands: [
    { verb: "<q> | <a>", usage: "/trivia What's the capital of Rohan? | Edoras", description: "Open a round. The pipe (|) separates question from answer." },
  ],
  async run(ctx) {
    if (ctx.user.incognitoMode) {
      return notice(ctx, "TRIVIA_INCOGNITO", tFor(ctx.user.locale, "commands:trivia.incognito"));
    }
    const argsText = ctx.argsText.trim();
    if (!argsText) {
      return notice(ctx, "TRIVIA_USAGE", tFor(ctx.user.locale, "commands:trivia.usage"));
    }
    const parsed = parseTriviaArgs(argsText);
    if (!parsed) {
      return notice(ctx, "TRIVIA_USAGE", tFor(ctx.user.locale, "commands:trivia.usagePipe"));
    }
    const existing = findRoomSession(ctx.roomId);
    if (existing) {
      return notice(
        ctx,
        "TRIVIA_CONFLICT",
        tFor(ctx.user.locale, "commands:shared.sessionConflict", { kind: existing.kind }),
      );
    }
    const { windowMs, reward } = await readTriviaConfig(ctx.db, (ctx.socket.data as { serverId?: string }).serverId);
    try {
      startSession({
        kind: TRIVIA_KIND,
        host: participantFor(ctx),
        scope: { kind: "room", roomId: ctx.roomId },
        state: newTriviaState(parsed.question, parsed.answer, reward),
        windowMs,
        db: ctx.db,
        io: ctx.io,
      });
    } catch (err) {
      if (err instanceof SessionConflictError) {
        return notice(ctx, "TRIVIA_CONFLICT", err.message);
      }
      throw err;
    }
    await addSystemMessage(
      ctx.io,
      ctx.db,
      ctx.roomId,
      `🧠 Trivia from ${ctx.user.displayName}: ${parsed.question}\nRun /answer <your guess> in the next ${Math.round(windowMs / 1000)}s.`,
    );
  },
};

export const answerCommand: CommandHandler = {
  name: "answer",
  usage: "/answer <text>",
  description:
    "Submit a guess for the active trivia round. The first correct match wins the round, the answer is revealed, and the timer ends early. Wrong guesses are kept private (only you see the 'miss' notice); the result line at round-end lists every guess so spectators see who tried what.",
  async run(ctx) {
    if (ctx.user.incognitoMode) {
      return notice(ctx, "ANSWER_INCOGNITO", tFor(ctx.user.locale, "commands:answer.incognito"));
    }
    const text = ctx.argsText.trim();
    if (!text) return notice(ctx, "ANSWER_USAGE", tFor(ctx.user.locale, "commands:answer.usage"));
    const active = findRoomSession(ctx.roomId);
    if (!active || active.kind !== TRIVIA_KIND) {
      return notice(ctx, "ANSWER_NONE", tFor(ctx.user.locale, "commands:answer.none"));
    }
    // The host knows the hidden answer, letting them /answer their
    // own trivia and pocket the configured reward is a clean self-
    // deal. Block on master-userId match (not per-identity) so a
    // character the host owns can't sneak the answer in either.
    if (active.host.userId === ctx.user.id) {
      return notice(ctx, "ANSWER_HOST", tFor(ctx.user.locale, "commands:answer.host"));
    }
    const result = recordTriviaGuess(active, {
      participant: participantFor(ctx),
      text,
      at: Date.now(),
    });
    if (result.kind === "win") {
      // Resolve the round immediately via the cancel path, this
      // runs the onCancel hook (same function as onResolve for
      // trivia), clears the timer, and posts the result line.
      await cancel(active, { db: ctx.db, io: ctx.io });
      return;
    }
    if (result.kind === "miss") {
      return notice(ctx, "ANSWER_MISS", tFor(ctx.user.locale, "commands:answer.miss"));
    }
    return notice(ctx, "ANSWER_OVER", tFor(ctx.user.locale, "commands:answer.over"));
  },
};

/* ============================================================ *
 *                         /storydice                           *
 * ============================================================ */

export const storyDiceCommand: CommandHandler = {
  name: "storydice",
  aliases: ["story-dice"],
  usage: "/storydice | /storydice <your post>",
  description:
    "Open or play a Story Dice round. With no args, opens a 3-minute round; the server picks four random prompt words. Any free-form text becomes your submission for the round, a short IC paragraph weaving all four prompts in. Your submission posts to chat as a stylized entry (bolded header + indented body) so it stands apart from chatter, and the system seeds a 📖 reaction so the voting chip is right there. The room votes by adding their own 📖 reactions; whichever submission collects the most wins. One submission per identity (no resubmits).",
  subcommands: [
    { verb: "(no args)", usage: "/storydice", description: "Open a round. The four prompts are revealed in the start line." },
    { verb: "<your post>", usage: "/storydice The lantern swung once over the bridge...", description: "Submit a Story Dice post. Lands as a stylized chat entry with a seeded 📖 reaction so the room can vote." },
  ],
  async run(ctx) {
    if (ctx.user.incognitoMode) {
      return notice(ctx, "STORYDICE_INCOGNITO", tFor(ctx.user.locale, "commands:storydice.incognito"));
    }
    const argsText = ctx.argsText.trim();

    // No args → open a new round (or surface a conflict notice).
    if (!argsText) {
      const existing = findRoomSession(ctx.roomId);
      if (existing) {
        return notice(
          ctx,
          "STORYDICE_CONFLICT",
          tFor(ctx.user.locale, "commands:shared.sessionConflict", { kind: existing.kind }),
        );
      }
      const { windowMs, reward } = await readStoryDiceConfig(ctx.db, (ctx.socket.data as { serverId?: string }).serverId);
      const state = newStoryDiceState(reward);
      try {
        startSession({
          kind: STORYDICE_KIND,
          host: participantFor(ctx),
          scope: { kind: "room", roomId: ctx.roomId },
          state,
          windowMs,
          db: ctx.db,
          io: ctx.io,
        });
      } catch (err) {
        if (err instanceof SessionConflictError) {
          return notice(ctx, "STORYDICE_CONFLICT", err.message);
        }
        throw err;
      }
      await addSystemMessage(
        ctx.io,
        ctx.db,
        ctx.roomId,
        `📜 Story Dice from ${ctx.user.displayName}! Prompts: ${state.prompts.join(", ")}. Run /storydice <your post> in the next ${Math.round(windowMs / 1000)}s. Weave all four in, the room votes the winner with 📖 reactions.`,
      );
      return;
    }

    // Submission path, must have an active round.
    const active = findRoomSession(ctx.roomId);
    if (!active || active.kind !== STORYDICE_KIND) {
      return notice(ctx, "STORYDICE_NONE", tFor(ctx.user.locale, "commands:storydice.none"));
    }
    const key = identityKeyFor(ctx.user.id, ctx.user.activeCharacterId);
    if ((active.state as StoryDiceState).submissions.has(key)) {
      return notice(ctx, "STORYDICE_ONCE", tFor(ctx.user.locale, "commands:storydice.once"));
    }
    // Post the submission as a stylized chat line attributed to the
    // player. We still use `addMessage` so the line flows through
    // the same pipeline as a normal /say (avatar snapshot, inline-
    // cmd expansion, push triggers, etc.), but the body itself
    // wraps the player's text in a bolded "Storydice entry by …"
    // header + a blockquoted body so the post reads as a stylized
    // submission rather than blending into chatter. The blockquote
    // covers multi-paragraph bodies by re-prefixing each newline.
    const formattedBody = `📜 **Storydice entry by ${ctx.user.displayName}:**\n\n> ${argsText.replace(/\n/g, "\n> ")}`;
    const messageId = await addMessage(ctx, { kind: "say", body: formattedBody });
    if (!messageId) {
      // addMessage already emitted the rejection notice (size cap,
      // UI-route token guard, etc.). Bail without recording state.
      return;
    }
    // Seed the vote reaction on the freshly-posted message so the
    // voting chip renders immediately for everyone in the room.
    // Failure is silently tolerated, the round still runs, just
    // without the seed. (The resolver clamps `votes` at 0 so a
    // missing seed reads as "0 votes" rather than "-1".)
    await seedSubmissionVote(ctx.db, ctx.io, ctx.roomId, messageId);
    recordStorySubmission(active, key, {
      participant: participantFor(ctx),
      messageId,
      // Keep the raw text in state so the resolver's transcript
      // line ("— Alice (3 votes): …") shows the entry as written,
      // not the markdown-wrapped chat-body form. Only the chat
      // line gets the stylized wrapper.
      text: argsText,
    });
  },
};

/* ============================================================ *
 *                         /scramble                            *
 * ============================================================ */

export const scrambleCommand: CommandHandler = {
  name: "scramble",
  usage: "/scramble | /scramble <rounds> | /scramble <rounds> <word1> <word2> ... | /scramble <word> | /scramble status | /scramble cancel",
  description:
    "Open a Word Scramble round in this room. The game picks a word, scrambles its letters, and the room races to find as many dictionary words as they can from the letters. Points scale with word length; an exact match on the source word doubles the score. Multi-round games chain automatically. The host can also supply their own source words to control the puzzle, otherwise the game picks for them.",
  subcommands: [
    { verb: "(no args)", usage: "/scramble", description: `Start a ${SCRAMBLE_DEFAULT_ROUNDS}-round game in this room. Words are picked for you.` },
    { verb: "<rounds>", usage: "/scramble 3", description: `Start a game with the given number of rounds (1 to ${SCRAMBLE_MAX_ROUNDS}).` },
    { verb: "<rounds> <words...>", usage: "/scramble 3 forward accelerate hyperspace", description: "Start a multi-round game using your own source words for each round. Provide one word per round (or fewer, and the rest are picked for you)." },
    { verb: "<words...>", usage: "/scramble forward accelerate hyperspace", description: "Start a game where the round count matches the number of words you provided." },
    { verb: "<word>", usage: "/scramble crane", description: "During a live round, claim points for a word you spotted. Must be at least 3 letters, in the dictionary, and made from the scramble's letters." },
    { verb: "status", usage: "/scramble status", description: "Private reminder of the current letters and how much time is left." },
    { verb: "cancel", usage: "/scramble cancel", description: "Host-only. End the game early; current standings still post." },
  ],
  async run(ctx) {
    if (ctx.user.incognitoMode) {
      return notice(
        ctx,
        "SCRAMBLE_INCOGNITO",
        tFor(ctx.user.locale, "commands:scramble.incognito"),
      );
    }
    const argsText = ctx.argsText.trim();
    const lowered = argsText.toLowerCase();
    const active = findRoomSession(ctx.roomId);
    const isScrambleActive = active?.kind === SCRAMBLE_KIND;
    const hostingThis = isScrambleActive
      && active.host.userId === ctx.user.id
      && active.host.characterId === ctx.user.activeCharacterId;

    // `/scramble status`, private peek at the current letters.
    // Exact match only; "status now" or similar falls through.
    if (lowered === "status") {
      if (!isScrambleActive) {
        return notice(ctx, "SCRAMBLE_NONE", tFor(ctx.user.locale, "commands:scramble.none"));
      }
      const state = active.state as ScrambleState;
      const secs = Math.max(0, Math.ceil((state.currentRoundEndsAt - Date.now()) / 1000));
      return notice(
        ctx,
        "SCRAMBLE_STATUS",
        tFor(ctx.user.locale, "commands:scramble.status", {
          round: state.currentRound,
          total: state.totalRounds,
          letters: state.currentLetters,
          length: state.currentSourceWord.length,
          seconds: secs,
        }),
      );
    }

    // `/scramble cancel`, host-only early termination.
    if (lowered === "cancel") {
      if (!isScrambleActive) {
        return notice(ctx, "SCRAMBLE_NONE", tFor(ctx.user.locale, "commands:scramble.none"));
      }
      if (!hostingThis) {
        return notice(ctx, "SCRAMBLE_NOT_HOST", tFor(ctx.user.locale, "commands:scramble.notHost"));
      }
      await cancel(active, { db: ctx.db, io: ctx.io });
      return;
    }

    // An active scramble session, anything else is a guess attempt.
    if (isScrambleActive) {
      if (!argsText) {
        const state = active.state as ScrambleState;
        return notice(
          ctx,
          "SCRAMBLE_ACTIVE",
          tFor(ctx.user.locale, "commands:scramble.active", {
            round: state.currentRound,
            total: state.totalRounds,
            letters: state.currentLetters,
          }),
        );
      }
      if (ctx.args.length > 1) {
        return notice(
          ctx,
          "SCRAMBLE_ONE_WORD",
          tFor(ctx.user.locale, "commands:scramble.oneWord"),
        );
      }
      const outcome = recordScrambleGuess(active, participantFor(ctx), argsText);
      switch (outcome.kind) {
        case "tooshort":
          return notice(ctx, "SCRAMBLE_SHORT", tFor(ctx.user.locale, "commands:scramble.tooShort"));
        case "letters":
          return notice(ctx, "SCRAMBLE_LETTERS", tFor(ctx.user.locale, "commands:scramble.letters"));
        case "notword":
          return notice(ctx, "SCRAMBLE_NOTWORD", tFor(ctx.user.locale, "commands:scramble.notWord"));
        case "duplicate":
          return notice(ctx, "SCRAMBLE_DUPLICATE", tFor(ctx.user.locale, "commands:scramble.duplicate", { word: outcome.word }));
        case "ok": {
          return notice(
            ctx,
            "SCRAMBLE_SCORE",
            tFor(
              ctx.user.locale,
              outcome.exactMatch ? "commands:scramble.scoreExact" : "commands:scramble.score",
              { points: outcome.points, word: outcome.word, total: outcome.total },
            ),
          );
        }
      }
      return;
    }

    // A non-scramble session is running here, say so.
    if (active && !isScrambleActive) {
      return notice(
        ctx,
        "GAME_CONFLICT",
        tFor(ctx.user.locale, "commands:scramble.gameConflict", { kind: active.kind }),
      );
    }

    // No active session. Parse the start args (rounds + optional
    // host-picked source words). A malformed call surfaces a
    // specific notice; on success we start a game.
    const parsed = parseScrambleStartArgs(ctx.args, ctx.user.locale);
    if ("error" in parsed) {
      return notice(ctx, "SCRAMBLE_USAGE", parsed.error);
    }
    await startScramble(ctx, parsed.rounds, parsed.hostWords);
    return;
  },
};

async function startScramble(
  ctx: CommandContext,
  rounds: number,
  hostWords: ReadonlyArray<string> = [],
): Promise<void> {
  const clamped = Math.min(SCRAMBLE_MAX_ROUNDS, Math.max(1, rounds));
  // Defensive: never let the host word count exceed the rounds,
  // parseScrambleStartArgs already enforces this, but pin it here
  // so direct callers can't trip the invariant either.
  const clampedHostWords = hostWords.slice(0, clamped);
  const { perRoundMs, reward } = await readScrambleConfig(ctx.db, (ctx.socket.data as { serverId?: string }).serverId);
  const state = newScrambleState(clamped, perRoundMs, reward, clampedHostWords);
  let session;
  try {
    session = startSession({
      kind: SCRAMBLE_KIND,
      host: participantFor(ctx),
      scope: { kind: "room", roomId: ctx.roomId },
      state,
      // Window covers all rounds; the inner round-timer chain
      // handles inter-round transitions, the registry's session
      // timer fires the end-of-game resolver after the last round
      // expires.
      windowMs: perRoundMs * clamped,
      db: ctx.db,
      io: ctx.io,
    });
  } catch (err) {
    if (err instanceof SessionConflictError) {
      return notice(ctx, "SCRAMBLE_CONFLICT", err.message);
    }
    throw err;
  }
  // Schedule the round-2 transition (and beyond) before the
  // round-1 announce, so the timer chain is live the moment players
  // see the first letters. (serverId is carried for the ResolveContext
  // shape; the actual reward resolve recomputes it via the registry timer.)
  scheduleScrambleRoundTimer(session, { db: ctx.db, io: ctx.io, serverId: await resolveRoomServerId(ctx.db, ctx.roomId) });
  // Mention host-pick only when the host actually supplied words;
  // games with no host words get the simpler "game picks" phrasing
  // (and the per-round letters reveal naturally as rounds advance).
  const opener = clampedHostWords.length > 0
    ? `🔡 ${ctx.user.displayName} opened a ${clamped}-round Word Scramble using their own words! Type \`/scramble <word>\` to find dictionary words in the letters.`
    : `🔡 ${ctx.user.displayName} opened a ${clamped}-round Word Scramble! Type \`/scramble <word>\` to find dictionary words in the letters.`;
  await addSystemMessage(
    ctx.io,
    ctx.db,
    ctx.roomId,
    `${opener}\n${formatRoundStartLine(state)}`,
  );
}

/* ============================================================ *
 *                          /games                              *
 * ============================================================ */

/** Private system message visible only to the caller. Mirrors
 *  `whisperToSelf` from the friends command, uses message:new but
 *  emits to one socket and skips DB persistence. The catalog text
 *  is small enough that re-rendering on every call beats keeping a
 *  cached blob in sync with the registered commands. */
function whisperGamesList(ctx: CommandContext, body: string): void {
  ctx.socket.emit("message:new", {
    id: `games-${Date.now()}`,
    roomId: ctx.roomId,
    userId: "system",
    characterId: null,
    displayName: "system",
    kind: "system",
    body,
    color: null,
    createdAt: Date.now(),
  });
}

export const gamesCommand: CommandHandler = {
  name: "games",
  usage: "/games",
  description:
    "Private quick reference of every social game and how to start one. Handy when you can't remember the cue word.",
  async run(ctx) {
    const lines: string[] = [];
    lines.push(tFor(ctx.user.locale, "commands:games.header"));
    lines.push(tFor(ctx.user.locale, "commands:games.rps"));
    lines.push(tFor(ctx.user.locale, "commands:games.trivia"));
    lines.push(tFor(ctx.user.locale, "commands:games.storydice"));
    lines.push(tFor(ctx.user.locale, "commands:games.scramble"));
    lines.push(tFor(ctx.user.locale, "commands:games.duel"));
    lines.push(tFor(ctx.user.locale, "commands:games.raffle"));
    lines.push(tFor(ctx.user.locale, "commands:games.footer"));
    whisperGamesList(ctx, lines.join("\n"));
  },
};
