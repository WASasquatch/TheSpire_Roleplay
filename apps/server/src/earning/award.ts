/**
 * Earning award engine — single entry point for crediting XP +
 * Currency onto a pool, writing the ledger row, recomputing rank
 * placement, and emitting the socket events.
 *
 * Every earn path in the codebase (chat, forum, presence, admin
 * grants, future sources) routes through `creditPool` so the
 * ledger ↔ earning ↔ notifications invariants live in one place.
 *
 * Higher-level helpers:
 *   - `awardForMessage` — the addMessage hook. Handles routing rule
 *     + multi-character fan-out + body floor + source toggles.
 *   - `awardForForum`  — forum topic / reply crediting.
 *   - `creditPool`     — the primitive every other helper composes.
 *
 * All writes are best-effort from the caller's perspective: failures
 * are logged but never thrown out of the engine, so a flaky earning
 * write can't break message persistence.
 */

import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Server as IoServer } from "socket.io";
import type {
  ClientToServerEvents,
  MessageKind,
  ServerToClientEvents,
} from "@thekeep/shared";
import type { Db } from "../db/index.js";
import {
  characterEarning,
  rankTiers,
  ranks,
  earningLedger,
  userEarning,
} from "../db/schema.js";
import { getSettings } from "../settings.js";
import type { EarningConfig } from "./config.js";
import { analyzeMessageQuality, recordAwardedMessage } from "./messageQuality.js";
import {
  diffCrossing,
  mergeMaxEverHeldSync,
  placeRankForXpSync,
} from "./resolver.js";
import { recordRankUp } from "./notifications.js";
import { messageSourceKind, routeMessage } from "./routing.js";
import { liveCharacterIdsOnly } from "./scopes.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

export type AwardScopeKind = "user" | "character";

export interface CreditPoolInput {
  scope: AwardScopeKind;
  ownerId: string;
  xpDelta: number;
  currencyDelta: number;
  reason: string;
  metadata?: Record<string, unknown> | null;
  /** Master account id used to emit `earning:earned` / `earning:rankup` to the user's live sockets — same id for both scopes. */
  notifyUserId: string;
}

/**
 * Core primitive. Inserts a ledger row, upserts the earning row,
 * recomputes rank placement, records a rank-up notification when a
 * tier boundary is crossed, and fires the socket events.
 *
 * Idempotency: the caller is responsible for de-duplication. A second
 * call with the same `reason` + `metadata` writes a second ledger row.
 * (Anti-abuse caps for crediting paths that need them — daily-cap
 * social, periodic presence — are enforced in their respective
 * helpers, not here.)
 *
 * Zero deltas are tolerated and short-circuit before the earning
 * read so the caller doesn't need to gate before calling.
 */
