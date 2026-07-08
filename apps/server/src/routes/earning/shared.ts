/**
 * Earning routes — shared helpers, types, and the sub-registrar
 * dependency bundle.
 *
 * MOVE-ONLY split (Phase 3): these helpers + constants were relocated
 * verbatim out of ./earning.ts so the read (catalog.ts) and write
 * (mutations.ts) sub-registrars can share them without a circular
 * import. `registerEarningRoutes` in ./earning.ts builds an
 * `EarningRouteDeps` and passes it to each sub-registrar; the closures
 * it carries stay in ./earning.ts because they capture `db` / `io`.
 */

import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { getRoomTransition, ROOM_TRANSITIONS, ROOM_TRANSITION_PRICE } from "@thekeep/shared";
import { nanoid } from "nanoid";
import type { Db } from "../../db/index.js";
import type {
  items} from "../../db/schema.js";
import {
  characterEarning,
  rankTiers,
  ranks,
  roomTransitions,
  earningLedger,
  userEarning,
} from "../../db/schema.js";
import type { getSessionUser } from "../auth.js";
import { DEFAULT_SERVER_ID } from "../../earning/pool.js";

export type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/**
 * Per-server EARNING SUBSYSTEM toggles (migration 0293). See
 * resolveSubsystemToggles in ./earning.ts for the resolution rules.
 */
export interface SubsystemToggles {
  /** Items shop (the `items` catalog + /items/:key/buy). */
  shop: boolean;
  /** Ranks / rank tiers ladder. */
  ranks: boolean;
  /** Purchasable name styles. */
  nameStyles: boolean;
  /** Rank-tier borders + freeform borders. */
  borders: boolean;
  /** Room-transition cosmetics. */
  roomTransitions: boolean;
  /** Cosmetics (inline avatar + flairs). */
  cosmetics: boolean;
}

/**
 * Dependency bundle handed to each earning sub-registrar. Carries the
 * Fastify instance, db, io, and the three closures that capture db/io
 * (kept in ./earning.ts so their signatures stay byte-identical).
 */
export interface EarningRouteDeps {
  app: FastifyInstance;
  db: Db;
  io: Io;
  rebroadcastPresenceForUser: (userId: string) => Promise<void>;
  resolveActiveServerId: (
    me: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>,
    requestedServerId: string | undefined,
  ) => Promise<string>;
  resolveSubsystemToggles: (sid: string) => Promise<SubsystemToggles>;
}

// === MOVED HELPERS (verbatim from earning.ts, `export` added) ===

export const LEDGER_PAGE_LIMIT = 50;

export const patchSettingsBody = z.object({
  hideCurrencyCount: z.boolean().optional(),
  hideXpCount: z.boolean().optional(),
  selectedBorderRankKey: z.string().nullable().optional(),
  /**
   * Equip slot for a FREE-FORM border (migration 0149). Independent
   * of `selectedBorderRankKey`, both columns can be set; the
   * renderer prefers freeform when present. Set null to drop the
   * freeform slot back to the rank-tier fallback.
   */
  selectedFreeformBorderKey: z.string().nullable().optional(),
  /**
   * Per-identity scope for `selectedBorderRankKey` /
   * `selectedFreeformBorderKey`. Null/omitted writes the master's
   * user_earning row; a character id writes that character's
   * character_earning row. Ownership of the border is checked
   * against the same scope's ownership table.
   */
  characterId: z.string().nullable().optional(),
}).strict();

export const ackBody = z.object({
  notificationId: z.string().min(1).optional(),
}).strict();

export interface PoolView {
  scope: "user" | "character";
  ownerId: string;
  displayName: string;
  xp: number;
  currency: number;
  rankKey: string | null;
  tier: number | null;
  rankName: string | null;
  tierLabel: string | null;
  sigilImageUrl: string | null;
  maxRankKeyEverHeld: string | null;
  maxTierEverHeld: number | null;
  selectedBorderRankKey: string | null;
  /** Freeform border equip slot, independent of the rank-tier slot.
   *  Resolution precedence (BorderedAvatar): freeform first, rank
   *  border as fallback. Null means no freeform border equipped. */
  selectedFreeformBorderKey: string | null;
  /** Only emitted on master pool, character pools cascade off this flag. */
  hideCurrencyCount?: boolean;
  /** Only emitted on master pool. Mirrors hideCurrencyCount for XP. */
  hideXpCount?: boolean;
}

