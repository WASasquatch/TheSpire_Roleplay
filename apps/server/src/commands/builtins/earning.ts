/**
 * `/currency` and `/exp`, Earning slash commands.
 *
 * Output is **ephemeral and visible only to the requester** per the
 * Earning plan. We emit through `error:notice` (the existing
 * ephemeral channel, same code-as-tag convention `/color` uses).
 *
 * `/currency` subcommands:
 *   /currency                       Show your own balances (master + active character).
 *   /currency [name]                Show another user's master Currency balance (honors privacy).
 *   /currency send [target] [amt]   Transfer Currency. Source = currently-active identity;
 *                                   target is resolved by character-first / user-second lookup.
 *
 * `/exp` subcommands:
 *   /exp                            Show your own XP, Rank, Tier, and any borders you can buy.
 *   /exp [name]                     Show another user's master Rank and Tier.
 */

import { and, eq, sql } from "drizzle-orm";
import {
  characterEarning,
  characters,
  rankTiers,
  ranks,
  userOwnedBorders,
  userEarning,
} from "../../db/schema.js";
import type { CommandContext, CommandHandler } from "../types.js";
import { transferCurrency } from "../../earning/transfer.js";
import { resolveRoomServerId } from "../../earning/pool.js";
import { resolveIdentityArg, emitAmbiguousIdentityModal } from "../identityArg.js";
import { tFor } from "../../i18n.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

interface PoolSummary {
  scopeLabel: string;
  currency: number;
  xp: number;
  rankName: string | null;
  tierLabel: string | null;
}

async function readUserPool(
  db: import("../../db/index.js").Db,
  userId: string,
  sid: string,
): Promise<PoolSummary> {
  const row = (await db
    .select()
    .from(userEarning)
    .where(and(eq(userEarning.serverId, sid), eq(userEarning.userId, userId)))
    .limit(1))[0];
  if (!row) {
    return { scopeLabel: "master", currency: 0, xp: 0, rankName: null, tierLabel: null };
  }
  const rt = await resolveRankLabels(db, row.rankKey, row.tier, sid);
  return {
    scopeLabel: "master",
    currency: row.currency,
    xp: row.xp,
    rankName: rt.rankName,
    tierLabel: rt.tierLabel,
  };
}

async function readCharacterPool(
  db: import("../../db/index.js").Db,
  characterId: string,
  characterName: string,
  sid: string,
): Promise<PoolSummary> {
  const row = (await db
    .select()
    .from(characterEarning)
    .where(and(eq(characterEarning.serverId, sid), eq(characterEarning.characterId, characterId)))
    .limit(1))[0];
  if (!row) {
    return { scopeLabel: characterName, currency: 0, xp: 0, rankName: null, tierLabel: null };
  }
  const rt = await resolveRankLabels(db, row.rankKey, row.tier, sid);
  return {
    scopeLabel: characterName,
    currency: row.currency,
    xp: row.xp,
    rankName: rt.rankName,
    tierLabel: rt.tierLabel,
  };
}

async function resolveRankLabels(
  db: import("../../db/index.js").Db,
  rankKey: string | null,
  tier: number | null,
  sid: string,
): Promise<{ rankName: string | null; tierLabel: string | null }> {
  if (!rankKey || tier == null) return { rankName: null, tierLabel: null };
  // Per-server catalog (migrations 0295-0296): resolve the rank/tier labels from
  // the pool's own server, so a same-key rank on another server can't supply a
  // wrong name/label. Flag off ⇒ sid is the default, byte-identical to today.
  const rankRow = (await db
    .select({ name: ranks.name })
    .from(ranks)
    .where(and(eq(ranks.serverId, sid), eq(ranks.key, rankKey)))
    .limit(1))[0];
  const tierRow = (await db
    .select({ label: rankTiers.label })
    .from(rankTiers)
    .where(and(eq(rankTiers.serverId, sid), eq(rankTiers.rankKey, rankKey), eq(rankTiers.tier, tier)))
    .limit(1))[0];
  return { rankName: rankRow?.name ?? null, tierLabel: tierRow?.label ?? null };
}

function formatPool(locale: string | null, p: PoolSummary): string {
  const rankBit = p.rankName ? ` · ${p.rankName} ${p.tierLabel ?? ""}`.trimEnd() : "";
  return tFor(locale, "commands:earning.poolLine", {
    scope: p.scopeLabel,
    currency: p.currency,
    xp: p.xp,
    rankBit,
  });
}