export async function creditPool(
  db: Db,
  io: Io,
  input: CreditPoolInput,
): Promise<void> {
  if (input.xpDelta === 0 && input.currencyDelta === 0) return;
  try {
    // ALL state mutations live inside a single sync sqlite transaction
    // so two concurrent credits can't lose a write. Earlier versions
    // did `read prior → compute new → write` outside a transaction —
    // a classic read-modify-write race that lost increments under
    // bursty load (presence sweep, rapid forum replies). The
    // transaction below holds sqlite's write lock across the entire
    // read-compute-write window, eliminating that race.
    //
    // The transaction returns the rich state the post-commit emit
    // step needs: prior values for crossing diff, new totals for
    // the wire payload, the resolved rank + peak for the rank-up
    // notification path.
    const txResult: {
      prior: PriorEarning;
      newXp: number;
      newCurrency: number;
      placed: { rankKey: string | null; tier: number | null };
      peak: { maxRankKeyEverHeld: string | null; maxTierEverHeld: number | null };
    } = db.transaction((tx) => {
      // 1. Lazy create row.
      if (input.scope === "user") {
        tx.insert(userEarning).values({ userId: input.ownerId }).onConflictDoNothing().run();
      } else {
        tx.insert(characterEarning).values({ characterId: input.ownerId }).onConflictDoNothing().run();
      }

      // 2. Read prior under the write lock so the next write can't be
      //    overlapped by another credit.
      const prior: PriorEarning = readPriorEarningSync(tx, input.scope, input.ownerId);

      // 3. Compute new totals + rank placement using pre-loaded rank/tier
      //    rows (sync helpers — the async `resolveRankForXp` can't run
      //    inside the transaction callback).
      const newXp = prior.xp + input.xpDelta;
      const newCurrency = Math.max(0, prior.currency + input.currencyDelta);
      const rankRows = tx.select().from(ranks).all();
      const tierRows = tx.select().from(rankTiers).all();
      const placed = placeRankForXpSync(rankRows, tierRows, newXp);
      const peak = mergeMaxEverHeldSync(rankRows, {
        maxRankKeyEverHeld: prior.maxRankKeyEverHeld,
        maxTierEverHeld: prior.maxTierEverHeld,
      }, placed);

      // 4. Single UPDATE — xp, currency, rank, tier, peak in one
      //    write. Atomic with the read above thanks to the
      //    transaction.
      if (input.scope === "user") {
        tx.update(userEarning).set({
          xp: newXp,
          currency: newCurrency,
          rankKey: placed.rankKey,
          tier: placed.tier,
          maxRankKeyEverHeld: peak.maxRankKeyEverHeld,
          maxTierEverHeld: peak.maxTierEverHeld,
          updatedAt: new Date(),
        }).where(eq(userEarning.userId, input.ownerId)).run();
      } else {
        tx.update(characterEarning).set({
          xp: newXp,
          currency: newCurrency,
          rankKey: placed.rankKey,
          tier: placed.tier,
          maxRankKeyEverHeld: peak.maxRankKeyEverHeld,
          maxTierEverHeld: peak.maxTierEverHeld,
          updatedAt: new Date(),
        }).where(eq(characterEarning.characterId, input.ownerId)).run();
      }

      // 5. Ledger row — included in the same transaction so a crash
      //    between earning update and ledger insert can't lose the
      //    audit row.
      tx.insert(earningLedger).values({
        id: nanoid(),
        scope: input.scope,
        ownerId: input.ownerId,
        xpDelta: input.xpDelta,
        currencyDelta: input.currencyDelta,
        reason: input.reason,
        metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      }).run();

      return { prior, newXp, newCurrency, placed, peak };
    });

    // 6. Post-commit: rank crossing detection + notification + socket
    //    emit. These don't need to be transactional with the credit —
    //    a missed emit is recoverable on the next dashboard fetch,
    //    and the persisted notification row is the durable record.
    const { prior, newXp, newCurrency, placed, peak } = txResult;
    const crossing = diffCrossing(
      {
        rankKey: prior.rankKey,
        tier: prior.tier,
        maxRankKeyEverHeld: prior.maxRankKeyEverHeld,
        maxTierEverHeld: prior.maxTierEverHeld,
      },
      placed,
      peak,
    );

    let notificationId: string | null = null;
    if (crossing) {
      const record = await recordRankUp(db, {
        userId: input.notifyUserId,
        scope: input.scope,
        characterId: input.scope === "character" ? input.ownerId : null,
        crossing,
      });
      notificationId = record.id;
    }

    const sockets = await io.fetchSockets();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid !== input.notifyUserId) continue;
      s.emit("earning:earned", {
        scope: input.scope,
        ownerId: input.ownerId,
        xpDelta: input.xpDelta,
        currencyDelta: input.currencyDelta,
        xpTotal: newXp,
        currencyTotal: newCurrency,
        rankKey: placed.rankKey,
        tier: placed.tier,
        reason: input.reason,
      });
      if (crossing && notificationId) {
        s.emit("earning:rankup", {
          notificationId,
          scope: input.scope,
          characterId: input.scope === "character" ? input.ownerId : null,
          fromRankKey: crossing.fromRankKey,
          fromTier: crossing.fromTier,
          toRankKey: crossing.toRankKey,
          toTier: crossing.toTier,
          newlyEligibleBorderKeys: crossing.newlyEligibleBorderKeys,
        });
      }
    }
  } catch (err) {
    // Log only — never surface to the caller. A earning-write failure
    // must not break the message persistence path.
    // eslint-disable-next-line no-console
    console.error("[earning] creditPool failed", { input, err });
  }
}

