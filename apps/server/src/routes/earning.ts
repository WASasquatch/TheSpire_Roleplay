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
  characters,
  cosmetics,
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

    // Owned cosmetics + currently-equipped state.
    const ownedStyleRows = await db
      .select()
      .from(userOwnedNameStyles)
      .where(eq(userOwnedNameStyles.userId, me.id));
    const ownedBorderRows = await db
      .select()
      .from(userOwnedBorders)
      .where(eq(userOwnedBorders.userId, me.id));
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
      },
      ownedStyles: ownedStyleRows.map((r) => ({
        styleKey: r.styleKey,
        configJson: r.configJson,
        acquiredAt: +r.acquiredAt,
      })),
      ownedBorders: ownedBorderRows.map((r) => ({
        rankKey: r.rankKey,
        acquiredAt: +r.acquiredAt,
      })),
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

    // Ensure the row exists before patching.
    await db.insert(userEarning).values({ userId: me.id }).onConflictDoNothing();

    const update: Partial<typeof userEarning.$inferInsert> = { updatedAt: new Date() };
    if (body.hideCurrencyCount !== undefined) update.hideCurrencyCount = body.hideCurrencyCount;
    if (body.hideXpCount !== undefined) update.hideXpCount = body.hideXpCount;
    if (body.selectedBorderRankKey !== undefined) {
      if (body.selectedBorderRankKey === null) {
        update.selectedBorderRankKey = null;
      } else {
        // Validate ownership — never accept a border the caller hasn't bought.
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

  const purchaseStyleBody = z.object({}).strict().optional();
  const patchStyleConfigBody = z.object({
    config: z.record(z.unknown()).nullable().optional(),
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
      try { purchaseStyleBody.parse(req.body ?? {}); }
      catch { reply.code(400); return { error: "invalid body" }; }

      // Entire purchase runs in one sqlite transaction so the funds
      // check, ownership insert, currency debit, and ledger insert
      // can't race against another concurrent purchase by the same
      // user. Earlier version did read → check → insert without a
      // transaction; a parallel buy could spend the same Currency
      // twice.
      const outcome = runPurchaseTxn(db, me.id, {
        validate: (tx) => {
          const style = tx.select().from(nameStyles).where(eq(nameStyles.key, req.params.key)).limit(1).all()[0];
          if (!style || !style.enabled) return { ok: false, status: 404, error: "style not found or disabled" };
          const already = tx.select().from(userOwnedNameStyles).where(and(
            eq(userOwnedNameStyles.userId, me.id),
            eq(userOwnedNameStyles.styleKey, req.params.key),
          )).limit(1).all()[0];
          if (already) return { ok: false, status: 409, error: "already owned" };
          return { ok: true, cost: style.cost };
        },
        grant: (tx) => {
          tx.insert(userOwnedNameStyles).values({
            userId: me.id,
            styleKey: req.params.key,
            configJson: null,
          }).run();
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
      await emitWalletUpdate(io, me.id, outcome.final, -outcome.cost, `purchase_${req.params.key}`);
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

      const owned = (await db
        .select()
        .from(userOwnedNameStyles)
        .where(and(eq(userOwnedNameStyles.userId, me.id), eq(userOwnedNameStyles.styleKey, req.params.key)))
        .limit(1))[0];
      if (!owned) {
        reply.code(404);
        return { error: "not owned" };
      }
      await db
        .update(userOwnedNameStyles)
        .set({ configJson: body.config ? JSON.stringify(body.config) : null })
        .where(and(eq(userOwnedNameStyles.userId, me.id), eq(userOwnedNameStyles.styleKey, req.params.key)));
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
      // Validate ownership + enabled. Ownership remains account-wide
      // so the check stays keyed on userId; the equip slot below is
      // what partitions per-identity. Disabled styles surface a
      // clean 409 rather than leaving a no-op active key on the row.
      const owned = (await db
        .select()
        .from(userOwnedNameStyles)
        .where(and(eq(userOwnedNameStyles.userId, me.id), eq(userOwnedNameStyles.styleKey, body.styleKey)))
        .limit(1))[0];
      if (!owned) { reply.code(403); return { error: "you don't own that style" }; }
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
   * Helper: has the caller ever purchased this cosmetic? We use the
   * ledger as the source of truth (immutable audit), rather than a
   * separate ownership table, so admin grants + future unique cases
   * (free promo cosmetics, etc.) all flow through the same path.
   */
  async function hasPurchased(userId: string, cosmeticKey: string): Promise<boolean> {
    const reason = `purchase_${cosmeticKey}`;
    const r = (await db
      .select({ id: earningLedger.id })
      .from(earningLedger)
      .where(and(
        eq(earningLedger.scope, "user"),
        eq(earningLedger.ownerId, userId),
        eq(earningLedger.reason, reason),
      ))
      .limit(1))[0];
    return !!r;
  }

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
      const outcome = runPurchaseTxn(db, me.id, {
        validate: (tx) => {
          const cosmetic = tx.select().from(cosmetics).where(eq(cosmetics.key, req.params.key)).limit(1).all()[0];
          if (!cosmetic || !cosmetic.enabled) return { ok: false, status: 404, error: "cosmetic not found or disabled" };
          // Ownership check via the ledger: a prior purchase row is the
          // canonical record. Looks up via a single indexed query.
          const existingPurchase = tx.select({ id: earningLedger.id }).from(earningLedger).where(and(
            eq(earningLedger.scope, "user"),
            eq(earningLedger.ownerId, me.id),
            eq(earningLedger.reason, `purchase_${req.params.key}`),
          )).limit(1).all()[0];
          if (existingPurchase) return { ok: false, status: 409, error: "already owned" };
          return { ok: true, cost: cosmetic.cost };
        },
        grant: (tx) => {
          // Auto-enable on first purchase so the buy → see-it-immediately
          // loop works without an extra equip click.
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
      await emitWalletUpdate(io, me.id, outcome.final, -outcome.cost, `purchase_${req.params.key}`);
      // Inline-avatar purchase auto-enables the cosmetic in the grant
      // step, so peers need a fresh occupant snapshot to see the new
      // avatar tile appear on the user's chat lines without reload.
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
      if (body.enabled && !(await hasPurchased(me.id, req.params.key))) {
        reply.code(403);
        return { error: "purchase required" };
      }
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
        await db
          .insert(characterEarning)
          .values({ characterId: c.id, inlineAvatarEnabled: body.enabled })
          .onConflictDoUpdate({
            target: characterEarning.characterId,
            set: { inlineAvatarEnabled: body.enabled, updatedAt: new Date() },
          });
      } else {
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

  app.post<{ Params: { rankKey: string } }>(
    "/earning/me/borders/:rankKey/purchase",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const rankKey = req.params.rankKey;

      const outcome = runPurchaseTxn(db, me.id, {
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
          // Lazy create earning row before reading peak.
          tx.insert(userEarning).values({ userId: me.id }).onConflictDoNothing().run();
          const earning = tx.select().from(userEarning).where(eq(userEarning.userId, me.id)).limit(1).all()[0]!;
          // Eligibility: peaked at this rank's Tier IV, OR climbed past
          // (peak order > target order means every lower capstone was
          // necessarily traversed).
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
          const already = tx.select().from(userOwnedBorders).where(and(
            eq(userOwnedBorders.userId, me.id),
            eq(userOwnedBorders.rankKey, rankKey),
          )).limit(1).all()[0];
          if (already) return { ok: false, status: 409, error: "already owned" };
          return { ok: true, cost: tier4.borderCost };
        },
        grant: (tx) => {
          tx.insert(userOwnedBorders).values({
            userId: me.id,
            rankKey,
          }).onConflictDoNothing().run();
          // Auto-equip on first purchase so the user sees the border
          // immediately. They can change later via PATCH
          // /earning/me/settings { selectedBorderRankKey }.
          const cur = tx.select({ selected: userEarning.selectedBorderRankKey }).from(userEarning).where(eq(userEarning.userId, me.id)).limit(1).all()[0];
          if (!cur?.selected) {
            tx.update(userEarning)
              .set({ selectedBorderRankKey: rankKey, updatedAt: new Date() })
              .where(eq(userEarning.userId, me.id))
              .run();
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
      await emitWalletUpdate(io, me.id, outcome.final, -outcome.cost, `border_purchase_${rankKey}`);
      // Border purchase auto-equips when the user has no border set
      // yet (see the `grant` step above). Refresh occupants so peers
      // see the new bordered avatar immediately. When a border was
      // already equipped the broadcast is still cheap — no occupant
      // shape changes — and the symmetry beats branching on the
      // auto-equip path.
      await rebroadcastPresenceForUser(me.id);
      return { ok: true };
    },
  );
}

function safeParse(json: string): unknown {
  try { return JSON.parse(json); } catch { return null; }
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
  },
): PurchaseOutcome {
  return db.transaction((tx): PurchaseOutcome => {
    const v = opts.validate(tx);
    if (!v.ok) return { ok: false, status: v.status, error: v.error };
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
): Promise<void> {
  const sockets = await io.fetchSockets();
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid !== userId) continue;
    s.emit("earning:earned", {
      scope: "user",
      ownerId: userId,
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