/**
 * List borders the user has reached the Tier IV threshold for but
 * hasn't yet purchased. Used by `/exp` (own view), reads:
 *   - user_earning.maxRankKeyEverHeld / maxTierEverHeld → highest peak
 *   - ranks table (display order) → every rank at or below the peak
 *     whose Tier IV the user has crossed
 *   - user_owned_borders → subtract ones already purchased
 *
 * Returns the (rankKey, rankName, cost) tuples for the still-buyable
 * ones, sorted by display order.
 */
async function unpurchasedEligibleBorders(
  db: import("../../db/index.js").Db,
  userId: string,
  sid: string,
): Promise<Array<{ rankKey: string; rankName: string; cost: number | null }>> {
  const peak = (await db
    .select({
      maxRankKeyEverHeld: userEarning.maxRankKeyEverHeld,
      maxTierEverHeld: userEarning.maxTierEverHeld,
    })
    .from(userEarning)
    .where(and(eq(userEarning.serverId, sid), eq(userEarning.userId, userId)))
    .limit(1))[0];
  if (!peak?.maxRankKeyEverHeld || (peak.maxTierEverHeld ?? 0) < 4) {
    // User has never crossed any Tier IV, no borders eligible.
    // But if they *climbed past* a lower rank's Tier IV (maxRankKey is higher
    // than X), they're implicitly eligible for X's border too. The peak's
    // tier captures only the highest rank's tier; lower ranks were
    // necessarily fully traversed to reach the peak.
    if (peak?.maxRankKeyEverHeld) {
      const peakOrder = await rankOrderOf(db, peak.maxRankKeyEverHeld, sid);
      if (peakOrder !== null) {
        // User climbed past these; all qualify.
        return await listEligibleBordersUpTo(db, userId, peakOrder, /* includePeak */ false, sid);
      }
    }
    return [];
  }
  // Peak holds Tier IV: include all ranks at or below the peak.
  const peakOrder = await rankOrderOf(db, peak.maxRankKeyEverHeld, sid);
  if (peakOrder === null) return [];
  return await listEligibleBordersUpTo(db, userId, peakOrder, /* includePeak */ true, sid);
}

async function rankOrderOf(
  db: import("../../db/index.js").Db,
  rankKey: string,
  sid: string,
): Promise<number | null> {
  // Per-server catalog (migration 0295): read the rank's order from the pool's
  // own server. Flag off ⇒ sid is the default, byte-identical to today.
  const r = (await db
    .select({ order: ranks.order })
    .from(ranks)
    .where(and(eq(ranks.serverId, sid), eq(ranks.key, rankKey)))
    .limit(1))[0];
  return r?.order ?? null;
}

async function listEligibleBordersUpTo(
  db: import("../../db/index.js").Db,
  userId: string,
  peakOrder: number,
  includePeak: boolean,
  sid: string,
): Promise<Array<{ rankKey: string; rankName: string; cost: number | null }>> {
  const cmp = includePeak ? sql`${ranks.order} <= ${peakOrder}` : sql`${ranks.order} < ${peakOrder}`;
  // Per-server catalog (migrations 0295-0296): join on the composite (server_id,
  // key) and pin both tables to the pool's server, so a same-key rank/tier on
  // another server can't match (or multiply rows). Flag off ⇒ sid is the default.
  const rows = await db
    .select({
      rankKey: ranks.key,
      rankName: ranks.name,
      borderCost: rankTiers.borderCost,
      borderImageUrl: rankTiers.borderImageUrl,
      order: ranks.order,
    })
    .from(rankTiers)
    .innerJoin(ranks, and(eq(ranks.serverId, rankTiers.serverId), eq(ranks.key, rankTiers.rankKey)))
    .where(and(
      eq(rankTiers.serverId, sid),
      eq(rankTiers.tier, 4),
      eq(rankTiers.enabled, true),
      eq(ranks.enabled, true),
      cmp,
    ))
    .orderBy(ranks.order);
  // Eligible borders are tier 4 rows that carry a border image + cost.
  const eligible = rows.filter((r) => r.borderImageUrl);
  const owned = new Set(
    (await db
      .select({ rankKey: userOwnedBorders.rankKey })
      .from(userOwnedBorders)
      .where(eq(userOwnedBorders.userId, userId))).map((r) => r.rankKey),
  );
  return eligible
    .filter((r) => !owned.has(r.rankKey))
    .map((r) => ({ rankKey: r.rankKey, rankName: r.rankName, cost: r.borderCost }));
}