/** Sync read of the earning row used inside the transaction. */
function readPriorEarningSync(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  scope: AwardScopeKind,
  ownerId: string,
): PriorEarning {
  if (scope === "user") {
    const row = tx.select().from(userEarning).where(eq(userEarning.userId, ownerId)).limit(1).all()[0];
    if (row) {
      return {
        xp: row.xp,
        currency: row.currency,
        rankKey: row.rankKey,
        tier: row.tier,
        maxRankKeyEverHeld: row.maxRankKeyEverHeld,
        maxTierEverHeld: row.maxTierEverHeld,
      };
    }
    return { xp: 0, currency: 0, rankKey: null, tier: null, maxRankKeyEverHeld: null, maxTierEverHeld: null };
  }
  const row = tx.select().from(characterEarning).where(eq(characterEarning.characterId, ownerId)).limit(1).all()[0];
  if (row) {
    return {
      xp: row.xp,
      currency: row.currency,
      rankKey: row.rankKey,
      tier: row.tier,
      maxRankKeyEverHeld: row.maxRankKeyEverHeld,
      maxTierEverHeld: row.maxTierEverHeld,
    };
  }
  return { xp: 0, currency: 0, rankKey: null, tier: null, maxRankKeyEverHeld: null, maxTierEverHeld: null };
}

interface PriorEarning {
  xp: number;
  currency: number;
  rankKey: string | null;
  tier: number | null;
  maxRankKeyEverHeld: string | null;
  maxTierEverHeld: number | null;
}

export interface AwardForMessageInput {
  db: Db;
  io: Io;
  userId: string;
  /** Snapshot from the persisted message — the character the author was attached as at send time. */
  characterId: string | null;
  /** User's master-row active_character_id, used as the fallback for sockets without a per-tab override when fanning out. */
  defaultActiveCharacterId: string | null;
  kind: MessageKind;
  body: string;
  roomId: string;
  messageId: string;
}

/**
 * Award entry for a chat message. Called from `addMessage` after the
 * row has been persisted + emitted, on a fire-and-forget basis (the
 * caller `void`s the promise — failures stay inside the engine).
 *
 * Decides:
 *   1. Body floor — short messages award nothing.
 *   2. Source-kind config lookup (`say` / `action` / `whisper`).
 *   3. Per-pool enabled flags — XP and Currency are toggled
 *      independently per source.
 *   4. Routing (IC → character fan-out, OOC → master).
 *   5. Multi-character divisor application when fanning out.
 */
