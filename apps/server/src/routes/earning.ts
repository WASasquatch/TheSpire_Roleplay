/**
 * Earning — public + self routes.
 *
 * - `GET /earning/me` returns the caller's wallet + active-character
 *   earning + unacknowledged rank-up notifications + the catalog
 *   slice the dashboard needs (ranks, tiers, name styles, cosmetics).
 *
 * - `GET /earning/users/:id` returns the public slice — rank/tier
 *   and currency (currency hidden when the target has
 *   `hideCurrencyCount = 1`).
 *
 * - `GET /earning/me/ledger` is the paginated activity history.
 *
 * - `PATCH /earning/me/settings` toggles the Currency privacy flag.
 *
 * - `GET /earning/me/notifications` and `POST .../rankup/ack` back
 *   the rank-up ribbon.
 *
 * Admin endpoints live in admin/earning.ts so the admin auth gate
 * already applies.
 */

import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;
import { nanoid } from "nanoid";
import {
  characterEarning,
  characterOwnedBorders,
  characterOwnedNameStyles,
  characters,
  cosmetics,
  identityCollection,
  identityInventory,
  identityPetCollection,
  items,
  nameStyles,
  rankTiers,
  ranks,
  earningLedger,
  userActiveCosmetics,
  userOwnedBorders,
  userOwnedNameStyles,
  userEarning,
  users,
} from "../db/schema.js";
import { getSessionUser } from "./auth.js";
import {
  ack as ackNotification,
  ackAllForUser,
  listUnacknowledged,
} from "../earning/notifications.js";
// creditPool is no longer called directly here — purchase endpoints
// run their own sqlite transaction (see `runPurchaseTxn` below) for
// atomicity. The award engine still imports it for the live earn
// paths (chat / forum / presence).

const LEDGER_PAGE_LIMIT = 50;

const patchSettingsBody = z.object({
  hideCurrencyCount: z.boolean().optional(),
  hideXpCount: z.boolean().optional(),
  selectedBorderRankKey: z.string().nullable().optional(),
  /**
   * Per-identity scope for `selectedBorderRankKey`. Null/omitted
   * writes the master's user_earning row; a character id writes
   * that character's character_earning row. Ownership of the
   * border is checked against the same scope's ownership table.
   */
  characterId: z.string().nullable().optional(),
}).strict();

const ackBody = z.object({
  notificationId: z.string().min(1).optional(),
}).strict();

interface PoolView {
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
  /** Only emitted on master pool — character pools cascade off this flag. */
  hideCurrencyCount?: boolean;
  /** Only emitted on master pool. Mirrors hideCurrencyCount for XP. */
  hideXpCount?: boolean;
}

async function loadRankTierLookup(db: Db) {
  const rankRows = await db.select().from(ranks).orderBy(asc(ranks.order)).all();
  const tierRows = await db.select().from(rankTiers).orderBy(asc(rankTiers.tier)).all();
  const rankByKey = new Map(rankRows.map((r) => [r.key, r]));
  const tierByKey = new Map<string, typeof tierRows[number]>();
  for (const t of tierRows) tierByKey.set(`${t.rankKey}:${t.tier}`, t);
  return { rankRows, tierRows, rankByKey, tierByKey };
}

async function buildUserPoolView(
  db: Db,
  userId: string,
  username: string,
  rankByKey: Map<string, typeof ranks.$inferSelect>,
  tierByKey: Map<string, typeof rankTiers.$inferSelect>,
): Promise<PoolView | null> {
  const row = (await db
    .select()
    .from(userEarning)
    .where(eq(userEarning.userId, userId))
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
    hideCurrencyCount: row.hideCurrencyCount,
    hideXpCount: row.hideXpCount,
  };
}

async function buildCharacterPoolView(
  db: Db,
  characterId: string,
  characterName: string,
  rankByKey: Map<string, typeof ranks.$inferSelect>,
  tierByKey: Map<string, typeof rankTiers.$inferSelect>,
): Promise<PoolView | null> {
  const row = (await db
    .select()
    .from(characterEarning)
    .where(eq(characterEarning.characterId, characterId))
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
  };
}