export async function loadRankTierLookup(
  db: Db,
  /** Per-server economy partition (migrations 0295-0299): ranks / rank_tiers
   *  now have (server_id, key) PKs, so reading them without a server filter
   *  would collapse every server's ladder into one ambiguous map. Defaults to
   *  the default server so the existing single-server callers (public profile
   *  slice) read today's Spire ladder with the flag off. */
  serverId: string = DEFAULT_SERVER_ID,
) {
  const rankRows = await db.select().from(ranks).where(eq(ranks.serverId, serverId)).orderBy(asc(ranks.order)).all();
  const tierRows = await db.select().from(rankTiers).where(eq(rankTiers.serverId, serverId)).orderBy(asc(rankTiers.tier)).all();
  const rankByKey = new Map(rankRows.map((r) => [r.key, r]));
  const tierByKey = new Map<string, typeof tierRows[number]>();
  for (const t of tierRows) tierByKey.set(`${t.rankKey}:${t.tier}`, t);
  return { rankRows, tierRows, rankByKey, tierByKey };
}

export interface TransitionCatalogRow {
  key: string;
  label: string;
  description: string;
  cost: number;
  enabled: boolean;
  order: number;
}

/**
 * Per-server room-transition catalog (migrations 0295-0299).
 *
 * The shared ROOM_TRANSITIONS const owns the copy (label + description) and
 * the canonical key list; the `room_transitions` table owns the per-server
 * tunables (cost / enabled / sort_order). We merge them: every const key is
 * surfaced, with cost/enabled/order COALESCED from the server's row when one
 * exists and falling back to the const default (ROOM_TRANSITION_PRICE,
 * enabled, const display order) when the server hasn't seeded a row. Sorted by
 * the effective order so a server can re-rank its shop without a code change.
 */
export async function buildTransitionCatalog(db: Db, serverId: string): Promise<TransitionCatalogRow[]> {
  const rows = await db
    .select()
    .from(roomTransitions)
    .where(eq(roomTransitions.serverId, serverId))
    .all();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return ROOM_TRANSITIONS.map((t, idx) => {
    const row = byKey.get(t.key);
    return {
      key: t.key,
      label: t.label,
      description: t.description,
      cost: row?.cost ?? ROOM_TRANSITION_PRICE,
      enabled: row ? row.enabled : true,
      order: row?.sortOrder ?? idx,
    };
  }).sort((a, b) => a.order - b.order);
}

/**
 * Resolve a single transition's effective price + sellability on a server,
 * for the purchase/equip gates. Same COALESCE rule as buildTransitionCatalog:
 * the server's `room_transitions` row wins, else the const default applies.
 * Returns null when the key isn't a known transition at all.
 */
export async function resolveTransitionForServer(
  db: Db,
  serverId: string,
  key: string,
): Promise<{ key: string; label: string; cost: number; enabled: boolean } | null> {
  const base = getRoomTransition(key);
  if (!base) return null;
  const row = (await db
    .select()
    .from(roomTransitions)
    .where(and(eq(roomTransitions.serverId, serverId), eq(roomTransitions.key, key)))
    .limit(1))[0];
  return {
    key: base.key,
    label: base.label,
    cost: row?.cost ?? ROOM_TRANSITION_PRICE,
    enabled: row ? row.enabled : true,
  };
}