export async function awardForMessage(input: AwardForMessageInput): Promise<void> {
  try {
    const settings = await getSettings(input.db);
    const cfg = settings.earningConfig;
    if (!cfg.enabled) return;
    if (input.body.trim().length < cfg.bodyFloorChars) return;

    const source = messageSourceKind(input.kind);
    if (source === "none") return;
    const scope = routeMessage(input.kind, input.characterId);
    if (scope.kind === "none") return;

    const amounts = cfg.awards.message[source];
    const sourceFlags = cfg.enabledSources.message;
    const baseXp = sourceFlags.xp ? amounts.xp : 0;
    const baseCurrency = sourceFlags.currency ? amounts.currency : 0;
    if (baseXp === 0 && baseCurrency === 0) return;

    // Length bonus + spam detection. Both knobs live on
    // `cfg.messageQuality`; the helper does the linear interp +
    // heuristic checks and returns a multiplier + spam verdict.
    // Spam-flagged messages drop to zero but still write a ledger
    // row (with metadata.flaggedSpam) so admins can audit. Non-
    // flagged messages get logged into the echo cache AFTER the
    // credit decision below (we don't poison the cache with spam).
    const lengthSpec = cfg.messageQuality.lengthBonus[source];
    const quality = analyzeMessageQuality(
      cfg.messageQuality,
      lengthSpec,
      input.userId,
      input.body,
    );
    const xp = quality.flaggedSpam ? 0 : Math.round(baseXp * quality.multiplier);
    const currency = quality.flaggedSpam ? 0 : Math.round(baseCurrency * quality.multiplier);

    const reason = `message_${source}`;
    const metadata: Record<string, unknown> = {
      messageId: input.messageId,
      roomId: input.roomId,
      kind: input.kind,
      bodyLen: quality.length,
      multiplier: Number(quality.multiplier.toFixed(2)),
    };
    if (quality.flaggedSpam) {
      metadata.flaggedSpam = true;
      metadata.spamReason = quality.spamReason;
    }

    // If everything zeroes out (spam OR an admin-disabled source
    // with no bonus), skip the credit + ledger write entirely.
    // Writing a ledger row for a 0/0 award would just be noise.
    if (xp === 0 && currency === 0) {
      // Don't update the echo cache here — only legitimately-awarded
      // messages prime it, see helper docstring.
      return;
    }

    // Prime echo cache for next-message lookback. Done up-front (not
    // post-credit) because `creditPool` is async and a rapid follow-
    // up message could race in before we'd otherwise have recorded
    // this one. Helper trims + lowercases internally.
    recordAwardedMessage(input.userId, input.body);

    if (scope.kind === "master") {
      await creditPool(input.db, input.io, {
        scope: "user",
        ownerId: input.userId,
        xpDelta: xp,
        currencyDelta: currency,
        reason,
        metadata,
        notifyUserId: input.userId,
      });
      return;
    }

    // IC fan-out: credit every logged-in character of the sender.
    // The multi-character divisor (default 1.0) scales the per-character
    // amount so admins can throttle if a user with many characters
    // online is inflating the economy.
    const characters = await liveCharacterIdsOnly(
      input.io,
      input.userId,
      input.defaultActiveCharacterId,
    );
    if (characters.length === 0) {
      // Defensive: the sender posted as a character, so at minimum
      // THIS character is live. Fall back to the message's characterId
      // so we never silently drop an IC award when the live-socket
      // lookup misses (e.g. race with disconnect).
      if (input.characterId) characters.push(input.characterId);
    }
    const divisor = Math.max(0, cfg.multiCharacterEarnDivisor);
    const xpEach = Math.round(xp * divisor);
    const currencyEach = Math.round(currency * divisor);
    if (xpEach === 0 && currencyEach === 0) return;
    for (const charId of characters) {
      await creditPool(input.db, input.io, {
        scope: "character",
        ownerId: charId,
        xpDelta: xpEach,
        currencyDelta: currencyEach,
        reason,
        metadata,
        notifyUserId: input.userId,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[earning] awardForMessage failed", { messageId: input.messageId, err });
  }
}

/**
 * Award entry for forum activity (topic create / reply). Always
 * credits the master pool in v1 (every board is treated as OOC); the
 * per-board IC flag is a documented future addition.
 */
export async function awardForForum(input: {
  db: Db;
  io: Io;
  userId: string;
  kind: "topic" | "reply";
  messageId: string;
  roomId: string;
}): Promise<void> {
  try {
    const settings = await getSettings(input.db);
    const cfg = settings.earningConfig;
    if (!cfg.enabled) return;
    const amounts = cfg.awards.forum[input.kind];
    const sourceFlags = cfg.enabledSources.forum;
    const xp = sourceFlags.xp ? amounts.xp : 0;
    const currency = sourceFlags.currency ? amounts.currency : 0;
    if (xp === 0 && currency === 0) return;
    await creditPool(input.db, input.io, {
      scope: "user",
      ownerId: input.userId,
      xpDelta: xp,
      currencyDelta: currency,
      reason: `forum_${input.kind}`,
      metadata: { messageId: input.messageId, roomId: input.roomId },
      notifyUserId: input.userId,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[earning] awardForForum failed", { messageId: input.messageId, err });
  }
}

/**
 * Award entry for the presence sweep. Credits a single block tick. The
 * caller (`sweeps.ts`) handles cap-per-day enforcement and the IC vs
 * OOC scope decision — this helper just performs the credit.
 */
export async function awardForPresence(input: {
  db: Db;
  io: Io;
  cfg: EarningConfig;
  scope: AwardScopeKind;
  ownerId: string;
  notifyUserId: string;
  roomId: string;
}): Promise<void> {
  const amounts = input.cfg.awards.presence.perBlock;
  const flags = input.cfg.enabledSources.presence;
  const xp = flags.xp ? amounts.xp : 0;
  const currency = flags.currency ? amounts.currency : 0;
  if (xp === 0 && currency === 0) return;
  await creditPool(input.db, input.io, {
    scope: input.scope,
    ownerId: input.ownerId,
    xpDelta: xp,
    currencyDelta: currency,
    reason: input.scope === "character" ? "presence_ic" : "presence_ooc",
    metadata: { roomId: input.roomId },
    notifyUserId: input.notifyUserId,
  });
}
