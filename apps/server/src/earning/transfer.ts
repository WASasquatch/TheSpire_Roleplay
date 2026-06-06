/**
 * Currency transfers (`/currency send`).
 *
 * Enforces the anti-abuse gates from `site_settings.earning_config_json
 * .currencyTransfer`:
 *   - master enabled flag
 *   - sender + recipient account age minimums
 *   - per-day send + receive caps
 *   - min / max single-transfer amounts
 *   - no self-sends (including character ↔ character of the same user)
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
import { creditPool } from "./award.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

export type TransferTargetKind = "user" | "character";

export interface TransferTarget {
  kind: TransferTargetKind;
  /** The pool's owner id (userId for kind='user', characterId for kind='character'). */
  ownerId: string;
  /** Master user that owns the pool, used for self-send checks and event emission. */
  userId: string;
  displayName: string;
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
): Promise<{ ok: true; target: TransferTarget } | { ok: false; error: TransferError } | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
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
  }));
  const userCandidate: TransferTarget | null = userRow
    ? {
        kind: "user",
        ownerId: userRow.id,
        userId: userRow.id,
        displayName: userRow.username,
      }
    : null;

  // Collision detection: a user with the same name as a character
  // they don't own.
  if (userCandidate && characterCandidates.some((c) => c.userId !== userCandidate.userId)) {
    return {
      ok: false,
      error: {
        code: "did_you_mean",
        message: `"${trimmed}" matches a character and a user, be more specific.`,
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
        message: `"${trimmed}" matches multiple characters, be more specific.`,
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
async function sumDailySent(db: Db, scope: "user" | "character", ownerId: string): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ delta: earningLedger.currencyDelta })
    .from(earningLedger)
    .where(and(
      eq(earningLedger.scope, scope),
      eq(earningLedger.ownerId, ownerId),
      eq(earningLedger.reason, "currency_send_out"),
      gte(earningLedger.createdAt, cutoff),
    ))
    .all();
  return rows.reduce((acc, r) => acc + Math.abs(r.delta), 0);
}

async function sumDailyReceived(db: Db, scope: "user" | "character", ownerId: string): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ delta: earningLedger.currencyDelta })
    .from(earningLedger)
    .where(and(
      eq(earningLedger.scope, scope),
      eq(earningLedger.ownerId, ownerId),
      eq(earningLedger.reason, "currency_send_in"),
      gte(earningLedger.createdAt, cutoff),
    ))
    .all();
  return rows.reduce((acc, r) => acc + r.delta, 0);
}

async function readPoolCurrency(db: Db, scope: "user" | "character", ownerId: string): Promise<number> {
  if (scope === "user") {
    const row = (await db
      .select({ c: userEarning.currency })
      .from(userEarning)
      .where(eq(userEarning.userId, ownerId))
      .limit(1))[0];
    return row?.c ?? 0;
  }
  const row = (await db
    .select({ c: characterEarning.currency })
    .from(characterEarning)
    .where(eq(characterEarning.characterId, ownerId))
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
        error: { code: "transfers_disabled", message: "Currency transfers are disabled." },
      };
    }
    if (!Number.isFinite(input.amount) || !Number.isInteger(input.amount)) {
      return {
        ok: false,
        error: { code: "amount_out_of_range", message: "Amount must be a whole number." },
      };
    }
    if (input.amount < cfg.minTransferAmount || input.amount > cfg.maxTransferAmount) {
      return {
        ok: false,
        error: {
          code: "amount_out_of_range",
          message: `Amount must be between ${cfg.minTransferAmount} and ${cfg.maxTransferAmount} Currency.`,
        },
      };
    }

    // Resolve target.
    const resolved = await resolveTransferTarget(input.db, input.rawTarget);
    if (!resolved) {
      return {
        ok: false,
        error: { code: "target_not_found", message: `No user or character named "${input.rawTarget}".` },
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
        return { ok: false, error: { code: "internal", message: "Sender character not found." } };
      }
      source = {
        kind: "character",
        ownerId: c.id,
        userId: input.senderUserId,
        displayName: c.name,
      };
    } else {
      const u = (await input.db
        .select()
        .from(users)
        .where(eq(users.id, input.senderUserId))
        .limit(1))[0];
      if (!u) {
        return { ok: false, error: { code: "internal", message: "Sender not found." } };
      }
      source = {
        kind: "user",
        ownerId: input.senderUserId,
        userId: input.senderUserId,
        displayName: u.username,
      };
    }

    // Self-send checks: same identity, OR same master account regardless of
    // which character is involved. The latter blocks farming Currency on
    // sock characters and consolidating onto the main.
    if (source.userId === target.userId) {
      return {
        ok: false,
        error: { code: "self_send", message: "You can't send Currency to yourself." },
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
          message: `Your account needs to be at least ${cfg.minSenderAccountAgeDays} days old to send Currency.`,
        },
      };
    }
    if (recipRow && Date.now() - +recipRow.createdAt < cfg.minRecipientAccountAgeDays * dayMs) {
      return {
        ok: false,
        error: {
          code: "recipient_too_new",
          message: `Recipient's account needs to be at least ${cfg.minRecipientAccountAgeDays} days old.`,
        },
      };
    }

    // Daily caps.
    const sentToday = await sumDailySent(input.db, source.kind, source.ownerId);
    if (sentToday + input.amount > cfg.dailySendCap) {
      const remaining = Math.max(0, cfg.dailySendCap - sentToday);
      return {
        ok: false,
        error: {
          code: "daily_send_cap",
          message: `That exceeds your daily send cap. ${remaining} Currency remaining today.`,
        },
      };
    }
    const receivedToday = await sumDailyReceived(input.db, target.kind, target.ownerId);
    if (receivedToday + input.amount > cfg.dailyReceiveCap) {
      return {
        ok: false,
        error: {
          code: "daily_receive_cap",
          message: `${target.displayName} has reached their daily receive cap. Try again tomorrow.`,
        },
      };
    }

    // Funds check.
    const balance = await readPoolCurrency(input.db, source.kind, source.ownerId);
    if (balance < input.amount) {
      return {
        ok: false,
        error: {
          code: "insufficient_funds",
          message: `You only have ${balance} Currency in your ${source.kind === "character" ? source.displayName : "master"} pool.`,
        },
      };
    }

    // Paired ledger writes via creditPool.
    await creditPool(input.db, input.io, {
      scope: source.kind,
      ownerId: source.ownerId,
      xpDelta: 0,
      currencyDelta: -input.amount,
      reason: "currency_send_out",
      metadata: { toScope: target.kind, toOwnerId: target.ownerId, toDisplayName: target.displayName },
      notifyUserId: source.userId,
    });
    await creditPool(input.db, input.io, {
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
    return { ok: false, error: { code: "internal", message: "Transfer failed. Try again in a moment." } };
  }
}