export const currencyCommand: CommandHandler = {
  name: "currency",
  aliases: ["cur", "coin", "coins", "wallet"],
  usage: "/currency  |  /currency [user]  |  /currency send [target] [amount]",
  description:
    "Show your Currency balance, look up another user's balance, or send Currency. Output is private to you, never broadcast.",
  subcommands: [
    {
      verb: "(no args)",
      usage: "/currency",
      description: "Show your own master + active-character balance.",
    },
    {
      verb: "<user>",
      usage: "/currency <user>",
      description: "Show a user's master Currency balance (honors their privacy toggle).",
    },
    {
      verb: "send",
      usage: "/currency send <target> <amount>",
      description:
        "Send Currency from your active identity to another user or character. Subject to daily caps, account-age gates, and amount limits configured in the admin panel.",
    },
  ],
  async run(ctx) {
    const args = ctx.argsText.trim();

    // /currency (no args), own balances. Read from the pool on the
    // room's server (flag-off: the room homes to the default server,
    // so this is today's single pool).
    if (!args) {
      const sid = await resolveRoomServerId(ctx.db, ctx.roomId);
      const master = await readUserPool(ctx.db, ctx.user.id, sid);
      const lines = [formatPool(ctx.user.locale, { ...master, scopeLabel: tFor(ctx.user.locale, "commands:earning.masterScope") })];
      if (ctx.user.activeCharacterId) {
        const cRow = (await ctx.db
          .select({ name: characters.name })
          .from(characters)
          .where(eq(characters.id, ctx.user.activeCharacterId))
          .limit(1))[0];
        if (cRow) {
          const charPool = await readCharacterPool(ctx.db, ctx.user.activeCharacterId, cRow.name, sid);
          lines.push(formatPool(ctx.user.locale, { ...charPool, scopeLabel: cRow.name }));
        }
      }
      notice(ctx, "CURRENCY", lines.join("  |  "));
      return;
    }

    // Subcommand: send
    const tokens = args.split(/\s+/);
    if (tokens[0]?.toLowerCase() === "send") {
      const targetName = tokens[1];
      const amountText = tokens[2];
      if (!targetName || !amountText) {
        notice(ctx, "CURRENCY_HELP", tFor(ctx.user.locale, "commands:earning.sendUsage"));
        return;
      }
      const amount = Number.parseInt(amountText, 10);
      if (!Number.isFinite(amount)) {
        notice(ctx, "BAD_AMOUNT", tFor(ctx.user.locale, "commands:earning.badAmount"));
        return;
      }
      const result = await transferCurrency({
        db: ctx.db,
        io: ctx.io,
        senderUserId: ctx.user.id,
        senderCharacterId: ctx.user.activeCharacterId,
        rawTarget: targetName,
        amount,
        locale: ctx.user.locale,
      });
      if (!result.ok) {
        // `did_you_mean` carries a suggestion list we render inline.
        if (result.error.code === "did_you_mean") {
          const suggestions = result.error.suggestions
            .map((s) => tFor(
              ctx.user.locale,
              s.kind === "character" ? "commands:earning.suggestionCharacter" : "commands:earning.suggestionUser",
              { name: s.displayName },
            ))
            .join(", ");
          notice(ctx, "DID_YOU_MEAN", tFor(ctx.user.locale, "commands:earning.didYouMean", {
            message: result.error.message,
            suggestions,
          }));
          return;
        }
        notice(ctx, result.error.code.toUpperCase(), result.error.message);
        return;
      }
      const r = result.result;
      notice(
        ctx,
        "CURRENCY_SENT",
        tFor(ctx.user.locale, "commands:earning.sent", {
          amount: r.amount,
          from: r.source.kind === "character" ? r.source.displayName : tFor(ctx.user.locale, "commands:earning.yourMaster"),
          to: r.target.kind === "character"
            ? tFor(ctx.user.locale, "commands:earning.characterTarget", { name: r.target.displayName })
            : r.target.displayName,
        }),
      );
      return;
    }

    // /currency <target>, view a balance. Accepts @id:/@cid: tokens and bare
    // names; a character target shows THAT character's pool.
    const target = args;
    const resolution = await resolveIdentityArg(ctx.db, target);
    if (resolution.kind === "none") {
      notice(ctx, "NO_USER", tFor(ctx.user.locale, "commands:shared.noUserOrCharacter", { name: target }));
      return;
    }
    if (resolution.kind === "ambiguous") {
      emitAmbiguousIdentityModal(ctx, target, resolution.matches);
      return;
    }
    const t = resolution.target;
    const sid = await resolveRoomServerId(ctx.db, ctx.roomId);
    // Privacy gate is the owner's master setting (covers their character pools).
    const ownerEarning = (await ctx.db
      .select({ currency: userEarning.currency, hideCurrencyCount: userEarning.hideCurrencyCount })
      .from(userEarning)
      .where(and(eq(userEarning.serverId, sid), eq(userEarning.userId, t.userId)))
      .limit(1))[0];
    if (ownerEarning?.hideCurrencyCount && t.userId !== ctx.user.id) {
      notice(ctx, "CURRENCY_PRIVATE", tFor(ctx.user.locale, "commands:earning.currencyPrivate", { name: t.displayName }));
      return;
    }
    let currency: number | undefined;
    if (t.characterId) {
      const ce = (await ctx.db
        .select({ currency: characterEarning.currency })
        .from(characterEarning)
        .where(and(eq(characterEarning.serverId, sid), eq(characterEarning.characterId, t.characterId)))
        .limit(1))[0];
      currency = ce?.currency;
    } else {
      currency = ownerEarning?.currency;
    }
    if (currency === undefined) {
      notice(ctx, "CURRENCY_VIEW", tFor(ctx.user.locale, "commands:earning.noRecord", { name: t.displayName }));
      return;
    }
    notice(ctx, "CURRENCY_VIEW", tFor(ctx.user.locale, "commands:earning.currencyView", { name: t.displayName, currency }));
  },
};

