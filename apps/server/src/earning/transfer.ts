/**
 * Currency transfers (`/currency send`).
 *
 * Enforces the anti-abuse gates from `site_settings.earning_config_json
 * .currencyTransfer`:
 *   - master enabled flag
 *   - sender + recipient account age minimums
 *   - per-day send + receive caps
 *   - min / max single-transfer amounts
 *   - no same-pool sends. Transfers BETWEEN a user's own identities
 *     (master ↔ own character, character ↔ sibling character) are
 *     allowed — each identity keeps its own pool — only sending a
 *     pool to itself is refused. (Owner decision 2026-07-09,
 *     reversing the original account-wide block.)
 *   - source pool has the funds
 *
 * Source pool follows the sender's currently-active identity (master
 * if posting as OOC, the active character otherwise). Target is
 * resolved by explicit name lookup, character first (RP framing),
 * user second; a collision (same name as a user) surfaces as a
 * `did_you_mean` error code the command handler renders as a
 * disambiguator prompt.
 *
 * Paired ledger rows go down via `creditPool` so the rank-recompute +
 * socket-emit path runs for both sides automatically.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import {
  characterEarning,
  characters,
  earningLedger,
  userEarning,
  users,
} from "../db/schema.js";
import { getSettings } from "../settings.js";
import { tFor } from "../i18n.js";
import { creditPool } from "./award.js";
import { DEFAULT_SERVER_ID } from "./pool.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

export type TransferTargetKind = "user" | "character";

export interface TransferTarget {
  kind: TransferTargetKind;
  /** The pool's owner id (userId for kind='user', characterId for kind='character'). */
  ownerId: string;
  /** Master user that owns the pool, used for self-send checks and event emission. */
  userId: string;
  displayName: string;
  /**
   * Per-server economy partition the pool lives on. Currency cannot move
   * between servers, so source.serverId must equal target.serverId. Both
   * default to the default server until the servers flag is on (so transfers
   * behave exactly as today).
   */
  serverId: string;
}

export type TransferError =
  | { code: "transfers_disabled"; message: string }
  | { code: "target_not_found"; message: string }
  | { code: "did_you_mean"; message: string; suggestions: TransferTarget[] }
  | { code: "self_send"; message: string }
  | { code: "amount_out_of_range"; message: string }
  | { code: "sender_too_new"; message: string }
  | { code: "recipient_too_new"; message: string }
  | { code: "daily_send_cap"; message: string }
  | { code: "daily_receive_cap"; message: string }
  | { code: "insufficient_funds"; message: string }
  | { code: "cross_server"; message: string }
  | { code: "internal"; message: string };

export interface TransferResult {
  amount: number;
  source: TransferTarget;
  target: TransferTarget;
}

/**
 * Resolve a `[target]` argument to a transfer target. Tries character
 * names first (lexicographic case-insensitive match on a non-deleted
 * character), then master usernames. When the same name matches both
 * a character and a separate user, returns a `did_you_mean` payload
 * with both candidates so the caller can prompt for disambiguation.
 *
 * Returns null when nothing matches.
 */
