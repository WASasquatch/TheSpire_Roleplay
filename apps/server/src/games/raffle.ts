/**
 * Raffles, item or currency prize, random draw at expiry.
 *
 * Two variants share one game module:
 *   - **Room raffle** (`/raffle item|currency …`), scoped to the
 *     room it was started in. Only people in that room can `/claim`.
 *   - **Sitewide raffle** (`/announceraffle item|currency …`),
 *     admin-only, broadcast across every room; anyone, anywhere can
 *     `/claim`. Result message fans out to every room the way
 *     `/announce all` does.
 *
 * Escrow rules:
 *   - The host's inventory (item raffle) or wallet (currency raffle)
 *     is debited at the moment `/raffle` is accepted. The prize then
 *     lives in the raffle session's state, not in any per-identity
 *     row.
 *   - At expiry: a uniform random draw across all claimants is the
 *     winner, the prize moves into their inventory / wallet. Self-
 *     claim by the host IS permitted (matches a real-world "I'll
 *     enter my own raffle", they put up the stake, they're allowed
 *     to win it back). The win is recorded with `purchase_raffle_…`-
 *     style ledger reasons so the audit trail is searchable.
 *   - At expiry with **no claimants**: the prize is REFUNDED to the
 *     host (re-credited to the same scope it came from). Nobody
 *     loses anything if the room ignores the raffle.
 *   - At explicit cancel by host (`/raffle cancel`): same refund
 *     path.
 *
 * Win-rule: uniform random draw of one claimant per raffle, even
 * for multi-count item prizes, the whole stack goes to one winner.
 * (Splitting an N-count prize across N first-come claimants was
 * discussed but tabled; if you want to give two cookies to two
 * people you can run two raffles.)
 */

import { and, eq } from "drizzle-orm";
import {
  registerGameKind,
  type GameScope,
  type GameSession,
  type IdentityKey,
  type ParticipantRef,
  type ResolveContext,
} from "./registry.js";
import { addMessageDirect, addSystemMessage } from "../realtime/broadcast.js";
import { identityInventory, rooms, users } from "../db/schema.js";
import { creditPool } from "../earning/award.js";
import { formatWinningsLine } from "./config.js";
import type { Db } from "../db/index.js";

export const ROOM_RAFFLE_KIND = "room-raffle";
export const SITEWIDE_RAFFLE_KIND = "sitewide-raffle";

/** Window defaults. Tuned for "room can react in time on mobile":
 *  60s room raffles match the read pace of a busy chat; sitewide
 *  raffles get a longer 180s window so people in rooms other than
 *  the host's see the broadcast and have time to type `/claim`. */
export const ROOM_RAFFLE_WINDOW_MS = 60_000;
export const SITEWIDE_RAFFLE_WINDOW_MS = 180_000;

export type PrizeKind = "item" | "currency";

export interface ItemPrize {
  kind: "item";
  itemKey: string;
  itemName: string;
  count: number;
}
export interface CurrencyPrize {
  kind: "currency";
  amount: number;
}
export type Prize = ItemPrize | CurrencyPrize;

export interface RaffleState {
  prize: Prize;
  /** Scope the prize was DEBITED from, snapshotted at start so the
   *  refund/credit lands in the same place even if the host
   *  switches identities mid-raffle. */
  hostScope: "user" | "character";
  hostOwnerId: string;
  hostUserId: string;
  claimants: Map<IdentityKey, ParticipantRef>;
}

/* ---------- Escrow primitives ---------- */

/**
 * Debit `count` units of `itemKey` from the given inventory pool.
 * Returns `{ ok: true }` on success, `{ ok: false, have }` when the
 * pool doesn't have enough. Wrapped in a single transaction so a
 * concurrent transfer can't double-spend the stack between read and
 * write, same pattern as `handleItemCommand` in items.ts.
 *
 * Pure escrow primitive, no message side-effect, no ledger entry.
 * Callers post the user-facing notice; the inventory event is
 * emitted to the host's other sockets via the standard inventory-
 * changed broadcast (raffle paths don't fan that out since the
 * change isn't visible to the receiver until the resolution
 * credits a winner; if a future UI surfaces "in-flight escrow" we
 * can re-broadcast here).
 */