export async function buildUserPoolView(
  db: Db,
  userId: string,
  username: string,
  rankByKey: Map<string, typeof ranks.$inferSelect>,
  tierByKey: Map<string, typeof rankTiers.$inferSelect>,
  /** Per-server economy partition. Defaults to the default server so the
   *  existing callers read today's single pool with the flag off. */
  serverId: string = DEFAULT_SERVER_ID,
): Promise<PoolView | null> {
  const row = (await db
    .select()
    .from(userEarning)
    .where(and(eq(userEarning.serverId, serverId), eq(userEarning.userId, userId)))
    .limit(1))[0];
  if (!row) {
    // Lazy-create equivalent: return a synthesized zero view so the
    // dashboard renders sensibly without a write. Earnings will create
    // the row on first credit.
    return {
      scope: "user",
      ownerId: userId,
      displayName: username,
      xp: 0,
      currency: 0,
      rankKey: null,
      tier: null,
      rankName: null,
      tierLabel: null,
      sigilImageUrl: null,
      maxRankKeyEverHeld: null,
      maxTierEverHeld: null,
      selectedBorderRankKey: null,
      selectedFreeformBorderKey: null,
      hideCurrencyCount: false,
      hideXpCount: false,
    };
  }
  const rankName = row.rankKey ? rankByKey.get(row.rankKey)?.name ?? null : null;
  const tier = row.tier != null && row.rankKey ? tierByKey.get(`${row.rankKey}:${row.tier}`) : undefined;
  return {
    scope: "user",
    ownerId: userId,
    displayName: username,
    xp: row.xp,
    currency: row.currency,
    rankKey: row.rankKey,
    tier: row.tier,
    rankName,
    tierLabel: tier?.label ?? null,
    sigilImageUrl: tier?.sigilImageUrl ?? null,
    maxRankKeyEverHeld: row.maxRankKeyEverHeld,
    maxTierEverHeld: row.maxTierEverHeld,
    selectedBorderRankKey: row.selectedBorderRankKey,
    selectedFreeformBorderKey: row.selectedFreeformBorderKey,
    hideCurrencyCount: row.hideCurrencyCount,
    hideXpCount: row.hideXpCount,
  };
}

export async function buildCharacterPoolView(
  db: Db,
  characterId: string,
  characterName: string,
  rankByKey: Map<string, typeof ranks.$inferSelect>,
  tierByKey: Map<string, typeof rankTiers.$inferSelect>,
  /** Per-server economy partition. Defaults to the default server so the
   *  existing callers read today's single pool with the flag off. */
  serverId: string = DEFAULT_SERVER_ID,
): Promise<PoolView | null> {
  const row = (await db
    .select()
    .from(characterEarning)
    .where(and(eq(characterEarning.serverId, serverId), eq(characterEarning.characterId, characterId)))
    .limit(1))[0];
  if (!row) {
    return {
      scope: "character",
      ownerId: characterId,
      displayName: characterName,
      xp: 0,
      currency: 0,
      rankKey: null,
      tier: null,
      rankName: null,
      tierLabel: null,
      sigilImageUrl: null,
      maxRankKeyEverHeld: null,
      maxTierEverHeld: null,
      selectedBorderRankKey: null,
      selectedFreeformBorderKey: null,
    };
  }
  const rankName = row.rankKey ? rankByKey.get(row.rankKey)?.name ?? null : null;
  const tier = row.tier != null && row.rankKey ? tierByKey.get(`${row.rankKey}:${row.tier}`) : undefined;
  return {
    scope: "character",
    ownerId: characterId,
    displayName: characterName,
    xp: row.xp,
    currency: row.currency,
    rankKey: row.rankKey,
    tier: row.tier,
    rankName,
    tierLabel: tier?.label ?? null,
    sigilImageUrl: tier?.sigilImageUrl ?? null,
    maxRankKeyEverHeld: row.maxRankKeyEverHeld,
    maxTierEverHeld: row.maxTierEverHeld,
    selectedBorderRankKey: row.selectedBorderRankKey,
    selectedFreeformBorderKey: row.selectedFreeformBorderKey,
  };
}

export function safeParse(json: string): unknown {
  try { return JSON.parse(json); } catch { return null; }
}

/**
 * Parse an item's per-command message JSON, returning an empty array
 * on any failure (malformed JSON or non-array shape). Used by both
 * the catalog payload (to advertise which commands an item supports)
 * and by the command handlers (to pick a random template). A robust
 * empty-array fallback ensures a single corrupt row can't break the
 * whole catalog fetch.
 */
export function parseItemMessages(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch {
    return [];
  }
}

/**
 * Reshape an `items` row for the `/earning/me` catalog payload.
 * Computes the derived `purchasable` boolean from the layered
 * enabled / forSale / sale-window switches so the client doesn't
 * reimplement the rule. `availableCommands` lists which of
 * give/throw/drop have non-empty message arrays, the dashboard +
 * command help use it to show which commands work on the item.
 */