export async function registerEarningRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /**
   * Re-broadcast occupant presence in every room the user has a live
   * socket in. Called after any change that affects how the user's
   * name renders to peers (name-style equip, border equip, inline-
   * avatar toggle, name-style color config) — those cosmetics ride
   * the occupant cache, not the message wire, so without a presence
   * refresh other tabs / peers don't see the change until something
   * else triggers a broadcast (a join, a /char switch). Mirrors the
   * pattern in /me/profile (apps/server/src/routes/characters.ts:741).
   */
  async function rebroadcastPresenceForUser(userId: string): Promise<void> {
    const sockets = await io.fetchSockets();
    const rooms = new Set<string>();
    for (const s of sockets) {
      if ((s.data as { userId?: string }).userId !== userId) continue;
      for (const r of s.rooms) if (r.startsWith("room:")) rooms.add(r.slice(5));
    }
    if (rooms.size === 0) return;
    const { broadcastPresence } = await import("../realtime/broadcast.js");
    for (const roomId of rooms) await broadcastPresence(io, db, roomId);
  }


  /**
   * Full earning snapshot for the caller. Drives the Earning
   * dashboard wallet + ledger sections + the catalog + own
   * notifications. Cacheable on the catalog slice (everyone sees the
   * same catalog) — the wallet/ledger slices are per-user.
   */
  app.get("/earning/me", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    const { rankRows, tierRows, rankByKey, tierByKey } = await loadRankTierLookup(db);

    const master = await buildUserPoolView(db, me.id, me.username, rankByKey, tierByKey);

    // Every character of the user (active or not) with a non-zero
    // earning row. We include zero-XP characters too if they have a
    // row at all, so the dashboard can show characters the user has
    // started but not yet earned on. Cap at 50 just to bound payload
    // — a user with 100 characters is an edge case worth bounding.
    const charsOfMine = await db
      .select({ id: characters.id, name: characters.name })
      .from(characters)
      .where(and(eq(characters.userId, me.id), sql`${characters.deletedAt} IS NULL`))
      .limit(50);
    const characterViews: PoolView[] = [];
    for (const c of charsOfMine) {
      const v = await buildCharacterPoolView(db, c.id, c.name, rankByKey, tierByKey);
      if (v) characterViews.push(v);
    }

    // Owned cosmetics + currently-equipped state. Per-identity:
    // master rows from user_owned_*, character rows from
    // character_owned_*. Each set is independent — a master who
    // bought Embers does NOT make their character own it, and vice
    // versa.
    const ownedStyleRows = await db
      .select()
      .from(userOwnedNameStyles)
      .where(eq(userOwnedNameStyles.userId, me.id));
    const ownedBorderRows = await db
      .select()
      .from(userOwnedBorders)
      .where(eq(userOwnedBorders.userId, me.id));
    const charIdsForOwnership = charsOfMine.map((c) => c.id);
    const charOwnedStyleRows = charIdsForOwnership.length
      ? await db
          .select()
          .from(characterOwnedNameStyles)
          .where(inArray(characterOwnedNameStyles.characterId, charIdsForOwnership))
      : [];
    const charOwnedBorderRows = charIdsForOwnership.length
      ? await db
          .select()
          .from(characterOwnedBorders)
          .where(inArray(characterOwnedBorders.characterId, charIdsForOwnership))
      : [];
    const activeCosmeticsRow = (await db
      .select()
      .from(userActiveCosmetics)
      .where(eq(userActiveCosmetics.userId, me.id))
      .limit(1))[0];
    // Per-character active cosmetics. Pulled from the same
    // character_earning rows the pool view already touches, but
    // restricted to the two cosmetic columns added in migration
    // 0085. Empty when the user has no characters or none with a
    // character_earning row yet.
    const charIds = charsOfMine.map((c) => c.id);
    const characterCosmeticRows = charIds.length
      ? await db
          .select({
            characterId: characterEarning.characterId,
            activeNameStyleKey: characterEarning.activeNameStyleKey,
            inlineAvatarEnabled: characterEarning.inlineAvatarEnabled,
          })
          .from(characterEarning)
          .where(inArray(characterEarning.characterId, charIds))
      : [];
    // Bundle every ENABLED name style on this response so the client
    // can inject the CSS + template lookup map once on app load
    // without a separate /earning/catalog fetch. Disabled rows are
    // omitted so the dashboard's Available list stays in sync with
    // what users can actually equip. Built-in rows ship with the
    // catalog regardless of `enabled` (admin can disable a seed
    // style temporarily) — `enabled: false` filters them out from
    // both the rendering map and the buy list, which is what we
    // want.
    const styleRows = await db
      .select()
      .from(nameStyles)
      .where(eq(nameStyles.enabled, true))
      .orderBy(asc(nameStyles.order));

    // Items catalog. We ship ALL items (enabled or not) so the
    // inventory view can still resolve display data for items the
    // admin disabled after a user acquired them. The client filters
    // the Shop view down to `purchasable=true`. Payload is small —
    // typically <50 rows.
    const itemRows = await db
      .select()
      .from(items)
      .orderBy(asc(items.order));
    const nowMs = Date.now();
    const itemCatalog = itemRows.map((r) => shapeItemCatalogRow(r, nowMs));

    // Per-identity inventory. Master rows scope='user', character
    // rows scope='character'. Pulled in one query and partitioned
    // client-side into master/byCharacter shapes mirroring the
    // owned-styles / owned-borders payload structure.
    const charIdSet = new Set(charsOfMine.map((c) => c.id));
    const inventoryRows = await db
      .select()
      .from(identityInventory)
      .where(sql`(${identityInventory.ownerScope} = 'user' AND ${identityInventory.ownerId} = ${me.id})
        OR (${identityInventory.ownerScope} = 'character' AND ${identityInventory.ownerId} IN (${
        // Empty IN () is invalid SQL — guard with a sentinel that
        // can't match any real character id when the user has none.
        charIdSet.size > 0
          ? sql.join(Array.from(charIdSet).map((id) => sql`${id}`), sql`, `)
          : sql`''`
      }))`);
    const inventoryMaster: { itemKey: string; quantity: number; acquiredAt: number }[] = [];
    const inventoryByCharacter: Record<string, { itemKey: string; quantity: number; acquiredAt: number }[]> = {};
    for (const row of inventoryRows) {
      const shaped = { itemKey: row.itemKey, quantity: row.quantity, acquiredAt: +row.acquiredAt };
      if (row.ownerScope === "user" && row.ownerId === me.id) {
        inventoryMaster.push(shaped);
      } else if (row.ownerScope === "character" && charIdSet.has(row.ownerId)) {
        (inventoryByCharacter[row.ownerId] ??= []).push(shaped);
      }
    }

    // Per-identity Collection — 10-slot pinned showcase keyed by
    // (ownerScope, ownerId). Same partitioning as inventory; each
    // identity's pins are independent. The client renders sparse
    // slot maps directly, so we ship the rows as-is rather than
    // normalizing to a length-10 array.
    const collectionRows = await db
      .select()
      .from(identityCollection)
      .where(sql`(${identityCollection.ownerScope} = 'user' AND ${identityCollection.ownerId} = ${me.id})
        OR (${identityCollection.ownerScope} = 'character' AND ${identityCollection.ownerId} IN (${
        charIdSet.size > 0
          ? sql.join(Array.from(charIdSet).map((id) => sql`${id}`), sql`, `)
          : sql`''`
      }))`);
    const collectionMaster: { slot: number; itemKey: string }[] = [];
    const collectionByCharacter: Record<string, { slot: number; itemKey: string }[]> = {};
    for (const row of collectionRows) {
      const shaped = { slot: row.slot, itemKey: row.itemKey };
      if (row.ownerScope === "user" && row.ownerId === me.id) {
        collectionMaster.push(shaped);
      } else if (row.ownerScope === "character" && charIdSet.has(row.ownerId)) {
        (collectionByCharacter[row.ownerId] ??= []).push(shaped);
      }
    }

    // Pet Collection — separate 5-slot table for items with
    // category='pet'. Same partition structure; client renders these
    // under a distinct "Pets" sub-view in the Items tab and as a
    // distinct section on the profile.
    const petCollectionRows = await db
      .select()
      .from(identityPetCollection)
      .where(sql`(${identityPetCollection.ownerScope} = 'user' AND ${identityPetCollection.ownerId} = ${me.id})
        OR (${identityPetCollection.ownerScope} = 'character' AND ${identityPetCollection.ownerId} IN (${
        charIdSet.size > 0
          ? sql.join(Array.from(charIdSet).map((id) => sql`${id}`), sql`, `)
          : sql`''`
      }))`);
    const petCollectionMaster: { slot: number; itemKey: string }[] = [];
    const petCollectionByCharacter: Record<string, { slot: number; itemKey: string }[]> = {};
    for (const row of petCollectionRows) {
      const shaped = { slot: row.slot, itemKey: row.itemKey };
      if (row.ownerScope === "user" && row.ownerId === me.id) {
        petCollectionMaster.push(shaped);
      } else if (row.ownerScope === "character" && charIdSet.has(row.ownerId)) {
        (petCollectionByCharacter[row.ownerId] ??= []).push(shaped);
      }
    }

    // Unacknowledged rank-up notifications power the chat ribbon.
    const unack = await listUnacknowledged(db, me.id);

    return {
      master,
      characters: characterViews,
      catalog: {
        ranks: rankRows.map((r) => ({
          key: r.key,
          name: r.name,
          order: r.order,
          enabled: !!r.enabled,
        })),
        rankTiers: tierRows.map((t) => ({
          id: t.id,
          rankKey: t.rankKey,
          tier: t.tier,
          label: t.label,
          xpThreshold: t.xpThreshold,
          sigilImageUrl: t.sigilImageUrl,
          borderImageUrl: t.borderImageUrl,
          borderCost: t.borderCost,
          enabled: !!t.enabled,
        })),
        nameStyles: styleRows.map((r) => ({
          key: r.key,
          name: r.name,
          description: r.description,
          template: r.template,
          styleCss: r.styleCss,
          cost: r.cost,
          isBuiltin: !!r.isBuiltin,
          order: r.order,
        })),
        items: itemCatalog,
      },
      // Master-only owned lists (unchanged shape for back-compat).
      ownedStyles: ownedStyleRows.map((r) => ({
        styleKey: r.styleKey,
        configJson: r.configJson,
        acquiredAt: +r.acquiredAt,
      })),
      ownedBorders: ownedBorderRows.map((r) => ({
        rankKey: r.rankKey,
        acquiredAt: +r.acquiredAt,
      })),
      // Per-character owned lists, keyed by character id. Each entry
      // mirrors the master shape. Empty maps when the character
      // hasn't purchased anything from their own pool yet.
      ownedStylesByCharacter: groupByCharacter(charOwnedStyleRows, (r) => ({
        styleKey: r.styleKey,
        configJson: r.configJson,
        acquiredAt: +r.acquiredAt,
      })),
      ownedBordersByCharacter: groupByCharacter(charOwnedBorderRows, (r) => ({
        rankKey: r.rankKey,
        acquiredAt: +r.acquiredAt,
      })),
      // Per-identity inventory. `inventory` is the master/OOC pool;
      // `inventoryByCharacter[characterId]` is the character pool.
      // Every identity is fully isolated — moving items across them
      // requires `/give` between two of the user's own identities, the
      // only legal cross-partition transfer.
      inventory: inventoryMaster,
      inventoryByCharacter,
      // Per-identity Collection pins (10-slot showcase) — same
      // partition rules as inventory. Slots are sparse; each entry
      // carries `slot` (0..9) + `itemKey`. Items pinned here have
      // category != 'pet'; pets live in `petCollection`.
      collection: collectionMaster,
      collectionByCharacter,
      // Per-identity Pet Collection pins (5-slot showcase). Same
      // partition rules. Only items with `category='pet'` are
      // pinnable here — the PUT endpoint validates and rejects
      // mismatches with a 403.
      petCollection: petCollectionMaster,
      petCollectionByCharacter,
      activeCosmetics: {
        // Master / OOC slot. Same shape as before — the existing
        // dashboard reads these two fields directly for the master
        // identity tab.
        inlineAvatarEnabled: !!activeCosmeticsRow?.inlineAvatarEnabled,
        activeNameStyleKey: activeCosmeticsRow?.activeNameStyleKey ?? null,
        // Per-character slots, keyed by character id. Each entry
        // mirrors the master shape. Characters without an earning
        // row get null/false defaults so the client can read them
        // unconditionally.
        byCharacter: Object.fromEntries(
          characterCosmeticRows.map((r) => [
            r.characterId,
            {
              activeNameStyleKey: r.activeNameStyleKey,
              inlineAvatarEnabled: !!r.inlineAvatarEnabled,
            },
          ]),
        ),
      },
      notifications: unack,
    };
  });

  /**
   * Public slice of a user's earning. Other endpoints (profile,
   * userlist) can call this when they need an authoritative
   * rank/tier/sigil + currency-when-public.
   */
  app.get<{ Params: { id: string } }>("/earning/users/:id", async (req, reply) => {
    const target = (await db
      .select({ id: users.id, username: users.username, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, req.params.id))
      .limit(1))[0];
    if (!target || target.disabledAt) { reply.code(404); return { error: "not found" }; }
    const me = await getSessionUser(req, db);

    const { rankByKey, tierByKey } = await loadRankTierLookup(db);
    const view = await buildUserPoolView(db, target.id, target.username, rankByKey, tierByKey);
    if (!view) { reply.code(404); return { error: "no earning" }; }

    const isSelf = me?.id === target.id;
    const showCurrency = !view.hideCurrencyCount || isSelf;
    const showXp = !view.hideXpCount || isSelf;
    return {
      userId: target.id,
      username: target.username,
      // Both XP and Currency honor independent privacy flags. Rank +
      // tier + sigil stay public regardless — rank is the user's
      // public identity tag.
      xp: showXp ? view.xp : null,
      currency: showCurrency ? view.currency : null,
      rankKey: view.rankKey,
      tier: view.tier,
      rankName: view.rankName,
      tierLabel: view.tierLabel,
      sigilImageUrl: view.sigilImageUrl,
      selectedBorderRankKey: view.selectedBorderRankKey,
    };
  });

  /**
   * Cursor-based paginated ledger. Cursor is the createdAt epoch ms
   * of the last item in the previous page; we walk back from there.
   * Limited to LEDGER_PAGE_LIMIT per page.
   *
   * Scope filter: by default returns master-pool entries; pass
   * `?scope=character&characterId=X` to fetch a specific character's
   * ledger (caller must own the character).
   */
  app.get<{ Querystring: { cursor?: string; limit?: string; scope?: string; characterId?: string } }>(
    "/earning/me/ledger",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const scope = req.query.scope === "character" ? "character" : "user";
      let ownerId = me.id;
      if (scope === "character") {
        const cid = req.query.characterId;
        if (!cid) { reply.code(400); return { error: "characterId required" }; }
        const c = (await db
          .select()
          .from(characters)
          .where(and(eq(characters.id, cid), eq(characters.userId, me.id)))
          .limit(1))[0];
        if (!c) { reply.code(403); return { error: "not your character" }; }
        ownerId = cid;
      }
      const limit = Math.min(LEDGER_PAGE_LIMIT, Math.max(1, Number.parseInt(req.query.limit ?? "", 10) || LEDGER_PAGE_LIMIT));
      const cursorMs = req.query.cursor ? Number.parseInt(req.query.cursor, 10) : null;
      const where = cursorMs
        ? and(
            eq(earningLedger.scope, scope),
            eq(earningLedger.ownerId, ownerId),
            lt(earningLedger.createdAt, new Date(cursorMs)),
          )
        : and(eq(earningLedger.scope, scope), eq(earningLedger.ownerId, ownerId));
      const rows = await db
        .select()
        .from(earningLedger)
        .where(where)
        .orderBy(desc(earningLedger.createdAt))
        .limit(limit);
      const nextCursor = rows.length === limit ? +rows[rows.length - 1]!.createdAt : null;
      return {
        entries: rows.map((r) => ({
          id: r.id,
          scope: r.scope,
          ownerId: r.ownerId,
          xpDelta: r.xpDelta,
          currencyDelta: r.currencyDelta,
          reason: r.reason,
          metadata: r.metadataJson ? safeParse(r.metadataJson) : null,
          createdAt: +r.createdAt,
        })),
        nextCursor,
      };
    },
  );

  /**
   * Per-user privacy + display settings. Currently:
   *   - hideCurrencyCount: hide Currency total from others
   *   - selectedBorderRankKey: equip one of the user's owned borders
   *     (validated against `user_owned_borders` — caller can't equip
   *     what they don't own)
   */
  app.patch<{ Body: unknown }>("/earning/me/settings", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof patchSettingsBody>;
    try { body = patchSettingsBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

    const characterId = body.characterId ?? null;
    if (characterId) {
      const c = (await db
        .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
        .from(characters)
        .where(eq(characters.id, characterId))
        .limit(1))[0];
      if (!c || c.userId !== me.id || c.deletedAt) {
        reply.code(403);
        return { error: "not your character" };
      }
    }

    if (characterId) {
      // Per-character path: hide flags don't apply (those are
      // master-only privacy prefs), only the border equip routes
      // here. Ensure the character_earning row exists.
      await db.insert(characterEarning).values({ characterId }).onConflictDoNothing();
      if (body.selectedBorderRankKey !== undefined) {
        let value: string | null = null;
        if (body.selectedBorderRankKey !== null) {
          const owned = (await db
            .select()
            .from(characterOwnedBorders)
            .where(and(
              eq(characterOwnedBorders.characterId, characterId),
              eq(characterOwnedBorders.rankKey, body.selectedBorderRankKey),
            ))
            .limit(1))[0];
          if (!owned) {
            reply.code(403);
            return { error: "this character doesn't own that border" };
          }
          value = body.selectedBorderRankKey;
        }
        await db
          .update(characterEarning)
          .set({ selectedBorderRankKey: value, updatedAt: new Date() })
          .where(eq(characterEarning.characterId, characterId));
      }
      await rebroadcastPresenceForUser(me.id);
      return { ok: true };
    }

    // Master path — unchanged behavior.
    await db.insert(userEarning).values({ userId: me.id }).onConflictDoNothing();

    const update: Partial<typeof userEarning.$inferInsert> = { updatedAt: new Date() };
    if (body.hideCurrencyCount !== undefined) update.hideCurrencyCount = body.hideCurrencyCount;
    if (body.hideXpCount !== undefined) update.hideXpCount = body.hideXpCount;
    if (body.selectedBorderRankKey !== undefined) {
      if (body.selectedBorderRankKey === null) {
        update.selectedBorderRankKey = null;
      } else {
        // Validate ownership against master's owned borders.
        const owned = (await db
          .select()
          .from(userOwnedBorders)
          .where(and(
            eq(userOwnedBorders.userId, me.id),
            eq(userOwnedBorders.rankKey, body.selectedBorderRankKey),
          ))
          .limit(1))[0];
        if (!owned) {
          reply.code(403);
          return { error: "you don't own that border" };
        }
        update.selectedBorderRankKey = body.selectedBorderRankKey;
      }
    }
    if (Object.keys(update).length === 1) return { ok: true }; // only updatedAt — nothing to do
    await db.update(userEarning).set(update).where(eq(userEarning.userId, me.id));
    // Border equip changes the bordered-avatar rendering on every line
    // this user appears on, so peers need a fresh occupant snapshot to
    // see it without a refresh. hideCurrencyCount / hideXpCount only
    // affect the dashboard view (not occupants), so the broadcast is a
    // no-op for those — cheap regardless since the function early-exits
    // when the user has no live sockets.
    if (body.selectedBorderRankKey !== undefined) {
      await rebroadcastPresenceForUser(me.id);
    }
    return { ok: true };
  });

  /**
   * Unacknowledged rank-ups for the chat ribbon. Cap defaults to 25
   * (the notifications helper enforces this).
   */
  app.get("/earning/me/notifications", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    return { notifications: await listUnacknowledged(db, me.id) };
  });

  /**
   * Acknowledge a single rank-up (clears it from the ribbon). Pass
   * notificationId to clear one; omit to clear all.
   */
  app.post<{ Body: unknown }>("/earning/me/notifications/rankup/ack", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof ackBody>;
    try { body = ackBody.parse(req.body ?? {}); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    if (body.notificationId) {
      await ackNotification(db, me.id, body.notificationId);
      return { ok: true };
    }
    const cleared = await ackAllForUser(db, me.id);
    return { ok: true, cleared };
  });

  /**
   * Catalog endpoint — what's available to buy / equip. Public so the
   * dashboard can render previews to users who haven't bought
   * anything yet. Returns enabled name styles + cosmetics, but
   * filters disabled rows so the UI doesn't accidentally let users
   * try to buy something the admin has shut off.
   */
  app.get("/earning/catalog", async () => {
    const styleRows = await db
      .select()
      .from(nameStyles)
      .where(eq(nameStyles.enabled, true))
      .orderBy(asc(nameStyles.order));
    const cosmeticRows = await db
      .select()
      .from(cosmetics)
      .where(eq(cosmetics.enabled, true));
    const itemRows = await db
      .select()
      .from(items)
      .where(eq(items.enabled, true))
      .orderBy(asc(items.order));
    const nowMs = Date.now();
    return {
      nameStyles: styleRows.map((r) => ({
        key: r.key,
        name: r.name,
        description: r.description,
        template: r.template,
        styleCss: r.styleCss,
        cost: r.cost,
        isBuiltin: !!r.isBuiltin,
        order: r.order,
      })),
      cosmetics: cosmeticRows.map((r) => ({
        key: r.key,
        name: r.name,
        description: r.description,
        cost: r.cost,
        config: r.configJson ? safeParse(r.configJson) : null,
      })),
      items: itemRows.map((r) => shapeItemCatalogRow(r, nowMs)),
    };
  });

  /* =========================================================
   *  Name styles — purchase / config / equip
   *
   *  Three endpoints back the dashboard's Name Styles section:
   *
   *    POST /earning/me/name-styles/:key/purchase
   *      Atomic spend + grant. Validates: style exists + enabled +
   *      not already owned + caller has enough Currency on the
   *      master pool. Writes the ledger + user_owned_name_styles
   *      row, then deducts via `creditPool` so the wallet
   *      `earning:earned` event fires for live UI update.
   *
   *    PATCH /earning/me/name-styles/:key/config
   *      Persist the per-user color / glow / etc. picks for an
   *      already-owned style. Body is opaque JSON — the renderer
   *      interprets the shape per style.
   *
   *    POST /earning/me/active-name-style { styleKey | null }
   *      Equip / unequip. Null clears the active style; non-null
   *      must reference an owned + enabled style.
   * ========================================================= */

  const purchaseStyleBody = z.object({
    /**
     * Per-identity purchase scope. Omit / null debits the master
     * Currency pool and writes to `user_owned_name_styles` (the
     * master/OOC's owned list). A character id debits that
     * character's pool and writes to `character_owned_name_styles`.
     * Each identity owns separately — Kaal buying Embers does NOT
     * make WAS own it, and vice versa. Caller must own the character.
     */
    characterId: z.string().nullable().optional(),
  }).strict().optional();
  const patchStyleConfigBody = z.object({
    config: z.record(z.unknown()).nullable().optional(),
    /** Per-identity scope. Defaults to master/OOC. */
    characterId: z.string().nullable().optional(),
  }).strict();
  const equipStyleBody = z.object({
    styleKey: z.string().nullable(),
    /**
     * Per-identity equip target. Omit / pass null to equip on the
     * master/OOC slot; pass a character id to equip on that character.
     * The server validates ownership of the character before writing
     * so a caller can't toggle someone else's identity. Style
     * ownership stays account-wide for now, so the same `styleKey`
     * works against any of the caller's identities once purchased.
     */
    characterId: z.string().nullable().optional(),
  }).strict();
  const equipInlineAvatarBody = z.object({
    enabled: z.boolean(),
    /** Same scoping rule as equipStyleBody — null/omitted = master. */
    characterId: z.string().nullable().optional(),
  }).strict();

  app.post<{ Params: { key: string }; Body: unknown }>(
    "/earning/me/name-styles/:key/purchase",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      let body: z.infer<typeof purchaseStyleBody> | undefined;
      try { body = purchaseStyleBody.parse(req.body ?? {}); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const characterId = body?.characterId ?? null;
      if (characterId) {
        const c = (await db
          .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
          .from(characters)
          .where(eq(characters.id, characterId))
          .limit(1))[0];
        if (!c || c.userId !== me.id || c.deletedAt) {
          reply.code(403);
          return { error: "not your character" };
        }
      }

      // Entire purchase runs in one sqlite transaction so the funds
      // check, ownership insert, currency debit, and ledger insert
      // can't race. Per-identity scope routes to the right ownership
      // table (`user_owned_*` for master, `character_owned_*` for a
      // character) and debits the matching pool.
      const outcome = runPurchaseTxn(db, me.id, {
        characterId,
        validate: (tx) => {
          const style = tx.select().from(nameStyles).where(eq(nameStyles.key, req.params.key)).limit(1).all()[0];
          if (!style || !style.enabled) return { ok: false, status: 404, error: "style not found or disabled" };
          if (characterId) {
            const already = tx.select().from(characterOwnedNameStyles).where(and(
              eq(characterOwnedNameStyles.characterId, characterId),
              eq(characterOwnedNameStyles.styleKey, req.params.key),
            )).limit(1).all()[0];
            if (already) return { ok: false, status: 409, error: "already owned" };
          } else {
            const already = tx.select().from(userOwnedNameStyles).where(and(
              eq(userOwnedNameStyles.userId, me.id),
              eq(userOwnedNameStyles.styleKey, req.params.key),
            )).limit(1).all()[0];
            if (already) return { ok: false, status: 409, error: "already owned" };
          }
          return { ok: true, cost: style.cost };
        },
        grant: (tx) => {
          if (characterId) {
            tx.insert(characterOwnedNameStyles).values({
              characterId,
              styleKey: req.params.key,
              configJson: null,
            }).run();
          } else {
            tx.insert(userOwnedNameStyles).values({
              userId: me.id,
              styleKey: req.params.key,
              configJson: null,
            }).run();
          }
        },
        reason: `purchase_${req.params.key}`,
        metadata: { kind: "name_style", styleKey: req.params.key },
      });
      if (!outcome.ok) {
        reply.code(outcome.status);
        return outcome.required !== undefined
          ? { error: outcome.error, required: outcome.required, balance: outcome.balance }
          : { error: outcome.error };
      }
      await emitWalletUpdate(
        io,
        me.id,
        outcome.final,
        -outcome.cost,
        `purchase_${req.params.key}`,
        characterId ? { scope: "character", ownerId: characterId } : { scope: "user" },
      );
      return { ok: true };
    },
  );

  app.patch<{ Params: { key: string }; Body: unknown }>(
    "/earning/me/name-styles/:key/config",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      let body: z.infer<typeof patchStyleConfigBody>;
      try { body = patchStyleConfigBody.parse(req.body); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

      const characterId = body.characterId ?? null;
      if (characterId) {
        const c = (await db
          .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
          .from(characters)
          .where(eq(characters.id, characterId))
          .limit(1))[0];
        if (!c || c.userId !== me.id || c.deletedAt) {
          reply.code(403);
          return { error: "not your character" };
        }
        const owned = (await db
          .select()
          .from(characterOwnedNameStyles)
          .where(and(
            eq(characterOwnedNameStyles.characterId, characterId),
            eq(characterOwnedNameStyles.styleKey, req.params.key),
          ))
          .limit(1))[0];
        if (!owned) { reply.code(404); return { error: "not owned" }; }
        await db
          .update(characterOwnedNameStyles)
          .set({ configJson: body.config ? JSON.stringify(body.config) : null })
          .where(and(
            eq(characterOwnedNameStyles.characterId, characterId),
            eq(characterOwnedNameStyles.styleKey, req.params.key),
          ));
      } else {
        const owned = (await db
          .select()
          .from(userOwnedNameStyles)
          .where(and(eq(userOwnedNameStyles.userId, me.id), eq(userOwnedNameStyles.styleKey, req.params.key)))
          .limit(1))[0];
        if (!owned) { reply.code(404); return { error: "not owned" }; }
        await db
          .update(userOwnedNameStyles)
          .set({ configJson: body.config ? JSON.stringify(body.config) : null })
          .where(and(eq(userOwnedNameStyles.userId, me.id), eq(userOwnedNameStyles.styleKey, req.params.key)));
      }
      // Style config (colors / glow / outline) feeds straight into the
      // occupant payload's `activeStyleConfig`, so a refresh here lands
      // the tweak live without a peer-side reload.
      await rebroadcastPresenceForUser(me.id);
      return { ok: true };
    },
  );

  app.post<{ Body: unknown }>("/earning/me/active-name-style", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof equipStyleBody>;
    try { body = equipStyleBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

    if (body.styleKey) {
      // Ownership check scoped to the same identity we're about to
      // equip on. Master/OOC reads user_owned_name_styles; per-
      // character reads character_owned_name_styles. The same
      // styleKey can be owned by one identity and not the other
      // since migration 0086, so a master's purchase does NOT let
      // a character equip the same style — they have to buy it
      // from their own pool.
      if (body.characterId) {
        const owned = (await db
          .select()
          .from(characterOwnedNameStyles)
          .where(and(
            eq(characterOwnedNameStyles.characterId, body.characterId),
            eq(characterOwnedNameStyles.styleKey, body.styleKey),
          ))
          .limit(1))[0];
        if (!owned) { reply.code(403); return { error: "this character doesn't own that style" }; }
      } else {
        const owned = (await db
          .select()
          .from(userOwnedNameStyles)
          .where(and(eq(userOwnedNameStyles.userId, me.id), eq(userOwnedNameStyles.styleKey, body.styleKey)))
          .limit(1))[0];
        if (!owned) { reply.code(403); return { error: "you don't own that style" }; }
      }
      const style = (await db
        .select({ enabled: nameStyles.enabled })
        .from(nameStyles)
        .where(eq(nameStyles.key, body.styleKey))
        .limit(1))[0];
      if (!style || !style.enabled) { reply.code(409); return { error: "style disabled" }; }
    }

    if (body.characterId) {
      // Character scope — validate the caller actually owns the
      // character before writing. The /char switch flow already
      // enforces this, but the equip endpoint accepts a raw id from
      // the request body so an attacker could otherwise flip
      // cosmetics on a stranger's character.
      const c = (await db
        .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
        .from(characters)
        .where(eq(characters.id, body.characterId))
        .limit(1))[0];
      if (!c || c.userId !== me.id || c.deletedAt) {
        reply.code(403);
        return { error: "not your character" };
      }
      // Lazy upsert the per-character earning row. The same row
      // carries XP / currency / rank already; we just patch the
      // active_name_style_key column.
      await db
        .insert(characterEarning)
        .values({ characterId: c.id, activeNameStyleKey: body.styleKey })
        .onConflictDoUpdate({
          target: characterEarning.characterId,
          set: { activeNameStyleKey: body.styleKey, updatedAt: new Date() },
        });
    } else {
      // Master/OOC scope — lazy upsert on user_active_cosmetics.
      const existing = (await db
        .select()
        .from(userActiveCosmetics)
        .where(eq(userActiveCosmetics.userId, me.id))
        .limit(1))[0];
      if (existing) {
        await db.update(userActiveCosmetics).set({
          activeNameStyleKey: body.styleKey,
          updatedAt: new Date(),
        }).where(eq(userActiveCosmetics.userId, me.id));
      } else {
        await db.insert(userActiveCosmetics).values({
          userId: me.id,
          activeNameStyleKey: body.styleKey,
        });
      }
    }
    // Refresh occupant presence so every room the user is parked in
    // picks up the new style on the next render — without this the
    // equip didn't take effect until peers refreshed.
    await rebroadcastPresenceForUser(me.id);
    return { ok: true };
  });

  /* =========================================================
   *  Cosmetics — inline_avatar (Phase 4)
   *
   *  Two endpoints back the dashboard's Cosmetics section:
   *
   *    POST /earning/me/cosmetics/inline_avatar/purchase
   *      Atomic Currency debit + grants the right to equip. We
   *      record ownership by setting `inline_avatar_enabled = 1`
   *      lazily on first purchase — there's no separate "owned but
   *      not equipped" state for this cosmetic (per plan.md), so
   *      buying is implicitly equipping. The user can later toggle
   *      off via the equip endpoint without losing the purchase
   *      (re-equip is free).
   *
   *    POST /earning/me/cosmetics/inline_avatar/equip { enabled }
   *      Toggle the on/off state without re-charging. Requires a
   *      prior purchase (we look for a `purchase_inline_avatar`
   *      ledger row).
   *
   *  Currently the only `cosmetics` row Phase 4 ships is
   *  `inline_avatar`; the URL accepts the key as a path param to
   *  leave room for future row-driven cosmetics without changing
   *  the route surface.
   * ========================================================= */

  const equipCosmeticBody = z.object({
    enabled: z.boolean(),
    /** Same scoping rule as the name-style equip endpoint —
     *  null/omitted writes the master/OOC slot on
     *  user_active_cosmetics; a character id writes that
     *  character's character_earning row. */
    characterId: z.string().nullable().optional(),
  }).strict();

  /**
   * Helper: has this identity (master user OR character) ever
   * purchased this cosmetic? We use the ledger as the source of
   * truth — `scope` + `ownerId` partition by identity, so each
   * character has its own "ever purchased" history. Admin grants
   * and free promo cosmetics still flow through the same ledger
   * insert.
   */
  async function hasPurchased(scope: "user" | "character", ownerId: string, cosmeticKey: string): Promise<boolean> {
    const reason = `purchase_${cosmeticKey}`;
    const r = (await db
      .select({ id: earningLedger.id })
      .from(earningLedger)
      .where(and(
        eq(earningLedger.scope, scope),
        eq(earningLedger.ownerId, ownerId),
        eq(earningLedger.reason, reason),
      ))
      .limit(1))[0];
    return !!r;
  }

  const purchaseCosmeticBody = z.object({
    /** Per-identity scope. Master/OOC if null; character id debits
     *  that character's pool and grants ownership scoped to the
     *  character (ledger row with scope="character"). */
    characterId: z.string().nullable().optional(),
  }).strict().optional();

  app.post<{ Params: { key: string }; Body: unknown }>(
    "/earning/me/cosmetics/:key/purchase",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      // Only the cosmetics that ship in Phase 4 are buyable through
      // this endpoint. `rank_border` is a placeholder row in the
      // cosmetics table — the actual purchase goes through the
      // border-specific endpoint below because pricing lives on
      // rank_tiers.borderCost.
      if (req.params.key !== "inline_avatar") {
        reply.code(404);
        return { error: "unknown cosmetic key" };
      }
      let body: z.infer<typeof purchaseCosmeticBody> | undefined;
      try { body = purchaseCosmeticBody.parse(req.body ?? {}); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const characterId = body?.characterId ?? null;
      if (characterId) {
        const c = (await db
          .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
          .from(characters)
          .where(eq(characters.id, characterId))
          .limit(1))[0];
        if (!c || c.userId !== me.id || c.deletedAt) {
          reply.code(403);
          return { error: "not your character" };
        }
      }
      const outcome = runPurchaseTxn(db, me.id, {
        characterId,
        validate: (tx) => {
          const cosmetic = tx.select().from(cosmetics).where(eq(cosmetics.key, req.params.key)).limit(1).all()[0];
          if (!cosmetic || !cosmetic.enabled) return { ok: false, status: 404, error: "cosmetic not found or disabled" };
          // Per-identity ownership check. Master's prior purchase
          // does NOT count as ownership for a character (and vice
          // versa) — each identity has its own ledger trail.
          const existingPurchase = characterId
            ? tx.select({ id: earningLedger.id }).from(earningLedger).where(and(
                eq(earningLedger.scope, "character"),
                eq(earningLedger.ownerId, characterId),
                eq(earningLedger.reason, `purchase_${req.params.key}`),
              )).limit(1).all()[0]
            : tx.select({ id: earningLedger.id }).from(earningLedger).where(and(
                eq(earningLedger.scope, "user"),
                eq(earningLedger.ownerId, me.id),
                eq(earningLedger.reason, `purchase_${req.params.key}`),
              )).limit(1).all()[0];
          if (existingPurchase) return { ok: false, status: 409, error: "already owned" };
          return { ok: true, cost: cosmetic.cost };
        },
        grant: (tx) => {
          // Auto-enable on first purchase, writing to the right
          // identity's slot (character_earning when character-scoped,
          // user_active_cosmetics for master/OOC).
          if (characterId) {
            tx.insert(characterEarning).values({ characterId, inlineAvatarEnabled: true }).onConflictDoUpdate({
              target: characterEarning.characterId,
              set: { inlineAvatarEnabled: true, updatedAt: new Date() },
            }).run();
          } else {
            const existing = tx.select().from(userActiveCosmetics).where(eq(userActiveCosmetics.userId, me.id)).limit(1).all()[0];
            if (existing) {
              tx.update(userActiveCosmetics)
                .set({ inlineAvatarEnabled: true, updatedAt: new Date() })
                .where(eq(userActiveCosmetics.userId, me.id))
                .run();
            } else {
              tx.insert(userActiveCosmetics).values({
                userId: me.id,
                inlineAvatarEnabled: true,
              }).run();
            }
          }
        },
        reason: `purchase_${req.params.key}`,
        metadata: { kind: "cosmetic", cosmeticKey: req.params.key },
      });
      if (!outcome.ok) {
        reply.code(outcome.status);
        return outcome.required !== undefined
          ? { error: outcome.error, required: outcome.required, balance: outcome.balance }
          : { error: outcome.error };
      }
      await emitWalletUpdate(
        io,
        me.id,
        outcome.final,
        -outcome.cost,
        `purchase_${req.params.key}`,
        characterId ? { scope: "character", ownerId: characterId } : { scope: "user" },
      );
      await rebroadcastPresenceForUser(me.id);
      return { ok: true };
    },
  );

  app.post<{ Params: { key: string }; Body: unknown }>(
    "/earning/me/cosmetics/:key/equip",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      if (req.params.key !== "inline_avatar") {
        reply.code(404);
        return { error: "unknown cosmetic key" };
      }
      let body: z.infer<typeof equipCosmeticBody>;
      try { body = equipCosmeticBody.parse(req.body); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
      // Per-identity purchase check — character-scoped equip requires
      // the CHARACTER to have purchased; master-scoped requires master.
      if (body.characterId) {
        const c = (await db
          .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
          .from(characters)
          .where(eq(characters.id, body.characterId))
          .limit(1))[0];
        if (!c || c.userId !== me.id || c.deletedAt) {
          reply.code(403);
          return { error: "not your character" };
        }
        if (body.enabled && !(await hasPurchased("character", body.characterId, req.params.key))) {
          reply.code(403);
          return { error: "this character hasn't purchased it" };
        }
        await db
          .insert(characterEarning)
          .values({ characterId: c.id, inlineAvatarEnabled: body.enabled })
          .onConflictDoUpdate({
            target: characterEarning.characterId,
            set: { inlineAvatarEnabled: body.enabled, updatedAt: new Date() },
          });
      } else {
        if (body.enabled && !(await hasPurchased("user", me.id, req.params.key))) {
          reply.code(403);
          return { error: "purchase required" };
        }
        const existing = (await db
          .select()
          .from(userActiveCosmetics)
          .where(eq(userActiveCosmetics.userId, me.id))
          .limit(1))[0];
        if (existing) {
          await db.update(userActiveCosmetics)
            .set({ inlineAvatarEnabled: body.enabled, updatedAt: new Date() })
            .where(eq(userActiveCosmetics.userId, me.id));
        } else {
          await db.insert(userActiveCosmetics).values({
            userId: me.id,
            inlineAvatarEnabled: body.enabled,
          });
        }
      }
      // Toggle changes whether the avatar tile renders next to the
      // user's name on every chat line — peers need a fresh occupant
      // snapshot or the change waits until the next presence event.
      await rebroadcastPresenceForUser(me.id);
      return { ok: true };
    },
  );

  /* =========================================================
   *  Borders — per-rank Tier IV purchase + equip
   *
   *  Eligibility: the user must have *ever* held Tier IV of the
   *  target rank, tracked by user_earning.maxRankKeyEverHeld /
   *  maxTierEverHeld. The "once eligible, always eligible" rule
   *  (resolver.ts) means a later threshold raise doesn't revoke
   *  the right to buy.
   *
   *  Pricing lives on rank_tiers.borderCost for Tier IV of the
   *  target rank.
   *
   *  Equip: writes user_earning.selectedBorderRankKey. The
   *  existing PATCH /earning/me/settings endpoint already
   *  accepts a `selectedBorderRankKey` field with ownership
   *  validation, so we just reuse that for unequip / switch.
   * ========================================================= */

  const purchaseBorderBody = z.object({
    /** Per-identity purchase scope, same shape as the style purchase
     *  endpoint. Null/omitted = master; character id = that character
     *  pays from their own pool and owns the border in
     *  `character_owned_borders`. */
    characterId: z.string().nullable().optional(),
  }).strict().optional();

  app.post<{ Params: { rankKey: string }; Body: unknown }>(
    "/earning/me/borders/:rankKey/purchase",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const rankKey = req.params.rankKey;
      let body: z.infer<typeof purchaseBorderBody> | undefined;
      try { body = purchaseBorderBody.parse(req.body ?? {}); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const characterId = body?.characterId ?? null;
      if (characterId) {
        const c = (await db
          .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
          .from(characters)
          .where(eq(characters.id, characterId))
          .limit(1))[0];
        if (!c || c.userId !== me.id || c.deletedAt) {
          reply.code(403);
          return { error: "not your character" };
        }
      }

      const outcome = runPurchaseTxn(db, me.id, {
        characterId,
        validate: (tx) => {
          const rankRow = tx.select().from(ranks).where(eq(ranks.key, rankKey)).limit(1).all()[0];
          if (!rankRow) return { ok: false, status: 404, error: "rank not found" };
          const tier4 = tx.select().from(rankTiers).where(and(
            eq(rankTiers.rankKey, rankKey),
            eq(rankTiers.tier, 4),
          )).limit(1).all()[0];
          if (!tier4 || !tier4.borderImageUrl || tier4.borderCost == null) {
            return { ok: false, status: 404, error: "no border configured for this rank" };
          }
          // Eligibility: read peak rank from the scope-appropriate
          // earning row. Characters earn their own rank progression,
          // so a character that hasn't peaked at Tier IV can't buy
          // its own border even if their master has.
          let earning: { maxRankKeyEverHeld: string | null; maxTierEverHeld: number | null };
          if (characterId) {
            tx.insert(characterEarning).values({ characterId }).onConflictDoNothing().run();
            const row = tx.select().from(characterEarning).where(eq(characterEarning.characterId, characterId)).limit(1).all()[0]!;
            earning = { maxRankKeyEverHeld: row.maxRankKeyEverHeld, maxTierEverHeld: row.maxTierEverHeld };
          } else {
            tx.insert(userEarning).values({ userId: me.id }).onConflictDoNothing().run();
            const row = tx.select().from(userEarning).where(eq(userEarning.userId, me.id)).limit(1).all()[0]!;
            earning = { maxRankKeyEverHeld: row.maxRankKeyEverHeld, maxTierEverHeld: row.maxTierEverHeld };
          }
          let eligible = false;
          if (earning.maxRankKeyEverHeld === rankKey && (earning.maxTierEverHeld ?? 0) >= 4) {
            eligible = true;
          } else if (earning.maxRankKeyEverHeld) {
            const peakRow = tx.select({ order: ranks.order }).from(ranks).where(eq(ranks.key, earning.maxRankKeyEverHeld)).limit(1).all()[0];
            if (peakRow && peakRow.order > rankRow.order) eligible = true;
          }
          if (!eligible) {
            return {
              ok: false,
              status: 403,
              error: "Reach Tier IV of this rank before purchasing its border.",
            };
          }
          // Already-owned check against the scope-appropriate table.
          if (characterId) {
            const already = tx.select().from(characterOwnedBorders).where(and(
              eq(characterOwnedBorders.characterId, characterId),
              eq(characterOwnedBorders.rankKey, rankKey),
            )).limit(1).all()[0];
            if (already) return { ok: false, status: 409, error: "already owned" };
          } else {
            const already = tx.select().from(userOwnedBorders).where(and(
              eq(userOwnedBorders.userId, me.id),
              eq(userOwnedBorders.rankKey, rankKey),
            )).limit(1).all()[0];
            if (already) return { ok: false, status: 409, error: "already owned" };
          }
          return { ok: true, cost: tier4.borderCost };
        },
        grant: (tx) => {
          if (characterId) {
            tx.insert(characterOwnedBorders).values({ characterId, rankKey }).onConflictDoNothing().run();
            // Auto-equip on first character purchase. Reads /
            // writes `character_earning.selected_border_rank_key`.
            const cur = tx.select({ selected: characterEarning.selectedBorderRankKey }).from(characterEarning).where(eq(characterEarning.characterId, characterId)).limit(1).all()[0];
            if (!cur?.selected) {
              tx.update(characterEarning)
                .set({ selectedBorderRankKey: rankKey, updatedAt: new Date() })
                .where(eq(characterEarning.characterId, characterId))
                .run();
            }
          } else {
            tx.insert(userOwnedBorders).values({ userId: me.id, rankKey }).onConflictDoNothing().run();
            const cur = tx.select({ selected: userEarning.selectedBorderRankKey }).from(userEarning).where(eq(userEarning.userId, me.id)).limit(1).all()[0];
            if (!cur?.selected) {
              tx.update(userEarning)
                .set({ selectedBorderRankKey: rankKey, updatedAt: new Date() })
                .where(eq(userEarning.userId, me.id))
                .run();
            }
          }
        },
        reason: `border_purchase_${rankKey}`,
        metadata: { kind: "border", rankKey },
      });
      if (!outcome.ok) {
        reply.code(outcome.status);
        return outcome.required !== undefined
          ? { error: outcome.error, required: outcome.required, balance: outcome.balance }
          : { error: outcome.error };
      }
      await emitWalletUpdate(
        io,
        me.id,
        outcome.final,
        -outcome.cost,
        `border_purchase_${rankKey}`,
        characterId ? { scope: "character", ownerId: characterId } : { scope: "user" },
      );
      // Border purchase auto-equips when the identity has no border set
      // yet. Refresh occupants so peers see the new bordered avatar
      // immediately.
      await rebroadcastPresenceForUser(me.id);
      return { ok: true };
    },
  );

  /* =========================================================
   *  Items — shop purchase
   *
   *  POST /earning/me/items/:key/buy
   *    Body: { quantity, characterId? }
   *    Spends `price * quantity` Currency from the buying identity's
   *    pool, upserts the matching `identity_inventory` row clamped to
   *    `stack_limit`. Atomic via `runPurchaseTxn` so funds + grant +
   *    ledger insert can't race.
   *
   *  Partitioning: `characterId` selects which identity buys. Null /
   *  omitted = master/OOC (scope='user', ownerId=me.id). A character
   *  id (after ownership check) = scope='character', ownerId=charId.
   *  Currency and inventory both partition cleanly — buying as
   *  Character A only debits A's pool and only stocks A's inventory.
   * ========================================================= */

  const buyItemBody = z.object({
    quantity: z.number().int().min(1).max(999),
    characterId: z.string().nullable().optional(),
  }).strict();

  app.post<{ Params: { key: string }; Body: unknown }>(
    "/earning/me/items/:key/buy",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      let body: z.infer<typeof buyItemBody>;
      try { body = buyItemBody.parse(req.body ?? {}); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

      const characterId = body.characterId ?? null;
      if (characterId) {
        const c = (await db
          .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
          .from(characters)
          .where(eq(characters.id, characterId))
          .limit(1))[0];
        if (!c || c.userId !== me.id || c.deletedAt) {
          reply.code(403);
          return { error: "not your character" };
        }
      }

      const ownerScope: "user" | "character" = characterId ? "character" : "user";
      const ownerId = characterId ?? me.id;

      const outcome = runPurchaseTxn(db, me.id, {
        characterId,
        validate: (tx) => {
          const item = tx.select().from(items).where(eq(items.key, req.params.key)).limit(1).all()[0];
          if (!item || !item.enabled) {
            return { ok: false, status: 404, error: "item not found or disabled" };
          }
          if (!item.forSale) {
            return { ok: false, status: 403, error: "not currently for sale" };
          }
          const nowMs = Date.now();
          if (item.saleStartsAt && nowMs < +item.saleStartsAt) {
            return { ok: false, status: 403, error: "sale hasn't started yet" };
          }
          if (item.saleEndsAt && nowMs >= +item.saleEndsAt) {
            return { ok: false, status: 403, error: "sale has ended" };
          }
          // Stack-cap check against the buying identity's current
          // holdings. Reject the whole transaction rather than
          // partial-buying — the client should disable the Buy button
          // when at cap, so a 409 here is a defensive backstop.
          const existing = tx.select({ qty: identityInventory.quantity })
            .from(identityInventory)
            .where(and(
              eq(identityInventory.ownerScope, ownerScope),
              eq(identityInventory.ownerId, ownerId),
              eq(identityInventory.itemKey, req.params.key),
            )).limit(1).all()[0];
          const have = existing?.qty ?? 0;
          if (have + body.quantity > item.stackLimit) {
            return {
              ok: false,
              status: 409,
              error: `would exceed stack limit (${item.stackLimit})`,
            };
          }
          return { ok: true, cost: item.price * body.quantity };
        },
        grant: (tx) => {
          // Upsert: increment quantity if a row already exists for this
          // (identity, itemKey) tuple; otherwise insert fresh.
          const existing = tx.select({ qty: identityInventory.quantity })
            .from(identityInventory)
            .where(and(
              eq(identityInventory.ownerScope, ownerScope),
              eq(identityInventory.ownerId, ownerId),
              eq(identityInventory.itemKey, req.params.key),
            )).limit(1).all()[0];
          if (existing) {
            tx.update(identityInventory)
              .set({ quantity: existing.qty + body.quantity, updatedAt: new Date() })
              .where(and(
                eq(identityInventory.ownerScope, ownerScope),
                eq(identityInventory.ownerId, ownerId),
                eq(identityInventory.itemKey, req.params.key),
              ))
              .run();
          } else {
            tx.insert(identityInventory).values({
              ownerScope,
              ownerId,
              itemKey: req.params.key,
              quantity: body.quantity,
            }).run();
          }
        },
        reason: `item_purchase_${req.params.key}`,
        metadata: { kind: "item", itemKey: req.params.key, quantity: body.quantity },
      });
      if (!outcome.ok) {
        reply.code(outcome.status);
        return outcome.required !== undefined
          ? { error: outcome.error, required: outcome.required, balance: outcome.balance }
          : { error: outcome.error };
      }
      await emitWalletUpdate(
        io,
        me.id,
        outcome.final,
        -outcome.cost,
        `item_purchase_${req.params.key}`,
        characterId ? { scope: "character", ownerId: characterId } : { scope: "user" },
      );
      // Inventory live-update so an open dashboard's Items tab
      // refreshes its inventory + shop "you own X/Y" line without
      // the user reopening the modal.
      const buyerSockets = await io.fetchSockets();
      for (const s of buyerSockets) {
        const uid = (s.data as { userId?: string }).userId;
        if (uid !== me.id) continue;
        s.emit("earning:inventory_changed", {
          scope: characterId ? "character" : "user",
          ownerId: characterId ?? me.id,
          itemKey: req.params.key,
          delta: body.quantity,
          reason: "item_purchase",
        });
      }
      return { ok: true, quantity: body.quantity };
    },
  );

  /* =========================================================
   *  Collection — per-identity 10-slot pinned showcase.
   *
   *  PUT /earning/me/collection
   *    Body: { slots: Array<{ slot, itemKey | null }>, characterId? }
   *    Writes each provided slot in a single transaction. Slots not
   *    listed in the body are left untouched (the client sends only
   *    changed slots for a diff-style save). Setting itemKey=null
   *    clears the slot.
   *
   *  Partitioning: characterId null/omitted writes the OOC master's
   *  Collection; a character id writes that character's Collection.
   *  Validation: the pinned item must still be owned in the SAME
   *  identity's inventory (a master pin needs the item in the
   *  master inventory; a character pin needs it in the character's
   *  inventory). Cross-identity pins are rejected.
   * ========================================================= */

  const setCollectionSlotEntry = z.object({
    slot: z.number().int().min(0).max(9),
    itemKey: z.string().min(1).max(64).nullable(),
  }).strict();
  const setCollectionBody = z.object({
    slots: z.array(setCollectionSlotEntry).min(1).max(10),
    characterId: z.string().nullable().optional(),
  }).strict();

  app.put<{ Body: unknown }>("/earning/me/collection", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof setCollectionBody>;
    try { body = setCollectionBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

    // Reject duplicate slot indexes in the same request — the slot
    // is part of the PK, so writing 2x slot=3 in one go would race
    // with itself even inside a transaction.
    const slotSet = new Set<number>();
    for (const s of body.slots) {
      if (slotSet.has(s.slot)) {
        reply.code(400);
        return { error: `duplicate slot ${s.slot} in payload` };
      }
      slotSet.add(s.slot);
    }

    const characterId = body.characterId ?? null;
    if (characterId) {
      const c = (await db
        .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
        .from(characters)
        .where(eq(characters.id, characterId))
        .limit(1))[0];
      if (!c || c.userId !== me.id || c.deletedAt) {
        reply.code(403);
        return { error: "not your character" };
      }
    }
    const ownerScope: "user" | "character" = characterId ? "character" : "user";
    const ownerId = characterId ?? me.id;

    // Validate-and-apply in ONE transaction so a concurrent /give
    // can't drain the inventory between the ownership check and the
    // pin write. The validate phase reads `identity_inventory` for
    // every non-null itemKey in the payload AND looks up the item's
    // category to reject pets (those belong in the Pet Collection,
    // not here). The transaction throws on either failure; the
    // catch below maps the tagged error into a 403.
    const itemKeysToCheck = body.slots
      .map((s) => s.itemKey)
      .filter((k): k is string => typeof k === "string");
    try {
      db.transaction((tx) => {
        if (itemKeysToCheck.length > 0) {
          const ownedRows = tx.select({ itemKey: identityInventory.itemKey })
            .from(identityInventory)
            .where(and(
              eq(identityInventory.ownerScope, ownerScope),
              eq(identityInventory.ownerId, ownerId),
              inArray(identityInventory.itemKey, itemKeysToCheck),
            ))
            .all();
          const owned = new Set(ownedRows.map((r) => r.itemKey));
          for (const k of itemKeysToCheck) {
            if (!owned.has(k)) {
              // Throw with a tagged message so the catch can
              // surface a 403 specifically for missing-inventory.
              // SQLite transactions rollback on throw, leaving no
              // partial pin writes behind.
              throw new Error(`__pin_not_owned__:${k}`);
            }
          }
          // Category guard — pets belong in identity_pet_collection,
          // not here. Read the relevant category rows once and
          // reject any pet keys before the writes start.
          const catRows = tx.select({ key: items.key, category: items.category })
            .from(items)
            .where(inArray(items.key, itemKeysToCheck))
            .all();
          for (const r of catRows) {
            if (r.category === "pet") {
              throw new Error(`__pin_wrong_collection__:${r.key}`);
            }
          }
        }
        for (const s of body.slots) {
          if (s.itemKey === null) {
            tx.delete(identityCollection).where(and(
              eq(identityCollection.ownerScope, ownerScope),
              eq(identityCollection.ownerId, ownerId),
              eq(identityCollection.slot, s.slot),
            )).run();
          } else {
            // Upsert via delete-then-insert. SQLite's ON CONFLICT
            // DO UPDATE works too, but this idiom matches the rest
            // of the codebase's per-row writes.
            tx.delete(identityCollection).where(and(
              eq(identityCollection.ownerScope, ownerScope),
              eq(identityCollection.ownerId, ownerId),
              eq(identityCollection.slot, s.slot),
            )).run();
            tx.insert(identityCollection).values({
              ownerScope,
              ownerId,
              slot: s.slot,
              itemKey: s.itemKey,
            }).run();
          }
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.startsWith("__pin_not_owned__:")) {
        reply.code(403);
        return { error: `you don't hold item "${msg.slice("__pin_not_owned__:".length)}" on this identity` };
      }
      if (msg.startsWith("__pin_wrong_collection__:")) {
        reply.code(403);
        return { error: `"${msg.slice("__pin_wrong_collection__:".length)}" is a pet — pin it to your Pet Collection instead.` };
      }
      throw err;
    }

    return { ok: true };
  });

  /* =========================================================
   *  Pet Collection — 5-slot pinned pet showcase
   *
   *  PUT /earning/me/pet-collection
   *    Body: { slots: Array<{ slot, itemKey | null }>, characterId? }
   *    Same wire shape + diff semantics as PUT /collection, but
   *    targets identity_pet_collection (5 slots) and validates that
   *    every pinned item has `category='pet'`. Non-pets get rejected
   *    with the inverse error of the item-collection's pet guard.
   * ========================================================= */

  const setPetCollectionSlotEntry = z.object({
    slot: z.number().int().min(0).max(4),
    itemKey: z.string().min(1).max(64).nullable(),
  }).strict();
  const setPetCollectionBody = z.object({
    slots: z.array(setPetCollectionSlotEntry).min(1).max(5),
    characterId: z.string().nullable().optional(),
  }).strict();

  app.put<{ Body: unknown }>("/earning/me/pet-collection", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: z.infer<typeof setPetCollectionBody>;
    try { body = setPetCollectionBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

    const slotSet = new Set<number>();
    for (const s of body.slots) {
      if (slotSet.has(s.slot)) {
        reply.code(400);
        return { error: `duplicate slot ${s.slot} in payload` };
      }
      slotSet.add(s.slot);
    }

    const characterId = body.characterId ?? null;
    if (characterId) {
      const c = (await db
        .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
        .from(characters)
        .where(eq(characters.id, characterId))
        .limit(1))[0];
      if (!c || c.userId !== me.id || c.deletedAt) {
        reply.code(403);
        return { error: "not your character" };
      }
    }
    const ownerScope: "user" | "character" = characterId ? "character" : "user";
    const ownerId = characterId ?? me.id;

    const itemKeysToCheck = body.slots
      .map((s) => s.itemKey)
      .filter((k): k is string => typeof k === "string");

    try {
      db.transaction((tx) => {
        if (itemKeysToCheck.length > 0) {
          const ownedRows = tx.select({ itemKey: identityInventory.itemKey })
            .from(identityInventory)
            .where(and(
              eq(identityInventory.ownerScope, ownerScope),
              eq(identityInventory.ownerId, ownerId),
              inArray(identityInventory.itemKey, itemKeysToCheck),
            ))
            .all();
          const owned = new Set(ownedRows.map((r) => r.itemKey));
          for (const k of itemKeysToCheck) {
            if (!owned.has(k)) {
              throw new Error(`__pin_not_owned__:${k}`);
            }
          }
          // Inverse category guard — only pets allowed here.
          const catRows = tx.select({ key: items.key, category: items.category })
            .from(items)
            .where(inArray(items.key, itemKeysToCheck))
            .all();
          for (const r of catRows) {
            if (r.category !== "pet") {
              throw new Error(`__pin_wrong_collection__:${r.key}`);
            }
          }
        }
        for (const s of body.slots) {
          if (s.itemKey === null) {
            tx.delete(identityPetCollection).where(and(
              eq(identityPetCollection.ownerScope, ownerScope),
              eq(identityPetCollection.ownerId, ownerId),
              eq(identityPetCollection.slot, s.slot),
            )).run();
          } else {
            tx.delete(identityPetCollection).where(and(
              eq(identityPetCollection.ownerScope, ownerScope),
              eq(identityPetCollection.ownerId, ownerId),
              eq(identityPetCollection.slot, s.slot),
            )).run();
            tx.insert(identityPetCollection).values({
              ownerScope,
              ownerId,
              slot: s.slot,
              itemKey: s.itemKey,
            }).run();
          }
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.startsWith("__pin_not_owned__:")) {
        reply.code(403);
        return { error: `you don't hold item "${msg.slice("__pin_not_owned__:".length)}" on this identity` };
      }
      if (msg.startsWith("__pin_wrong_collection__:")) {
        reply.code(403);
        return { error: `"${msg.slice("__pin_wrong_collection__:".length)}" isn't a pet — pin it to your Item Collection instead.` };
      }
      throw err;
    }

    return { ok: true };
  });
}

function safeParse(json: string): unknown {
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
function parseItemMessages(json: string | null | undefined): string[] {
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
 * give/throw/drop have non-empty message arrays — the dashboard +
 * command help use it to show which commands work on the item.
 */
function shapeItemCatalogRow(row: typeof items.$inferSelect, nowMs: number) {
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
 * one round trip — the dashboard reads the map indexed by the
 * currently-active character id, falling back to the master fields
 * when no character is active.
 */
function groupByCharacter<R, T>(
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
type PurchaseOutcome =
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
function runPurchaseTxn(
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
     * calling — this helper just routes the pool. When null/omitted
     * the original master-pool behavior runs.
     */
    characterId?: string | null;
  },
): PurchaseOutcome {
  return db.transaction((tx): PurchaseOutcome => {
    const v = opts.validate(tx);
    if (!v.ok) return { ok: false, status: v.status, error: v.error };
    const charId = opts.characterId ?? null;
    if (charId) {
      // Character pool debit. Lazily ensures a character_earning row
      // exists so brand-new characters can still purchase. The
      // ledger row uses scope='character' + ownerId=characterId so
      // the audit trail attributes the spend to the right identity.
      tx.insert(characterEarning).values({ characterId: charId }).onConflictDoNothing().run();
      const earning = tx.select().from(characterEarning).where(eq(characterEarning.characterId, charId)).limit(1).all()[0];
      const balance = earning?.currency ?? 0;
      if (balance < v.cost) {
        return { ok: false, status: 402, error: "insufficient funds", required: v.cost, balance };
      }
      opts.grant(tx);
      const newCurrency = balance - v.cost;
      tx.update(characterEarning).set({
        currency: newCurrency,
        updatedAt: new Date(),
      }).where(eq(characterEarning.characterId, charId)).run();
      tx.insert(earningLedger).values({
        id: nanoid(),
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
    // Master pool path — unchanged from the original behavior.
    tx.insert(userEarning).values({ userId }).onConflictDoNothing().run();
    const earning = tx.select().from(userEarning).where(eq(userEarning.userId, userId)).limit(1).all()[0];
    const balance = earning?.currency ?? 0;
    if (balance < v.cost) {
      return { ok: false, status: 402, error: "insufficient funds", required: v.cost, balance };
    }
    opts.grant(tx);
    const newCurrency = balance - v.cost;
    tx.update(userEarning).set({
      currency: newCurrency,
      updatedAt: new Date(),
    }).where(eq(userEarning.userId, userId)).run();
    tx.insert(earningLedger).values({
      id: nanoid(),
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
 * — the engine's own creditPool path emits this internally, so route
 * handlers that bypass creditPool (because they did their own
 * transactional debit) call this helper to keep the wire shape
 * consistent.
 */
async function emitWalletUpdate(
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