export function debitItemFromInventory(
  db: Db,
  scope: "user" | "character",
  ownerId: string,
  itemKey: string,
  count: number,
): { ok: true } | { ok: false; have: number } {
  return db.transaction((tx): { ok: true } | { ok: false; have: number } => {
    const row = tx.select({ qty: identityInventory.quantity })
      .from(identityInventory)
      .where(and(
        eq(identityInventory.ownerScope, scope),
        eq(identityInventory.ownerId, ownerId),
        eq(identityInventory.itemKey, itemKey),
      ))
      .limit(1)
      .all()[0];
    const have = row?.qty ?? 0;
    if (have < count) return { ok: false, have };
    const remaining = have - count;
    if (remaining === 0) {
      tx.delete(identityInventory).where(and(
        eq(identityInventory.ownerScope, scope),
        eq(identityInventory.ownerId, ownerId),
        eq(identityInventory.itemKey, itemKey),
      )).run();
    } else {
      tx.update(identityInventory)
        .set({ quantity: remaining, updatedAt: new Date() })
        .where(and(
          eq(identityInventory.ownerScope, scope),
          eq(identityInventory.ownerId, ownerId),
          eq(identityInventory.itemKey, itemKey),
        ))
        .run();
    }
    return { ok: true };
  });
}

/** Mirror of `debitItemFromInventory` for the credit side. Used to
 *  pay out the winner AND to refund the host on no-claimants /
 *  cancel. Caller passes the count it knows is escrowed (the value
 *  stored in `RaffleState.prize.count`), so a partial loss between
 *  start and resolution can't paper over a bug here. */
export function creditItemToInventory(
  db: Db,
  scope: "user" | "character",
  ownerId: string,
  itemKey: string,
  count: number,
): void {
  db.transaction((tx) => {
    const row = tx.select({ qty: identityInventory.quantity })
      .from(identityInventory)
      .where(and(
        eq(identityInventory.ownerScope, scope),
        eq(identityInventory.ownerId, ownerId),
        eq(identityInventory.itemKey, itemKey),
      ))
      .limit(1)
      .all()[0];
    if (row) {
      tx.update(identityInventory)
        .set({ quantity: row.qty + count, updatedAt: new Date() })
        .where(and(
          eq(identityInventory.ownerScope, scope),
          eq(identityInventory.ownerId, ownerId),
          eq(identityInventory.itemKey, itemKey),
        ))
        .run();
    } else {
      tx.insert(identityInventory).values({
        ownerScope: scope,
        ownerId,
        itemKey,
        quantity: count,
      }).run();
    }
  });
}

/* ---------- Claimant bookkeeping ---------- */

export function recordClaimant(
  session: GameSession,
  key: IdentityKey,
  participant: ParticipantRef,
): { firstTime: boolean } {
  const state = session.state as RaffleState;
  const had = state.claimants.has(key);
  if (!had) state.claimants.set(key, participant);
  return { firstTime: !had };
}

/** Snapshot of the prize for inline display in start / claim notices. */
export function prizeLabel(prize: Prize): string {
  if (prize.kind === "currency") {
    return `${prize.amount.toLocaleString()} Currency`;
  }
  const noun = prize.count === 1 ? prize.itemName : `${prize.itemName} ×${prize.count}`;
  return noun;
}

/* ---------- Resolution + cancel ---------- */

async function resolveRaffle(session: GameSession, ctx: ResolveContext): Promise<void> {
  const state = session.state as RaffleState;
  const claimants = Array.from(state.claimants.values());
  const prizeText = prizeLabel(state.prize);

  if (claimants.length === 0) {
    // No takers, refund the host and post a short notice.
    await refundPrize(ctx.db, ctx.io, state);
    await postRaffleResult(
      ctx,
      session.scope,
      session.host,
      `🎟 ${session.host.displayName}'s raffle (${prizeText}) ended with no claims. The prize returned to the host.`,
    );
    return;
  }

  // Uniform random draw. Math.random is fine for entertainment-tier
  // fairness; cryptographic RNG would be overkill and the result
  // message lists every entrant so a suspicious crowd can verify
  // who was in the pool.
  const winnerIdx = Math.floor(Math.random() * claimants.length);
  const winner = claimants[winnerIdx]!;
  await awardPrize(ctx.db, ctx.io, state, winner);

  // Result line. Every claimant gets a row so the room sees the full
  // pool, with the winner explicitly marked.
  const lines: string[] = [];
  lines.push(`🎟 ${session.host.displayName}'s raffle: ${prizeText}.`);
  lines.push(`${claimants.length} ${claimants.length === 1 ? "claimant" : "claimants"}:`);
  for (const c of claimants) {
    const isWinner = c.userId === winner.userId && c.characterId === winner.characterId;
    lines.push(`  • ${c.displayName}${isWinner ? " ← winner" : ""}`);
  }
  lines.push("Drawn at random.");
  lines.push(`🎁 ${winner.displayName} walks away with ${prizeText}.`);
  // Record the raffle win in game_stats so rankings include raffles
  // alongside the competitive games. Both room and sitewide raffles
  // collapse under the single "raffle" stat kind so the leaderboard
  // doesn't fork an arbitrary mechanic distinction. Passes an empty
  // reward shape, raffles don't mint XP/Currency rewards (the prize
  // is the prize); we only want the side-effect stat row update.
  // The string return is ignored, the prize-text line above is the
  // human-facing announcement.
  await formatWinningsLine(
    ctx.db,
    "raffle",
    [winner],
    { xp: 0, currency: 0, itemKey: null, itemCount: 0 },
  );
  await postRaffleResult(ctx, session.scope, session.host, lines.join("\n"));
}