export function shapeItemCatalogRow(row: typeof items.$inferSelect, nowMs: number) {
  const give = parseItemMessages(row.giveMessagesJson);
  const throwMsgs = parseItemMessages(row.throwMessagesJson);
  const drop = parseItemMessages(row.dropMessagesJson);
  const starts = row.saleStartsAt ? +row.saleStartsAt : null;
  const ends = row.saleEndsAt ? +row.saleEndsAt : null;
  const inWindow =
    (starts === null || nowMs >= starts) &&
    (ends === null || nowMs < ends);
  return {
    key: row.key,
    name: row.name,
    namePlural: row.namePlural,
    description: row.description,
    iconUrl: row.iconUrl,
    price: row.price,
    stackLimit: row.stackLimit,
    enabled: !!row.enabled,
    forSale: !!row.forSale,
    saleStartsAt: starts,
    saleEndsAt: ends,
    order: row.order,
    isBuiltin: !!row.isBuiltin,
    /** Shop bucket. Drives the dashboard's category filter and the
     *  pin-collection routing (pets → identity_pet_collection,
     *  everything else → identity_collection). */
    category: row.category,
    /** Derived: enabled && forSale && now ∈ [saleStartsAt, saleEndsAt). */
    purchasable: !!row.enabled && !!row.forSale && inWindow,
    /** Which commands this item supports (non-empty templates). */
    availableCommands: {
      give: give.length > 0,
      throw: throwMsgs.length > 0,
      drop: drop.length > 0,
    },
  };
}

/**
 * Bucket character-owned rows into a `{ [characterId]: T[] }` map.
 * Used by `/earning/me` to ship per-character ownership lists in
 * one round trip, the dashboard reads the map indexed by the
 * currently-active character id, falling back to the master fields
 * when no character is active.
 */
export function groupByCharacter<R, T>(
  rows: readonly R[],
  shape: (r: R) => T,
): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const r of rows) {
    const cid = (r as { characterId: string }).characterId;
    const list = out[cid] ?? (out[cid] = []);
    list.push(shape(r));
  }
  return out;
}

/** Outcome returned by `runPurchaseTxn`. */
export type PurchaseOutcome =
  | {
      ok: true;
      status?: undefined;
      error?: undefined;
      required?: undefined;
      balance?: undefined;
      cost: number;
      final: { xp: number; currency: number; rankKey: string | null; tier: number | null };
    }
  | {
      ok: false;
      status: number;
      error: string;
      required?: number;
      balance?: number;
      cost?: undefined;
      final?: undefined;
    };

/**
 * Single source of truth for the transactional purchase pattern.
 *
 * Wraps the funds-check → ownership-insert → currency-debit →
 * ledger-insert sequence in a single sqlite transaction so two
 * concurrent purchases by the same user can't race. Caller supplies:
 *
 *   - `validate(tx)`: per-purchase gates (style/cosmetic enabled,
 *     border eligibility, already-owned check). Returns `{ok: true,
 *     cost}` to proceed or `{ok: false, status, error}` to abort.
 *
 *   - `grant(tx)`: the ownership insert specific to the purchase
 *     (insert into user_owned_name_styles, user_owned_borders, etc.).
 *     Runs after the funds check inside the same transaction.
 *
 * Returns the post-commit earning snapshot so the caller can emit
 * the wallet-update socket event with accurate xp/currency/rank.
 */