export const expCommand: CommandHandler = {
  name: "exp",
  aliases: ["xp", "rank"],
  usage: "/exp  |  /exp [user]",
  description:
    "Show your XP, Rank, and Tier (master + active character), plus any rank borders you can purchase. Look up another user with /exp <name>. Output is private to you.",
  subcommands: [
    {
      verb: "(no args)",
      usage: "/exp",
      description: "Show your own earning summary and any unlocked-but-unpurchased borders.",
    },
    {
      verb: "<user>",
      usage: "/exp <user>",
      description: "Show a user's master Rank and Tier (always public).",
    },
  ],
  async run(ctx) {
    const args = ctx.argsText.trim();
    if (!args) {
      const sid = await resolveRoomServerId(ctx.db, ctx.roomId);
      const master = await readUserPool(ctx.db, ctx.user.id, sid);
      const lines = [formatPool(ctx.user.locale, { ...master, scopeLabel: tFor(ctx.user.locale, "commands:earning.masterScope") })];
      if (ctx.user.activeCharacterId) {
        const cRow = (await ctx.db
          .select({ name: characters.name })
          .from(characters)
          .where(eq(characters.id, ctx.user.activeCharacterId))
          .limit(1))[0];
        if (cRow) {
          const charPool = await readCharacterPool(ctx.db, ctx.user.activeCharacterId, cRow.name, sid);
          lines.push(formatPool(ctx.user.locale, { ...charPool, scopeLabel: cRow.name }));
        }
      }
      const eligible = await unpurchasedEligibleBorders(ctx.db, ctx.user.id, sid);
      if (eligible.length > 0) {
        const borderList = eligible
          .map((b) => b.cost != null
            ? tFor(ctx.user.locale, "commands:earning.borderWithCost", { name: b.rankName, cost: b.cost })
            : b.rankName)
          .join(", ");
        lines.push(tFor(ctx.user.locale, "commands:earning.borders", { borders: borderList }));
      }
      notice(ctx, "EXP", lines.join("  |  "));
      return;
    }
    // /exp <target>, view a Rank/XP. Accepts @id:/@cid: tokens and bare names;
    // a character target shows THAT character's pool.
    const target = args;
    const resolution = await resolveIdentityArg(ctx.db, target);
    if (resolution.kind === "none") {
      notice(ctx, "NO_USER", tFor(ctx.user.locale, "commands:shared.noUserOrCharacter", { name: target }));
      return;
    }
    if (resolution.kind === "ambiguous") {
      emitAmbiguousIdentityModal(ctx, target, resolution.matches);
      return;
    }
    const t = resolution.target;
    const sid = await resolveRoomServerId(ctx.db, ctx.roomId);
    const pool = t.characterId
      ? await readCharacterPool(ctx.db, t.characterId, t.displayName, sid)
      : await readUserPool(ctx.db, t.userId, sid);
    const rankBit = pool.rankName ? ` · ${pool.rankName} ${pool.tierLabel ?? ""}`.trimEnd() : "";
    notice(ctx, "EXP_VIEW", tFor(ctx.user.locale, "commands:earning.expView", { name: t.displayName, xp: pool.xp, rankBit }));
  },
};