async function cancelRaffle(session: GameSession, ctx: ResolveContext): Promise<void> {
  const state = session.state as RaffleState;
  const prizeText = prizeLabel(state.prize);
  await refundPrize(ctx.db, ctx.io, state);
  await postRaffleResult(
    ctx,
    session.scope,
    session.host,
    `🎟 ${session.host.displayName} cancelled their raffle (${prizeText}). Refunded.`,
  );
}

/** Where the result/refund lines land. Room raffles post into the
 *  hosting room only; sitewide raffles fan out via the same per-
 *  room loop `/announce all` uses, so every room sees the result
 *  in chat-line form. */
async function postRaffleResult(
  ctx: ResolveContext,
  scope: GameScope,
  _host: ParticipantRef,
  body: string,
): Promise<void> {
  if (scope.kind === "room") {
    await addSystemMessage(ctx.io, ctx.db, scope.roomId, body);
    return;
  }
  // Sitewide. We use `addMessageDirect` with `kind: "announce"` so
  // each room's renderer paints the result with the same prominence
  // as the manual `/announce all` line. The system sentinel user
  // owns the row (matches addSystemMessage), so there's no
  // attribution leak from the host's identity into rooms they
  // aren't in.
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
      body,
    });
  }
}

async function refundPrize(db: Db, io: import("socket.io").Server, state: RaffleState): Promise<void> {
  if (state.prize.kind === "currency") {
    await creditPool(db, io as never, {
      scope: state.hostScope,
      ownerId: state.hostOwnerId,
      xpDelta: 0,
      currencyDelta: state.prize.amount,
      reason: "raffle_refund",
      notifyUserId: state.hostUserId,
    });
    return;
  }
  // Item refund.
  creditItemToInventory(db, state.hostScope, state.hostOwnerId, state.prize.itemKey, state.prize.count);
}

/**
 * Award the prize to the winner. No stack-cap check, players
 * accumulate without ceiling, by design (the catalog's `stackLimit`
 * column is vestigial as of 2026). The catalog row could in
 * principle be deleted between raffle start and resolve; we just
 * credit the recorded item key and let the inventory row absorb it.
 * If the item was hard-deleted (FK cascade), the credit insert
 * would fail at the SQL layer; that defensive case is rare enough
 * to leave unhandled here, same posture as the rest of the item-
 * mutation paths.
 */
async function awardPrize(
  db: Db,
  io: import("socket.io").Server,
  state: RaffleState,
  winner: ParticipantRef,
): Promise<void> {
  const winnerScope: "user" | "character" = winner.characterId ? "character" : "user";
  const winnerOwnerId = winner.characterId ?? winner.userId;
  if (state.prize.kind === "currency") {
    await creditPool(db, io as never, {
      scope: winnerScope,
      ownerId: winnerOwnerId,
      xpDelta: 0,
      currencyDelta: state.prize.amount,
      reason: "raffle_win",
      notifyUserId: winner.userId,
    });
    return;
  }
  creditItemToInventory(db, winnerScope, winnerOwnerId, state.prize.itemKey, state.prize.count);
}

/** Module init, registers both raffle kinds with the framework.
 *  They share resolve/cancel hooks because the only behavioral
 *  difference is where the result line is posted (handled inside
 *  `postRaffleResult` via the scope discriminator). */
export function registerRaffle(): void {
  registerGameKind(ROOM_RAFFLE_KIND, { onResolve: resolveRaffle, onCancel: cancelRaffle });
  registerGameKind(SITEWIDE_RAFFLE_KIND, { onResolve: resolveRaffle, onCancel: cancelRaffle });
}