export function runPurchaseTxn(
  db: Db,
  userId: string,
  opts: {
    validate: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) =>
      | { ok: true; cost: number }
      | { ok: false; status: number; error: string };
    grant: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => void;
    reason: string;
    metadata: Record<string, unknown>;
    /**
     * Optional character scope. When set, the transaction debits the
     * character's currency pool (`character_earning`) and tags the
     * ledger row with scope='character'. The caller is responsible
     * for validating that the character belongs to `userId` BEFORE
     * calling, this helper just routes the pool. When null/omitted
     * the original master-pool behavior runs.
     */
    characterId?: string | null;
    /**
     * Per-server economy partition the purchase debits + the ownership ledger
     * row land on. Defaults to the default (active) server; with the servers
     * flag off it's the only pool, so the debit + grant are byte-identical to
     * today. (Callers pass the crediting room's serverId once the UI is
     * per-server in a later pass.)
     */
    serverId?: string;
  },
): PurchaseOutcome {
  const serverId = opts.serverId ?? DEFAULT_SERVER_ID;
  return db.transaction((tx): PurchaseOutcome => {
    const v = opts.validate(tx);
    if (!v.ok) return { ok: false, status: v.status, error: v.error };
    const charId = opts.characterId ?? null;
    if (charId) {
      // Character pool debit. Lazily ensures a character_earning row
      // exists so brand-new characters can still purchase. The
      // ledger row uses scope='character' + ownerId=characterId so
      // the audit trail attributes the spend to the right identity.
      tx.insert(characterEarning).values({ serverId, characterId: charId }).onConflictDoNothing().run();
      const earning = tx.select().from(characterEarning).where(and(eq(characterEarning.serverId, serverId), eq(characterEarning.characterId, charId))).limit(1).all()[0];
      const balance = earning?.currency ?? 0;
      if (balance < v.cost) {
        return { ok: false, status: 402, error: "insufficient funds", required: v.cost, balance };
      }
      opts.grant(tx);
      const newCurrency = balance - v.cost;
      tx.update(characterEarning).set({
        currency: newCurrency,
        updatedAt: new Date(),
      }).where(and(eq(characterEarning.serverId, serverId), eq(characterEarning.characterId, charId))).run();
      tx.insert(earningLedger).values({
        id: nanoid(),
        serverId,
        scope: "character",
        ownerId: charId,
        xpDelta: 0,
        currencyDelta: -v.cost,
        reason: opts.reason,
        metadataJson: JSON.stringify({ ...opts.metadata, cost: v.cost, characterId: charId }),
      }).run();
      return {
        ok: true,
        cost: v.cost,
        final: {
          xp: earning?.xp ?? 0,
          currency: newCurrency,
          rankKey: earning?.rankKey ?? null,
          tier: earning?.tier ?? null,
        },
      };
    }
    // Master pool path, unchanged from the original behavior.
    tx.insert(userEarning).values({ serverId, userId }).onConflictDoNothing().run();
    const earning = tx.select().from(userEarning).where(and(eq(userEarning.serverId, serverId), eq(userEarning.userId, userId))).limit(1).all()[0];
    const balance = earning?.currency ?? 0;
    if (balance < v.cost) {
      return { ok: false, status: 402, error: "insufficient funds", required: v.cost, balance };
    }
    opts.grant(tx);
    const newCurrency = balance - v.cost;
    tx.update(userEarning).set({
      currency: newCurrency,
      updatedAt: new Date(),
    }).where(and(eq(userEarning.serverId, serverId), eq(userEarning.userId, userId))).run();
    tx.insert(earningLedger).values({
      id: nanoid(),
      serverId,
      scope: "user",
      ownerId: userId,
      xpDelta: 0,
      currencyDelta: -v.cost,
      reason: opts.reason,
      metadataJson: JSON.stringify({ ...opts.metadata, cost: v.cost }),
    }).run();
    return {
      ok: true,
      cost: v.cost,
      final: {
        xp: earning?.xp ?? 0,
        currency: newCurrency,
        rankKey: earning?.rankKey ?? null,
        tier: earning?.tier ?? null,
      },
    };
  });
}

/**
 * Emit `earning:earned` to every live socket of the recipient user.
 * Used by the post-commit step of the transactional purchase helpers
 *, the engine's own creditPool path emits this internally, so route
 * handlers that bypass creditPool (because they did their own
 * transactional debit) call this helper to keep the wire shape
 * consistent.
 */
export async function emitWalletUpdate(
  io: Io,
  userId: string,
  final: { xp: number; currency: number; rankKey: string | null; tier: number | null },
  currencyDelta: number,
  reason: string,
  /** Scope of the wallet that was debited. When `scope` is "character"
   *  the `ownerId` on the wire is the character id (not the user id);
   *  the master-pool path keeps the existing user-scope wire shape. */
  scope: { scope: "user"; ownerId?: undefined } | { scope: "character"; ownerId: string } = { scope: "user" },
): Promise<void> {
  const sockets = await io.fetchSockets();
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid !== userId) continue;
    s.emit("earning:earned", {
      scope: scope.scope,
      ownerId: scope.scope === "character" ? scope.ownerId : userId,
      xpDelta: 0,
      currencyDelta,
      xpTotal: final.xp,
      currencyTotal: final.currency,
      rankKey: final.rankKey,
      tier: final.tier,
      reason,
    });
  }
}