export async function resolveTransferTarget(
  db: Db,
  name: string,
  locale: string | null = null,
): Promise<{ ok: true; target: TransferTarget } | { ok: false; error: TransferError } | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  // Explicit identity tokens win, paste-friendly from a profile: `@cid:<id>`
  // targets a character, `@id:<id>` a master/OOC account. These bypass the
  // name lookup entirely, so a character whose name has spaces (or collides
  // with another name) can still be targeted unambiguously.
  if (trimmed.startsWith("@cid:")) {
    const charId = trimmed.slice(5).trim();
    if (!charId || /\s/.test(charId)) return null;
    const c = (await db.select().from(characters).where(eq(characters.id, charId)).limit(1))[0];
    if (!c || c.deletedAt) return null;
    return { ok: true, target: { kind: "character", ownerId: c.id, userId: c.userId, displayName: c.name, serverId: DEFAULT_SERVER_ID } };
  }
  if (trimmed.startsWith("@id:")) {
    const userId = trimmed.slice(4).trim();
    if (!userId || /\s/.test(userId)) return null;
    const u = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!u || u.disabledAt) return null;
    return { ok: true, target: { kind: "user", ownerId: u.id, userId: u.id, displayName: u.username, serverId: DEFAULT_SERVER_ID } };
  }

  const lower = trimmed.toLowerCase();

  const charRows = await db
    .select()
    .from(characters)
    .where(sql`lower(${characters.name}) = ${lower}`)
    .all();
  const liveChars = charRows.filter((c) => !c.deletedAt);
  const userRow = (await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${lower}`)
    .limit(1))[0];

  if (liveChars.length === 0 && !userRow) return null;

  // Build candidate list. If we have BOTH a character and a user with
  // the same name (and the user doesn't own the character), surface
  // the collision so the caller can prompt.
  const characterCandidates: TransferTarget[] = liveChars.map((c) => ({
    kind: "character",
    ownerId: c.id,
    userId: c.userId,
    displayName: c.name,
    serverId: DEFAULT_SERVER_ID,
  }));
  const userCandidate: TransferTarget | null = userRow
    ? {
        kind: "user",
        ownerId: userRow.id,
        userId: userRow.id,
        displayName: userRow.username,
        serverId: DEFAULT_SERVER_ID,
      }
    : null;

  // Collision detection: a user with the same name as a character
  // they don't own.
  if (userCandidate && characterCandidates.some((c) => c.userId !== userCandidate.userId)) {
    return {
      ok: false,
      error: {
        code: "did_you_mean",
        message: tFor(locale, "commands:earning.transfer.matchesCharAndUser", { name: trimmed }),
        suggestions: [...characterCandidates, userCandidate],
      },
    };
  }

  // Multiple characters with the same name (different owners) is itself
  // a collision worth flagging.
  if (characterCandidates.length > 1) {
    return {
      ok: false,
      error: {
        code: "did_you_mean",
        message: tFor(locale, "commands:earning.transfer.matchesMultipleCharacters", { name: trimmed }),
        suggestions: characterCandidates,
      },
    };
  }

  if (characterCandidates.length === 1) {
    return { ok: true, target: characterCandidates[0]! };
  }
  if (userCandidate) return { ok: true, target: userCandidate };
  return null;
}

/**
 * Sum of all `currency_send_out` deltas for this sender over the
 * past 24 hours. Used by the daily-send-cap check. Returns the
 * absolute value (deltas are negative for sends).
 */
async function sumDailySent(db: Db, serverId: string, scope: "user" | "character", ownerId: string): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ delta: earningLedger.currencyDelta })
    .from(earningLedger)
    .where(and(
      eq(earningLedger.serverId, serverId),
      eq(earningLedger.scope, scope),
      eq(earningLedger.ownerId, ownerId),
      eq(earningLedger.reason, "currency_send_out"),
      gte(earningLedger.createdAt, cutoff),
    ))
    .all();
  return rows.reduce((acc, r) => acc + Math.abs(r.delta), 0);
}

async function sumDailyReceived(db: Db, serverId: string, scope: "user" | "character", ownerId: string): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ delta: earningLedger.currencyDelta })
    .from(earningLedger)
    .where(and(
      eq(earningLedger.serverId, serverId),
      eq(earningLedger.scope, scope),
      eq(earningLedger.ownerId, ownerId),
      eq(earningLedger.reason, "currency_send_in"),
      gte(earningLedger.createdAt, cutoff),
    ))
    .all();
  return rows.reduce((acc, r) => acc + r.delta, 0);
}

async function readPoolCurrency(db: Db, serverId: string, scope: "user" | "character", ownerId: string): Promise<number> {
  if (scope === "user") {
    const row = (await db
      .select({ c: userEarning.currency })
      .from(userEarning)
      .where(and(eq(userEarning.serverId, serverId), eq(userEarning.userId, ownerId)))
      .limit(1))[0];
    return row?.c ?? 0;
  }
  const row = (await db
    .select({ c: characterEarning.currency })
    .from(characterEarning)
    .where(and(eq(characterEarning.serverId, serverId), eq(characterEarning.characterId, ownerId)))
    .limit(1))[0];
  return row?.c ?? 0;
}

export interface TransferInput {
  db: Db;
  io: Io;
  senderUserId: string;
  /** null = sender is acting as their master OOC; non-null = acting as this character. */
  senderCharacterId: string | null;
  rawTarget: string;
  amount: number;
  /** Sender's locale — every error here is ephemeral and sender-facing,
   *  so messages render in the sender's language (null → en). */
  locale: string | null;
}

/**
 * Perform the transfer. Either returns the structured result on success
 * or a structured error code the command handler renders to the user.
 * Always ephemeral on the wire, caller is responsible for not leaking
 * the result to the room.
 */
export async function transferCurrency(input: TransferInput): Promise<{ ok: true; result: TransferResult } | { ok: false; error: TransferError }> {
  try {
    const settings = await getSettings(input.db);
    const cfg = settings.earningConfig.currencyTransfer;
    if (!cfg.enabled) {
      return {
        ok: false,
        error: { code: "transfers_disabled", message: tFor(input.locale, "commands:earning.transfer.transfersDisabled") },
      };
    }
    if (!Number.isFinite(input.amount) || !Number.isInteger(input.amount)) {
      return {
        ok: false,
        error: { code: "amount_out_of_range", message: tFor(input.locale, "commands:earning.transfer.amountWhole") },
      };
    }
    if (input.amount < cfg.minTransferAmount || input.amount > cfg.maxTransferAmount) {
      return {
        ok: false,
        error: {
          code: "amount_out_of_range",
          message: tFor(input.locale, "commands:earning.transfer.amountRange", {
            min: cfg.minTransferAmount,
            max: cfg.maxTransferAmount,
          }),
        },
      };
    }

    // Resolve target.
    const resolved = await resolveTransferTarget(input.db, input.rawTarget, input.locale);
    if (!resolved) {
      return {
        ok: false,
        error: { code: "target_not_found", message: tFor(input.locale, "commands:earning.transfer.targetNotFound", { name: input.rawTarget }) },
      };
    }
    if (!resolved.ok) return resolved;
    const target = resolved.target;

    // Resolve source: the sender's currently-active identity.
    let source: TransferTarget;
    if (input.senderCharacterId) {
      const c = (await input.db
        .select()
        .from(characters)
        .where(eq(characters.id, input.senderCharacterId))
        .limit(1))[0];
      if (!c) {
        return { ok: false, error: { code: "internal", message: tFor(input.locale, "commands:earning.transfer.senderCharacterMissing") } };
      }
      source = {
        kind: "character",
        ownerId: c.id,
        userId: input.senderUserId,
        displayName: c.name,
        serverId: DEFAULT_SERVER_ID,
      };
    } else {
      const u = (await input.db
        .select()
        .from(users)
        .where(eq(users.id, input.senderUserId))
        .limit(1))[0];
      if (!u) {
        return { ok: false, error: { code: "internal", message: tFor(input.locale, "commands:earning.transfer.senderMissing") } };
      }
      source = {
        kind: "user",
        ownerId: input.senderUserId,
        userId: input.senderUserId,
        displayName: u.username,
        serverId: DEFAULT_SERVER_ID,
      };
    }

    // Self-send = the exact same pool (kind + owner + server). Transfers
    // BETWEEN a user's own identities are deliberately allowed (owner
    // decision 2026-07-09, reversing the original account-wide block): the
    // master handle and each character keep separate pools and inventories,
    // and moving Currency among them is zero-sum. The sock-consolidation
    // concern the old account-wide check cited stays bounded by the
    // per-identity daily send/receive caps below, which apply to own-account
    // transfers all the same.
    if (source.kind === target.kind && source.ownerId === target.ownerId && source.serverId === target.serverId) {
      return {
        ok: false,
        error: { code: "self_send", message: tFor(input.locale, "commands:earning.transfer.selfSend") },
      };
    }

    // Per-server economy: Currency is partitioned per server and cannot cross
    // server boundaries. With the servers flag off both sides resolve to the
    // default server, so this guard never trips today.
    if (source.serverId !== target.serverId) {
      return {
        ok: false,
        error: { code: "cross_server", message: tFor(input.locale, "commands:earning.transfer.crossServer") },
      };
    }

    // Account-age gates (sender + recipient). Recipient age is checked on the
    // master account regardless of whether the target is a character, a
    // brand-new account can't take advantage of an old character's age.
    const senderRow = (await input.db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, source.userId)).limit(1))[0];
    const recipRow = (await input.db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, target.userId)).limit(1))[0];
    const dayMs = 24 * 60 * 60 * 1000;
    if (senderRow && Date.now() - +senderRow.createdAt < cfg.minSenderAccountAgeDays * dayMs) {
      return {
        ok: false,
        error: {
          code: "sender_too_new",
          message: tFor(input.locale, "commands:earning.transfer.senderTooNew", { days: cfg.minSenderAccountAgeDays }),
        },
      };
    }
    if (recipRow && Date.now() - +recipRow.createdAt < cfg.minRecipientAccountAgeDays * dayMs) {
      return {
        ok: false,
        error: {
          code: "recipient_too_new",
          message: tFor(input.locale, "commands:earning.transfer.recipientTooNew", { days: cfg.minRecipientAccountAgeDays }),
        },
      };
    }

    // Daily caps.
    const sentToday = await sumDailySent(input.db, source.serverId, source.kind, source.ownerId);
    if (sentToday + input.amount > cfg.dailySendCap) {
      const remaining = Math.max(0, cfg.dailySendCap - sentToday);
      return {
        ok: false,
        error: {
          code: "daily_send_cap",
          message: tFor(input.locale, "commands:earning.transfer.dailySendCap", { remaining }),
        },
      };
    }
    const receivedToday = await sumDailyReceived(input.db, target.serverId, target.kind, target.ownerId);
    if (receivedToday + input.amount > cfg.dailyReceiveCap) {
      return {
        ok: false,
        error: {
          code: "daily_receive_cap",
          message: tFor(input.locale, "commands:earning.transfer.dailyReceiveCap", { name: target.displayName }),
        },
      };
    }

    // Funds check.
    const balance = await readPoolCurrency(input.db, source.serverId, source.kind, source.ownerId);
    if (balance < input.amount) {
      return {
        ok: false,
        error: {
          code: "insufficient_funds",
          message: source.kind === "character"
            ? tFor(input.locale, "commands:earning.transfer.insufficientFundsCharacter", { balance, name: source.displayName })
            : tFor(input.locale, "commands:earning.transfer.insufficientFundsMaster", { balance }),
        },
      };
    }

    // Paired ledger writes via creditPool.
    await creditPool(input.db, input.io, {
      serverId: source.serverId,
      scope: source.kind,
      ownerId: source.ownerId,
      xpDelta: 0,
      currencyDelta: -input.amount,
      reason: "currency_send_out",
      metadata: { toScope: target.kind, toOwnerId: target.ownerId, toDisplayName: target.displayName },
      notifyUserId: source.userId,
    });
    await creditPool(input.db, input.io, {
      serverId: target.serverId,
      scope: target.kind,
      ownerId: target.ownerId,
      xpDelta: 0,
      currencyDelta: input.amount,
      reason: "currency_send_in",
      metadata: { fromScope: source.kind, fromOwnerId: source.ownerId, fromDisplayName: source.displayName },
      notifyUserId: target.userId,
    });
    return { ok: true, result: { amount: input.amount, source, target } };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[earning] transferCurrency failed", { err });
    return { ok: false, error: { code: "internal", message: tFor(input.locale, "commands:earning.transfer.failed") } };
  }
}
