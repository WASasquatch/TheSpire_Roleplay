/**
 * Earning routes — MUTATION / write sub-registrar.
 *
 * MOVE-ONLY split (Phase 3): the POST/PATCH/PUT endpoints below were
 * relocated verbatim out of ./earning.ts, preserving their original
 * relative order (so the local `const` bodies + hoisted helpers like
 * `hasPurchased` / `resolvePresenceTemplateField` still resolve).
 * `registerEarningRoutes` invokes this after the catalog registrar,
 * passing the shared `EarningRouteDeps`.
 */

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  normalizePresenceTemplate,
  validatePresenceTemplate,

  extractFreeformBorderVars,
  isValidFreeformBorderConfigKey,
  isValidFreeformBorderConfigValue,
  FREEFORM_CONFIG_MAX_ENTRIES,
  PET_NICKNAME_MAX_LENGTH, getRoomTransition } from "@thekeep/shared";
import {
  characterEarning,
  characterOwnedBorders,
  characterOwnedFreeformBorders,
  freeformBorders,
  userOwnedFreeformBorders,
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
} from "../../db/schema.js";
import { tFor } from "../../i18n.js";
import { getSessionUser } from "../auth.js";
import { hasPermission } from "../../auth/permissions.js";
import {
  ack as ackNotification,
  ackAllForUser,
} from "../../earning/notifications.js";
import {
  applyDiscount,
  resolveTodayFlashSale,
} from "../../earning/flashSale.js";
import { DEFAULT_SERVER_ID } from "../../earning/pool.js";
import type { EarningRouteDeps } from "./shared.js";
import {
  ackBody,
  emitWalletUpdate,
  patchSettingsBody,
  resolveTransitionForServer,
  runPurchaseTxn,
} from "./shared.js";

export async function registerEarningMutationRoutes(deps: EarningRouteDeps): Promise<void> {
  const { app, db, io, rebroadcastPresenceForUser, resolveActiveServerId, resolveSubsystemToggles } = deps;

// === ROUTES BELOW ===
  /**
   * Per-user privacy + display settings. Currently:
   *   - hideCurrencyCount: hide Currency total from others
   *   - selectedBorderRankKey: equip one of the user's owned borders
   *     (validated against `user_owned_borders`, caller can't equip
   *     what they don't own)
   */
  app.patch<{ Querystring: { serverId?: string }; Body: unknown }>("/earning/me/settings", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const sid = await resolveActiveServerId(me, req.query.serverId);
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
      await db.insert(characterEarning).values({ serverId: sid, characterId }).onConflictDoNothing();
      if (body.selectedBorderRankKey !== undefined) {
        let value: string | null = null;
        if (body.selectedBorderRankKey !== null) {
          const owned = (await db
            .select()
            .from(characterOwnedBorders)
            .where(and(
              eq(characterOwnedBorders.serverId, sid),
              eq(characterOwnedBorders.characterId, characterId),
              eq(characterOwnedBorders.rankKey, body.selectedBorderRankKey),
            ))
            .limit(1))[0];
          if (!owned) {
            reply.code(403);
            return { error: tFor(me.locale, "errors:server.earning.characterDoesntOwnBorder") };
          }
          value = body.selectedBorderRankKey;
        }
        await db
          .update(characterEarning)
          .set({ selectedBorderRankKey: value, updatedAt: new Date() })
          .where(and(eq(characterEarning.serverId, sid), eq(characterEarning.characterId, characterId)));
      }
      if (body.selectedFreeformBorderKey !== undefined) {
        let value: string | null = null;
        if (body.selectedFreeformBorderKey !== null) {
          // Ownership check against character_owned_freeform_borders.
          // Master's ownership doesn't satisfy, borders here are
          // per-identity even when the underlying catalog row is the
          // same. Same per-identity partition as rank-tier borders.
          const owned = (await db
            .select()
            .from(characterOwnedFreeformBorders)
            .where(and(
              eq(characterOwnedFreeformBorders.serverId, sid),
              eq(characterOwnedFreeformBorders.characterId, characterId),
              eq(characterOwnedFreeformBorders.borderKey, body.selectedFreeformBorderKey),
            ))
            .limit(1))[0];
          if (!owned) {
            reply.code(403);
            return { error: tFor(me.locale, "errors:server.earning.characterDoesntOwnBorder") };
          }
          value = body.selectedFreeformBorderKey;
        }
        await db
          .update(characterEarning)
          .set({ selectedFreeformBorderKey: value, updatedAt: new Date() })
          .where(and(eq(characterEarning.serverId, sid), eq(characterEarning.characterId, characterId)));
      }
      await rebroadcastPresenceForUser(me.id);
      return { ok: true };
    }

    // Master path, unchanged behavior.
    await db.insert(userEarning).values({ serverId: sid, userId: me.id }).onConflictDoNothing();

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
            eq(userOwnedBorders.serverId, sid),
            eq(userOwnedBorders.userId, me.id),
            eq(userOwnedBorders.rankKey, body.selectedBorderRankKey),
          ))
          .limit(1))[0];
        if (!owned) {
          reply.code(403);
          return { error: tFor(me.locale, "errors:server.earning.dontOwnBorder") };
        }
        update.selectedBorderRankKey = body.selectedBorderRankKey;
      }
    }
    if (body.selectedFreeformBorderKey !== undefined) {
      if (body.selectedFreeformBorderKey === null) {
        update.selectedFreeformBorderKey = null;
      } else {
        const owned = (await db
          .select()
          .from(userOwnedFreeformBorders)
          .where(and(
            eq(userOwnedFreeformBorders.serverId, sid),
            eq(userOwnedFreeformBorders.userId, me.id),
            eq(userOwnedFreeformBorders.borderKey, body.selectedFreeformBorderKey),
          ))
          .limit(1))[0];
        if (!owned) {
          reply.code(403);
          return { error: tFor(me.locale, "errors:server.earning.dontOwnBorder") };
        }
        update.selectedFreeformBorderKey = body.selectedFreeformBorderKey;
      }
    }
    if (Object.keys(update).length === 1) return { ok: true }; // only updatedAt, nothing to do
    await db.update(userEarning).set(update).where(and(eq(userEarning.serverId, sid), eq(userEarning.userId, me.id)));
    // Border equip changes the bordered-avatar rendering on every line
    // this user appears on, so peers need a fresh occupant snapshot to
    // see it without a refresh. hideCurrencyCount / hideXpCount only
    // affect the dashboard view (not occupants), so the broadcast is a
    // no-op for those, cheap regardless since the function early-exits
    // when the user has no live sockets.
    if (body.selectedBorderRankKey !== undefined || body.selectedFreeformBorderKey !== undefined) {
      await rebroadcastPresenceForUser(me.id);
    }
    return { ok: true };
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

  /* =========================================================
   *  Name styles, purchase / config / equip
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
   *      already-owned style. Body is opaque JSON, the renderer
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
     * Each identity owns separately, Kaal buying Embers does NOT
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
    /** Same scoping rule as equipStyleBody, null/omitted = master. */
    characterId: z.string().nullable().optional(),
  }).strict();

  app.post<{ Params: { key: string }; Querystring: { serverId?: string }; Body: unknown }>(
    "/earning/me/name-styles/:key/purchase",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const sid = await resolveActiveServerId(me, req.query.serverId);
      // Per-server subsystem toggle (migration 0293): name styles can be turned
      // off for this server. Equips of already-owned styles stay allowed; only
      // the PURCHASE is gated. DEFAULT_SERVER_ID / flag-off → ON, never rejects.
      if (!(await resolveSubsystemToggles(sid)).nameStyles) {
        reply.code(403); return { error: "subsystem_disabled" };
      }
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

      // Resolve today's flash sale OUTSIDE the txn (resolveTodayFlashSale
      // may lazy-insert the day's row, which has to be async). Inside
      // validate() the lookup against this snapshot is a pure compare,
      // if the user is buying today's pick, the discount applies. Scoped to
      // the active server `sid` so the sale matches THIS server's catalog
      // (migration 0299; flag off → DEFAULT_SERVER_ID, byte-identical).
      const flashSale = await resolveTodayFlashSale(db, new Date(), sid);
      // Entire purchase runs in one sqlite transaction so the funds
      // check, ownership insert, currency debit, and ledger insert
      // can't race. Per-identity scope routes to the right ownership
      // table (`user_owned_*` for master, `character_owned_*` for a
      // character) and debits the matching pool — all on the active
      // server `sid` (migrations 0295-0299; flag off → DEFAULT_SERVER_ID).
      const outcome = runPurchaseTxn(db, me.id, {
        characterId,
        serverId: sid,
        validate: (tx) => {
          const style = tx.select().from(nameStyles).where(and(eq(nameStyles.serverId, sid), eq(nameStyles.key, req.params.key))).limit(1).all()[0];
          if (!style || !style.enabled) return { ok: false, status: 404, error: "style not found or disabled" };
          if (characterId) {
            const already = tx.select().from(characterOwnedNameStyles).where(and(
              eq(characterOwnedNameStyles.serverId, sid),
              eq(characterOwnedNameStyles.characterId, characterId),
              eq(characterOwnedNameStyles.styleKey, req.params.key),
            )).limit(1).all()[0];
            if (already) return { ok: false, status: 409, error: "already owned" };
          } else {
            const already = tx.select().from(userOwnedNameStyles).where(and(
              eq(userOwnedNameStyles.serverId, sid),
              eq(userOwnedNameStyles.userId, me.id),
              eq(userOwnedNameStyles.styleKey, req.params.key),
            )).limit(1).all()[0];
            if (already) return { ok: false, status: 409, error: "already owned" };
          }
          // Flash-sale discount: only when this exact key is today's
          // pick. Server-authoritative, the client's "Buy" button
          // shows the discounted price for UX, but the actual cost
          // is recomputed here so a stale client can't claim a
          // discount on a row that isn't on sale.
          const cost = flashSale.nameStyleKey === req.params.key
            ? applyDiscount(style.cost, flashSale.nameStyleDiscountPct)
            : style.cost;
          return { ok: true, cost };
        },
        grant: (tx) => {
          if (characterId) {
            tx.insert(characterOwnedNameStyles).values({
              serverId: sid,
              characterId,
              styleKey: req.params.key,
              configJson: null,
            }).run();
          } else {
            tx.insert(userOwnedNameStyles).values({
              serverId: sid,
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

  app.patch<{ Params: { key: string }; Querystring: { serverId?: string }; Body: unknown }>(
    "/earning/me/name-styles/:key/config",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const sid = await resolveActiveServerId(me, req.query.serverId);
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
            eq(characterOwnedNameStyles.serverId, sid),
            eq(characterOwnedNameStyles.characterId, characterId),
            eq(characterOwnedNameStyles.styleKey, req.params.key),
          ))
          .limit(1))[0];
        if (!owned) { reply.code(404); return { error: "not owned" }; }
        await db
          .update(characterOwnedNameStyles)
          .set({ configJson: body.config ? JSON.stringify(body.config) : null })
          .where(and(
            eq(characterOwnedNameStyles.serverId, sid),
            eq(characterOwnedNameStyles.characterId, characterId),
            eq(characterOwnedNameStyles.styleKey, req.params.key),
          ));
      } else {
        const owned = (await db
          .select()
          .from(userOwnedNameStyles)
          .where(and(eq(userOwnedNameStyles.serverId, sid), eq(userOwnedNameStyles.userId, me.id), eq(userOwnedNameStyles.styleKey, req.params.key)))
          .limit(1))[0];
        if (!owned) { reply.code(404); return { error: "not owned" }; }
        await db
          .update(userOwnedNameStyles)
          .set({ configJson: body.config ? JSON.stringify(body.config) : null })
          .where(and(eq(userOwnedNameStyles.serverId, sid), eq(userOwnedNameStyles.userId, me.id), eq(userOwnedNameStyles.styleKey, req.params.key)));
      }
      // Style config (colors / glow / outline) feeds straight into the
      // occupant payload's `activeStyleConfig`, so a refresh here lands
      // the tweak live without a peer-side reload.
      await rebroadcastPresenceForUser(me.id);
      return { ok: true };
    },
  );

  app.post<{ Querystring: { serverId?: string }; Body: unknown }>("/earning/me/active-name-style", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const sid = await resolveActiveServerId(me, req.query.serverId);
    let body: z.infer<typeof equipStyleBody>;
    try { body = equipStyleBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

    if (body.styleKey) {
      // Ownership check scoped to the same identity we're about to
      // equip on. Master/OOC reads user_owned_name_styles; per-
      // character reads character_owned_name_styles. The same
      // styleKey can be owned by one identity and not the other
      // since migration 0086, so a master's purchase does NOT let
      // a character equip the same style, they have to buy it
      // from their own pool.
      if (body.characterId) {
        const owned = (await db
          .select()
          .from(characterOwnedNameStyles)
          .where(and(
            eq(characterOwnedNameStyles.serverId, sid),
            eq(characterOwnedNameStyles.characterId, body.characterId),
            eq(characterOwnedNameStyles.styleKey, body.styleKey),
          ))
          .limit(1))[0];
        if (!owned) { reply.code(403); return { error: tFor(me.locale, "errors:server.earning.characterDoesntOwnStyle") }; }
      } else {
        const owned = (await db
          .select()
          .from(userOwnedNameStyles)
          .where(and(eq(userOwnedNameStyles.serverId, sid), eq(userOwnedNameStyles.userId, me.id), eq(userOwnedNameStyles.styleKey, body.styleKey)))
          .limit(1))[0];
        if (!owned) { reply.code(403); return { error: tFor(me.locale, "errors:server.earning.dontOwnStyle") }; }
      }
      const style = (await db
        .select({ enabled: nameStyles.enabled })
        .from(nameStyles)
        .where(and(eq(nameStyles.serverId, sid), eq(nameStyles.key, body.styleKey)))
        .limit(1))[0];
      if (!style || !style.enabled) { reply.code(409); return { error: "style disabled" }; }
    }

    if (body.characterId) {
      // Character scope, validate the caller actually owns the
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
        .values({ serverId: sid, characterId: c.id, activeNameStyleKey: body.styleKey })
        .onConflictDoUpdate({
          // PK is now (server_id, character_id) — the conflict target must
          // be the full composite key or the upsert would never match.
          target: [characterEarning.serverId, characterEarning.characterId],
          set: { activeNameStyleKey: body.styleKey, updatedAt: new Date() },
        });
    } else {
      // Master/OOC scope, lazy upsert on user_active_cosmetics.
      const existing = (await db
        .select()
        .from(userActiveCosmetics)
        .where(and(eq(userActiveCosmetics.serverId, sid), eq(userActiveCosmetics.userId, me.id)))
        .limit(1))[0];
      if (existing) {
        await db.update(userActiveCosmetics).set({
          activeNameStyleKey: body.styleKey,
          updatedAt: new Date(),
        }).where(and(eq(userActiveCosmetics.serverId, sid), eq(userActiveCosmetics.userId, me.id)));
      } else {
        await db.insert(userActiveCosmetics).values({
          serverId: sid,
          userId: me.id,
          activeNameStyleKey: body.styleKey,
        });
      }
    }
    // Refresh occupant presence so every room the user is parked in
    // picks up the new style on the next render, without this the
    // equip didn't take effect until peers refreshed.
    await rebroadcastPresenceForUser(me.id);
    return { ok: true };
  });

  /* =========================================================
   *  Cosmetics, inline_avatar (Phase 4)
   *
   *  Two endpoints back the dashboard's Cosmetics section:
   *
   *    POST /earning/me/cosmetics/inline_avatar/purchase
   *      Atomic Currency debit + grants the right to equip. We
   *      record ownership by setting `inline_avatar_enabled = 1`
   *      lazily on first purchase, there's no separate "owned but
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
    /** Same scoping rule as the name-style equip endpoint,
     *  null/omitted writes the master/OOC slot on
     *  user_active_cosmetics; a character id writes that
     *  character's character_earning row. */
    characterId: z.string().nullable().optional(),
  }).strict();

  /**
   * Helper: has this identity (master user OR character) ever
   * purchased this cosmetic? We use the ledger as the source of
   * truth, `scope` + `ownerId` partition by identity, so each
   * character has its own "ever purchased" history. Admin grants
   * and free promo cosmetics still flow through the same ledger
   * insert.
   */
  async function hasPurchased(
    scope: "user" | "character",
    ownerId: string,
    cosmeticKey: string,
    // Per-server economy: cosmetics are owned per server (the purchase ledger
    // row carries the server_id). This pass keys ownership to the default
    // (active) server; with the servers flag off it's the only pool, so the
    // "already owned" gate behaves exactly as today.
    serverId: string = DEFAULT_SERVER_ID,
  ): Promise<boolean> {
    const reason = `purchase_${cosmeticKey}`;
    const r = (await db
      .select({ id: earningLedger.id })
      .from(earningLedger)
      .where(and(
        eq(earningLedger.serverId, serverId),
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

  /**
   * Cosmetic keys this endpoint accepts. `rank_border` is the
   * placeholder row whose purchase goes through the per-rank border
   * endpoint instead (price lives on rank_tiers.borderCost), so it's
   * intentionally excluded here. Adding a new purchasable Flair
   * cosmetic = add its key here and decide whether it needs a
   * grant-side side-effect in the switch below.
   */
  /** Cosmetics buyable through the standard /earning/me/cosmetics/
   *  :key/purchase endpoint. Each one is a ONE-TIME unlock,
   *  re-purchase returns 409. `flair_reaction_sheet` is NOT in
   *  this set on purpose: each submission re-pays via its own
   *  endpoint (POST /me/emoticon-submissions), so the standard
   *  endpoint's "already owned" check would lock out the second
   *  submission. */
  const PURCHASABLE_COSMETIC_KEYS = new Set<string>([
    "inline_avatar",
    "flair_profile_banner",
    "flair_typing_phrase",
    "flair_lurking_master",
    "flair_room_presence",
    "flair_session_presence",
    // Migration 0192, profile-customization flairs. Without these
    // in the allowlist, the catalog row + admin card + ledger
    // schema all exist but the POST /earning/me/cosmetics/:key/
    // purchase handler's first gate returns "unknown cosmetic key"
    // and the Buy button is dead. The downstream handler steps
    // (cosmetic-row lookup, existing-purchase check keyed off
    // `purchase_${key}`, wallet charge, ledger insert) are generic
    // and need no other server changes for these two SKUs.
    "flair_profile_visitors",
    "flair_profile_marquee",
    // Spire Arcade — one-time unlock for the Eidolon Tamer game. Bare
    // ledger unlock (no toggle slot); the arcade routes gate on the
    // `purchase_flair_eidolon_tamer` ledger row.
    "flair_eidolon_tamer",
    // Spire Arcade — one-time unlock for Urugal's Descent (game #2). Same
    // bare-ledger-unlock shape; the urugal routes gate on the
    // `purchase_flair_urugal_descent` ledger row.
    "flair_urugal_descent",
    // Spire Arcade — one-time unlock for the Grimhold cabinet (game #3, six
    // games). Same bare-ledger-unlock shape; the grimhold routes gate on the
    // `purchase_flair_grimhold` ledger row.
    "flair_grimhold",
  ]);

  app.post<{ Params: { key: string }; Querystring: { serverId?: string }; Body: unknown }>(
    "/earning/me/cosmetics/:key/purchase",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const sid = await resolveActiveServerId(me, req.query.serverId);
      // Per-server subsystem toggle (migration 0293): cosmetics can be off for
      // this server. Equip of an owned cosmetic stays allowed; the PURCHASE is
      // gated. DEFAULT_SERVER_ID / flag-off → ON.
      if (!(await resolveSubsystemToggles(sid)).cosmetics) {
        reply.code(403); return { error: "subsystem_disabled" };
      }
      if (!PURCHASABLE_COSMETIC_KEYS.has(req.params.key)) {
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
      // Scoped to the active server `sid` (migration 0299; flag off →
      // DEFAULT_SERVER_ID, byte-identical) so the discount matches this
      // server's sale picks.
      const flashSale = await resolveTodayFlashSale(db, new Date(), sid);
      const outcome = runPurchaseTxn(db, me.id, {
        characterId,
        serverId: sid,
        validate: (tx) => {
          const cosmetic = tx.select().from(cosmetics).where(and(eq(cosmetics.serverId, sid), eq(cosmetics.key, req.params.key))).limit(1).all()[0];
          if (!cosmetic || !cosmetic.enabled) return { ok: false, status: 404, error: "cosmetic not found or disabled" };
          // Per-identity ownership check. Master's prior purchase
          // does NOT count as ownership for a character (and vice
          // versa), each identity has its own ledger trail.
          const existingPurchase = characterId
            ? tx.select({ id: earningLedger.id }).from(earningLedger).where(and(
                eq(earningLedger.serverId, sid),
                eq(earningLedger.scope, "character"),
                eq(earningLedger.ownerId, characterId),
                eq(earningLedger.reason, `purchase_${req.params.key}`),
              )).limit(1).all()[0]
            : tx.select({ id: earningLedger.id }).from(earningLedger).where(and(
                eq(earningLedger.serverId, sid),
                eq(earningLedger.scope, "user"),
                eq(earningLedger.ownerId, me.id),
                eq(earningLedger.reason, `purchase_${req.params.key}`),
              )).limit(1).all()[0];
          if (existingPurchase) return { ok: false, status: 409, error: "already owned" };
          // Flash-sale discount when this cosmetic is today's pick.
          const cost = flashSale.cosmeticKey === req.params.key
            ? applyDiscount(cosmetic.cost, flashSale.cosmeticDiscountPct)
            : cosmetic.cost;
          return { ok: true, cost };
        },
        grant: (tx) => {
          // Side-effect on first purchase depends on the cosmetic:
          //   - inline_avatar  → auto-enable the toggle so the cosmetic
          //                      is visible immediately (no second click
          //                      to equip).
          //   - flair_profile_banner → just record the purchase via the
          //                      ledger; URL slot stays null until the
          //                      user pastes one via PATCH /earning/me/banner.
          //                      No row-state change needed beyond the
          //                      ledger insert that `runPurchaseTxn` does.
          if (req.params.key !== "inline_avatar") return;
          if (characterId) {
            tx.insert(characterEarning).values({ serverId: sid, characterId, inlineAvatarEnabled: true }).onConflictDoUpdate({
              target: [characterEarning.serverId, characterEarning.characterId],
              set: { inlineAvatarEnabled: true, updatedAt: new Date() },
            }).run();
          } else {
            const existing = tx.select().from(userActiveCosmetics).where(and(eq(userActiveCosmetics.serverId, sid), eq(userActiveCosmetics.userId, me.id))).limit(1).all()[0];
            if (existing) {
              tx.update(userActiveCosmetics)
                .set({ inlineAvatarEnabled: true, updatedAt: new Date() })
                .where(and(eq(userActiveCosmetics.serverId, sid), eq(userActiveCosmetics.userId, me.id)))
                .run();
            } else {
              tx.insert(userActiveCosmetics).values({
                serverId: sid,
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

  /** Cosmetic keys that have an "on/off" per-identity toggle on
   *  either `user_active_cosmetics` or `character_earning`. Each
   *  one routes to its own column via TOGGLE_COLUMN_BY_KEY below.
   *  Adding a new toggle-style Flair cosmetic = add the key here
   *  + the column descriptor below + the migration that creates
   *  the column. The equip endpoint validates membership before
   *  doing anything. */
  const TOGGLEABLE_COSMETIC_KEYS = new Set<string>([
    "inline_avatar",
    "flair_lurking_master",
  ]);

  /** Column mapping for each toggleable cosmetic. The master row
   *  field lives on `user_active_cosmetics`; the per-character
   *  field on `character_earning`. */
  const TOGGLE_COLUMNS: Record<string, {
    masterField: "inlineAvatarEnabled" | "lurkingMasterEnabled";
    characterField: "inlineAvatarEnabled" | "lurkingMasterEnabled";
  }> = {
    inline_avatar: {
      masterField: "inlineAvatarEnabled",
      characterField: "inlineAvatarEnabled",
    },
    flair_lurking_master: {
      masterField: "lurkingMasterEnabled",
      characterField: "lurkingMasterEnabled",
    },
  };

  app.post<{ Params: { key: string }; Querystring: { serverId?: string }; Body: unknown }>(
    "/earning/me/cosmetics/:key/equip",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const sid = await resolveActiveServerId(me, req.query.serverId);
      const key = req.params.key;
      if (!TOGGLEABLE_COSMETIC_KEYS.has(key)) {
        // Distinct from the purchase endpoint's identical-looking
        // 404, the equip surface is a narrower allowlist (only
        // cosmetics with a boolean equip slot belong here). Phrasing
        // it separately so future "unknown cosmetic key" debugging
        // doesn't conflate the two paths: a purchase-side miss
        // means the catalog forgot the SKU, an equip-side miss
        // means the SKU exists but isn't toggleable (configured via
        // dedicated PATCH endpoints instead, e.g. the profile
        // flairs land on /me/profile-flair, not here).
        reply.code(404);
        return { error: "cosmetic is not toggleable" };
      }
      const cols = TOGGLE_COLUMNS[key]!;
      let body: z.infer<typeof equipCosmeticBody>;
      try { body = equipCosmeticBody.parse(req.body); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
      // Per-identity purchase check, character-scoped equip requires
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
        if (body.enabled && !(await hasPurchased("character", body.characterId, key, sid))) {
          reply.code(403);
          return { error: tFor(me.locale, "errors:server.earning.characterHasntPurchased") };
        }
        await db
          .insert(characterEarning)
          .values({ serverId: sid, characterId: c.id, [cols.characterField]: body.enabled })
          .onConflictDoUpdate({
            target: [characterEarning.serverId, characterEarning.characterId],
            set: { [cols.characterField]: body.enabled, updatedAt: new Date() },
          });
      } else {
        if (body.enabled && !(await hasPurchased("user", me.id, key, sid))) {
          reply.code(403);
          return { error: "purchase required" };
        }
        const existing = (await db
          .select()
          .from(userActiveCosmetics)
          .where(and(eq(userActiveCosmetics.serverId, sid), eq(userActiveCosmetics.userId, me.id)))
          .limit(1))[0];
        if (existing) {
          await db.update(userActiveCosmetics)
            .set({ [cols.masterField]: body.enabled, updatedAt: new Date() })
            .where(and(eq(userActiveCosmetics.serverId, sid), eq(userActiveCosmetics.userId, me.id)));
        } else {
          await db.insert(userActiveCosmetics).values({
            serverId: sid,
            userId: me.id,
            [cols.masterField]: body.enabled,
          });
        }
      }
      // Toggle changes whether the avatar tile renders next to the
      // user's name on every chat line, peers need a fresh occupant
      // snapshot or the change waits until the next presence event.
      // (Lurking Master doesn't affect occupants directly, its
      // effect is on the typing-indicator broadcast, but
      // rebroadcasting is harmless and keeps the code path uniform.)
      await rebroadcastPresenceForUser(me.id);
      return { ok: true };
    },
  );

  /* =========================================================
   *  Room transitions (migration 0219)
   *
   *  Per-identity purchasable + equippable, exactly like name styles
   *  (buy individual keys, equip ONE). The catalog (cost/rarity) lives
   *  in shared `ROOM_TRANSITIONS`; ownership is the earning ledger
   *  (`purchase_transition_<key>`). The effect is self-only (other
   *  users never see it), so equipping does NOT rebroadcast presence.
   * ========================================================= */
  app.post<{ Params: { key: string }; Querystring: { serverId?: string }; Body: unknown }>(
    "/earning/me/transitions/:key/purchase",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      if (!(await hasPermission(me, "use_room_transitions", db))) {
        reply.code(403); return { error: tFor(me.locale, "errors:server.earning.transitionsUnavailable") };
      }
      const sid = await resolveActiveServerId(me, req.query.serverId);
      // Per-server subsystem toggle (migration 0293): room transitions can be
      // off for this server. Equip of an owned transition stays allowed; the
      // PURCHASE is gated. DEFAULT_SERVER_ID / flag-off → ON.
      if (!(await resolveSubsystemToggles(sid)).roomTransitions) {
        reply.code(403); return { error: "subsystem_disabled" };
      }
      // Per-server pricing/availability (migrations 0295-0299): cost + enabled
      // come from THIS server's `room_transitions` row (const default when the
      // server hasn't seeded one); label stays in the shared const. A disabled
      // or zero-cost transition isn't sellable on this server.
      const transition = await resolveTransitionForServer(db, sid, req.params.key);
      if (!transition) { reply.code(404); return { error: "unknown transition" }; }
      if (!transition.enabled) { reply.code(409); return { error: tFor(me.locale, "errors:server.earning.transitionUnavailable") }; }
      if (transition.cost <= 0) { reply.code(409); return { error: tFor(me.locale, "errors:server.earning.transitionFree") }; }
      let body: z.infer<typeof purchaseCosmeticBody> | undefined;
      try { body = purchaseCosmeticBody.parse(req.body ?? {}); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const characterId = body?.characterId ?? null;
      if (characterId) {
        const c = (await db
          .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
          .from(characters).where(eq(characters.id, characterId)).limit(1))[0];
        if (!c || c.userId !== me.id || c.deletedAt) { reply.code(403); return { error: "not your character" }; }
      }
      const reason = `purchase_transition_${transition.key}`;
      const outcome = runPurchaseTxn(db, me.id, {
        characterId,
        serverId: sid,
        validate: (tx) => {
          const existing = characterId
            ? tx.select({ id: earningLedger.id }).from(earningLedger).where(and(
                eq(earningLedger.serverId, sid),
                eq(earningLedger.scope, "character"),
                eq(earningLedger.ownerId, characterId),
                eq(earningLedger.reason, reason),
              )).limit(1).all()[0]
            : tx.select({ id: earningLedger.id }).from(earningLedger).where(and(
                eq(earningLedger.serverId, sid),
                eq(earningLedger.scope, "user"),
                eq(earningLedger.ownerId, me.id),
                eq(earningLedger.reason, reason),
              )).limit(1).all()[0];
          if (existing) return { ok: false, status: 409, error: "already owned" };
          return { ok: true, cost: transition.cost };
        },
        grant: (tx) => {
          // Ensure a character_earning row exists so the purchase surfaces in
          // /earning/me's byCharacter map (and a later equip can land). The
          // ledger row that runPurchaseTxn writes IS the ownership record.
          if (characterId) {
            tx.insert(characterEarning).values({ serverId: sid, characterId }).onConflictDoNothing().run();
          }
        },
        reason,
        metadata: { kind: "room_transition", transitionKey: transition.key },
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
        reason,
        characterId ? { scope: "character", ownerId: characterId } : { scope: "user" },
      );
      return { ok: true };
    },
  );

  const equipTransitionBody = z.object({
    key: z.string().nullable().optional(),
    characterId: z.string().nullable().optional(),
  }).strict();

  app.post<{ Querystring: { serverId?: string }; Body: unknown }>("/earning/me/active-room-transition", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "use_room_transitions", db))) {
      reply.code(403); return { error: tFor(me.locale, "errors:server.earning.transitionsUnavailable") };
    }
    const sid = await resolveActiveServerId(me, req.query.serverId);
    let body: z.infer<typeof equipTransitionBody>;
    try { body = equipTransitionBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const key = body.key ?? null;
    const characterId = body.characterId ?? null;
    // null clears (→ instant). A non-null key must be in the catalog AND owned
    // by THIS identity. Nothing is free anymore, so every key requires a
    // purchase row for the equipping identity.
    if (key !== null) {
      if (!getRoomTransition(key)) { reply.code(404); return { error: "unknown transition" }; }
      const scope: "user" | "character" = characterId ? "character" : "user";
      const ownerId = characterId ?? me.id;
      if (!(await hasPurchased(scope, ownerId, `transition_${key}`, sid))) {
        reply.code(403); return { error: tFor(me.locale, "errors:server.earning.dontOwnTransition") };
      }
    }
    if (characterId) {
      const c = (await db
        .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
        .from(characters).where(eq(characters.id, characterId)).limit(1))[0];
      if (!c || c.userId !== me.id || c.deletedAt) { reply.code(403); return { error: "not your character" }; }
      await db
        .insert(characterEarning)
        .values({ serverId: sid, characterId: c.id, activeRoomTransitionKey: key })
        .onConflictDoUpdate({
          target: [characterEarning.serverId, characterEarning.characterId],
          set: { activeRoomTransitionKey: key, updatedAt: new Date() },
        });
    } else {
      const existing = (await db
        .select().from(userActiveCosmetics).where(and(eq(userActiveCosmetics.serverId, sid), eq(userActiveCosmetics.userId, me.id))).limit(1))[0];
      if (existing) {
        await db.update(userActiveCosmetics)
          .set({ activeRoomTransitionKey: key, updatedAt: new Date() })
          .where(and(eq(userActiveCosmetics.serverId, sid), eq(userActiveCosmetics.userId, me.id)));
      } else {
        await db.insert(userActiveCosmetics).values({ serverId: sid, userId: me.id, activeRoomTransitionKey: key });
      }
    }
    return { ok: true };
  });

  /* =========================================================
   *  Profile Banner, set / clear the URL slot
   *
   *  Gated by ownership of the `flair_profile_banner` cosmetic on
   *  the identity being written. Per-identity: master writes its own
   *  banner URL onto `user_active_cosmetics.profile_banner_url`,
   *  character writes onto `character_earning.profile_banner_url`.
   *
   *  Validation:
   *    - URL must be empty (clears) or absolute http/https
   *    - HEAD-sniff content-type begins with `image/` (soft check;
   *      5s timeout, network failure does NOT block, many image
   *      hosts reject HEAD or hot-link checks, and we'd rather let
   *      the user equip a working image than fail closed on a
   *      finicky CDN).
   *    - Length capped at 1024 so a malformed paste can't bloat the
   *      row.
   *
   *  Returns the post-write URL so the client can update store
   *  optimistically and discover any server-side normalization.
   * ========================================================= */

  const setBannerBody = z.object({
    /** Null or empty string clears the slot. Otherwise absolute http(s) URL. */
    url: z.string().max(1024).nullable(),
    /** Per-identity scope: null = master/OOC, character id = that character's banner. */
    characterId: z.string().nullable().optional(),
  }).strict();

  app.patch<{ Querystring: { serverId?: string }; Body: unknown }>("/earning/me/banner", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const sid = await resolveActiveServerId(me, req.query.serverId);
    let body: z.infer<typeof setBannerBody>;
    try { body = setBannerBody.parse(req.body); }
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
    // Trim + normalize. Empty string and null both mean "clear".
    const trimmed = (body.url ?? "").trim();
    const final: string | null = trimmed.length === 0 ? null : trimmed;
    if (final !== null) {
      // Cheap shape check before we even consider the network sniff,
      // bare paths, javascript:, data:, and other non-http URLs are
      // rejected here so we don't hand them to the URL parser at all.
      if (!/^https?:\/\//i.test(final)) {
        reply.code(400);
        return { error: tFor(me.locale, "errors:server.earning.bannerUrlScheme") };
      }
      // Ownership gate is required only when SETTING (not clearing).
      // A user who lost the cosmetic via admin revoke can still clear
      // their stale banner; they just can't set a new one.
      const scope: "user" | "character" = characterId ? "character" : "user";
      const ownerId = characterId ?? me.id;
      if (!(await hasPurchased(scope, ownerId, "flair_profile_banner", sid))) {
        reply.code(403);
        return { error: tFor(me.locale, "errors:server.earning.purchaseBannerFirst") };
      }
      // Soft content-type sniff. Best-effort: failed fetch is treated
      // as "let it through" because many image hosts (S3, Cloudinary,
      // some CDNs) reject HEAD with 405 or return no content-type.
      // The eventual `<img>` render fails gracefully if the URL isn't
      // actually an image, so this gate is for clearly-non-image
      // mistakes (text/html, application/json) more than a security
      // boundary.
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const r = await fetch(final, { method: "HEAD", signal: controller.signal, redirect: "follow" });
        clearTimeout(timer);
        const ct = r.headers.get("content-type") ?? "";
        if (r.ok && ct && !ct.startsWith("image/")) {
          reply.code(400);
          return { error: tFor(me.locale, "errors:server.earning.bannerNotImage", { contentType: ct }) };
        }
      } catch {
        // Network blip, CORS, abort, server hates HEAD, allow.
      }
    }
    if (characterId) {
      await db
        .insert(characterEarning)
        .values({ serverId: sid, characterId, profileBannerUrl: final })
        .onConflictDoUpdate({
          target: [characterEarning.serverId, characterEarning.characterId],
          set: { profileBannerUrl: final, updatedAt: new Date() },
        });
    } else {
      const existing = (await db
        .select()
        .from(userActiveCosmetics)
        .where(and(eq(userActiveCosmetics.serverId, sid), eq(userActiveCosmetics.userId, me.id)))
        .limit(1))[0];
      if (existing) {
        await db.update(userActiveCosmetics)
          .set({ profileBannerUrl: final, updatedAt: new Date() })
          .where(and(eq(userActiveCosmetics.serverId, sid), eq(userActiveCosmetics.userId, me.id)));
      } else {
        await db.insert(userActiveCosmetics).values({
          serverId: sid,
          userId: me.id,
          profileBannerUrl: final,
        });
      }
    }
    return { ok: true, url: final };
  });

  /* =========================================================
   *  Custom Typing Phrase, set / clear the phrase slot
   *
   *  Twin of the banner endpoint above. Gated by ownership of
   *  `flair_typing_phrase` on the identity being written. Per-
   *  identity: master writes onto `user_earning.typing_phrase`,
   *  character writes onto `character_earning.typing_phrase`.
   *
   *  Validation:
   *    - Empty / null clears the slot.
   *    - Non-empty trimmed length must be 1..60 chars.
   *    - Linebreaks, NUL, and other control characters are
   *      stripped (the indicator strip is a single inline run).
   *    - No HTML, the renderer text-escapes everything.
   *
   *  Returns the post-write phrase so the client can update store
   *  optimistically and discover any server-side normalization
   *  (trimming, control-char strip).
   * ========================================================= */

  /** Hard cap. Indicator strip width starts to break around 60 chars
   *  on mobile; better to enforce here than rely on CSS truncation. */
  const TYPING_PHRASE_MAX = 60;

  const setTypingPhraseBody = z.object({
    /** Null or empty/whitespace string clears the slot. */
    phrase: z.string().max(200).nullable(),
    /** Per-identity scope: null = master/OOC, character id = that character's phrase. */
    characterId: z.string().nullable().optional(),
  }).strict();

  app.patch<{ Querystring: { serverId?: string }; Body: unknown }>("/earning/me/typing-phrase", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const sid = await resolveActiveServerId(me, req.query.serverId);
    let body: z.infer<typeof setTypingPhraseBody>;
    try { body = setTypingPhraseBody.parse(req.body); }
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
    // Normalize. Trim outer whitespace, strip control chars + line
    // breaks (the indicator is single-line), collapse interior runs
    // of whitespace so a pasted multi-space string doesn't smear.
    // Empty after normalization == clear.
    const raw = body.phrase ?? "";
    const cleaned = raw
      .replace(/[ -]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const final: string | null = cleaned.length === 0 ? null : cleaned;
    if (final !== null) {
      if (final.length > TYPING_PHRASE_MAX) {
        reply.code(400);
        return { error: tFor(me.locale, "errors:server.earning.phraseTooLong", { max: TYPING_PHRASE_MAX }) };
      }
      // Ownership gate only when SETTING (clearing is always allowed
      //, a user whose flair was revoked can still drop their stale
      // phrase). Same pattern as the banner.
      const scope: "user" | "character" = characterId ? "character" : "user";
      const ownerId = characterId ?? me.id;
      if (!(await hasPurchased(scope, ownerId, "flair_typing_phrase", sid))) {
        reply.code(403);
        return { error: tFor(me.locale, "errors:server.earning.purchaseTypingFirst") };
      }
    }
    if (characterId) {
      await db
        .insert(characterEarning)
        .values({ serverId: sid, characterId, typingPhrase: final })
        .onConflictDoUpdate({
          target: [characterEarning.serverId, characterEarning.characterId],
          set: { typingPhrase: final, updatedAt: new Date() },
        });
    } else {
      await db
        .insert(userEarning)
        .values({ serverId: sid, userId: me.id, typingPhrase: final })
        .onConflictDoUpdate({
          target: [userEarning.serverId, userEarning.userId],
          set: { typingPhrase: final, updatedAt: new Date() },
        });
    }
    return { ok: true, phrase: final };
  });

  /* =========================================================
   *  Presence broadcast templates (migration 0161).
   *
   *  Two endpoints, one per Flair, each accepting an OPTIONAL
   *  partial update of the pair it owns. Omit a field to leave that
   *  slot unchanged; pass null to clear it (renderer falls back to
   *  the default phrasing). Pass a non-empty string to set.
   *
   *  Ownership gate fires only on the SET path; clearing is always
   *  allowed so a revoked-flair user can drop their stale templates
   *  without a "purchase first to clear" gotcha. Same pattern the
   *  banner / typing-phrase clears use.
   * ========================================================= */

  /** Local helper, apply the shared validator + normalizer to a
   *  single field. `undefined` means "field omitted in body"; `null`
   *  means "clear the slot"; a string means "validate + normalize +
   *  set". Returns the resolved value or an error string. */
  function resolvePresenceTemplateField(
    raw: string | null | undefined,
  ): { ok: true; value: string | null | undefined } | { ok: false; error: string } {
    if (raw === undefined) return { ok: true, value: undefined };
    if (raw === null) return { ok: true, value: null };
    const normalized = normalizePresenceTemplate(raw);
    if (normalized === null) return { ok: true, value: null };
    const err = validatePresenceTemplate(normalized);
    if (err) return { ok: false, error: err };
    return { ok: true, value: normalized };
  }

  const setRoomPresenceBody = z.object({
    joinTemplate: z.string().max(500).nullable().optional(),
    leaveTemplate: z.string().max(500).nullable().optional(),
    /** Per-identity scope: null = master/OOC slot, character id =
     *  that character's templates. Matches the typing-phrase scope. */
    characterId: z.string().nullable().optional(),
  }).strict();

  app.patch<{ Querystring: { serverId?: string }; Body: unknown }>("/earning/me/room-presence", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const sid = await resolveActiveServerId(me, req.query.serverId);
    let body: z.infer<typeof setRoomPresenceBody>;
    try { body = setRoomPresenceBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const characterId = body.characterId ?? null;
    if (characterId) {
      const c = (await db
        .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
        .from(characters)
        .where(eq(characters.id, characterId))
        .limit(1))[0];
      if (!c || c.userId !== me.id || c.deletedAt) {
        reply.code(403); return { error: "not your character" };
      }
    }
    const join = resolvePresenceTemplateField(body.joinTemplate);
    if (!join.ok) { reply.code(400); return { error: `joinTemplate: ${join.error}` }; }
    const leave = resolvePresenceTemplateField(body.leaveTemplate);
    if (!leave.ok) { reply.code(400); return { error: `leaveTemplate: ${leave.error}` }; }
    // Ownership gate only when SETTING at least one slot to a non-null
    // value. A user whose flair was revoked can still pass nulls to
    // clear their stale templates.
    const settingAny = (join.value !== undefined && join.value !== null)
                    || (leave.value !== undefined && leave.value !== null);
    if (settingAny) {
      const scope: "user" | "character" = characterId ? "character" : "user";
      const ownerId = characterId ?? me.id;
      if (!(await hasPurchased(scope, ownerId, "flair_room_presence", sid))) {
        reply.code(403);
        return { error: tFor(me.locale, "errors:server.earning.purchaseEntranceFirst") };
      }
    }
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (join.value !== undefined) updates.roomJoinTemplate = join.value;
    if (leave.value !== undefined) updates.roomLeaveTemplate = leave.value;
    // No-op when neither field was supplied, still return the
    // current row so the client can sync without a follow-up GET.
    if (characterId) {
      if (Object.keys(updates).length > 1) {
        await db
          .insert(characterEarning)
          .values({ serverId: sid, characterId, ...updates })
          .onConflictDoUpdate({
            target: [characterEarning.serverId, characterEarning.characterId],
            set: updates,
          });
      }
      const row = (await db
        .select({
          roomJoinTemplate: characterEarning.roomJoinTemplate,
          roomLeaveTemplate: characterEarning.roomLeaveTemplate,
        })
        .from(characterEarning)
        .where(and(eq(characterEarning.serverId, sid), eq(characterEarning.characterId, characterId)))
        .limit(1))[0];
      return { ok: true, joinTemplate: row?.roomJoinTemplate ?? null, leaveTemplate: row?.roomLeaveTemplate ?? null };
    }
    if (Object.keys(updates).length > 1) {
      await db
        .insert(userEarning)
        .values({ serverId: sid, userId: me.id, ...updates })
        .onConflictDoUpdate({
          target: [userEarning.serverId, userEarning.userId],
          set: updates,
        });
    }
    const row = (await db
      .select({
        roomJoinTemplate: userEarning.roomJoinTemplate,
        roomLeaveTemplate: userEarning.roomLeaveTemplate,
      })
      .from(userEarning)
      .where(and(eq(userEarning.serverId, sid), eq(userEarning.userId, me.id)))
      .limit(1))[0];
    return { ok: true, joinTemplate: row?.roomJoinTemplate ?? null, leaveTemplate: row?.roomLeaveTemplate ?? null };
  });

  const setSessionPresenceBody = z.object({
    connectTemplate: z.string().max(500).nullable().optional(),
    exitTemplate: z.string().max(500).nullable().optional(),
  }).strict();

  app.patch<{ Querystring: { serverId?: string }; Body: unknown }>("/earning/me/session-presence", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const sid = await resolveActiveServerId(me, req.query.serverId);
    let body: z.infer<typeof setSessionPresenceBody>;
    try { body = setSessionPresenceBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }
    const connect = resolvePresenceTemplateField(body.connectTemplate);
    if (!connect.ok) { reply.code(400); return { error: `connectTemplate: ${connect.error}` }; }
    const exit = resolvePresenceTemplateField(body.exitTemplate);
    if (!exit.ok) { reply.code(400); return { error: `exitTemplate: ${exit.error}` }; }
    const settingAny = (connect.value !== undefined && connect.value !== null)
                    || (exit.value !== undefined && exit.value !== null);
    if (settingAny) {
      if (!(await hasPurchased("user", me.id, "flair_session_presence", sid))) {
        reply.code(403);
        return { error: "purchase 'Custom Session Greeting' to set custom session templates" };
      }
    }
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (connect.value !== undefined) updates.sessionConnectTemplate = connect.value;
    if (exit.value !== undefined) updates.sessionExitTemplate = exit.value;
    if (Object.keys(updates).length > 1) {
      await db
        .insert(userEarning)
        .values({ serverId: sid, userId: me.id, ...updates })
        .onConflictDoUpdate({
          target: [userEarning.serverId, userEarning.userId],
          set: updates,
        });
    }
    const row = (await db
      .select({
        sessionConnectTemplate: userEarning.sessionConnectTemplate,
        sessionExitTemplate: userEarning.sessionExitTemplate,
      })
      .from(userEarning)
      .where(and(eq(userEarning.serverId, sid), eq(userEarning.userId, me.id)))
      .limit(1))[0];
    return {
      ok: true,
      connectTemplate: row?.sessionConnectTemplate ?? null,
      exitTemplate: row?.sessionExitTemplate ?? null,
    };
  });

  /* =========================================================
   *  Borders, per-rank Tier IV purchase + equip
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

  app.post<{ Params: { rankKey: string }; Querystring: { serverId?: string }; Body: unknown }>(
    "/earning/me/borders/:rankKey/purchase",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const sid = await resolveActiveServerId(me, req.query.serverId);
      // Per-server subsystem toggle (migration 0293): rank-tier + freeform
      // borders are one "borders" subsystem. Equip of an owned border stays
      // allowed; the PURCHASE is gated. DEFAULT_SERVER_ID / flag-off → ON.
      if (!(await resolveSubsystemToggles(sid)).borders) {
        reply.code(403); return { error: "subsystem_disabled" };
      }
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
        serverId: sid,
        validate: (tx) => {
          const rankRow = tx.select().from(ranks).where(and(eq(ranks.serverId, sid), eq(ranks.key, rankKey))).limit(1).all()[0];
          if (!rankRow) return { ok: false, status: 404, error: "rank not found" };
          const tier4 = tx.select().from(rankTiers).where(and(
            eq(rankTiers.serverId, sid),
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
            tx.insert(characterEarning).values({ serverId: sid, characterId }).onConflictDoNothing().run();
            const row = tx.select().from(characterEarning).where(and(eq(characterEarning.serverId, sid), eq(characterEarning.characterId, characterId))).limit(1).all()[0]!;
            earning = { maxRankKeyEverHeld: row.maxRankKeyEverHeld, maxTierEverHeld: row.maxTierEverHeld };
          } else {
            tx.insert(userEarning).values({ serverId: sid, userId: me.id }).onConflictDoNothing().run();
            const row = tx.select().from(userEarning).where(and(eq(userEarning.serverId, sid), eq(userEarning.userId, me.id))).limit(1).all()[0]!;
            earning = { maxRankKeyEverHeld: row.maxRankKeyEverHeld, maxTierEverHeld: row.maxTierEverHeld };
          }
          let eligible = false;
          if (earning.maxRankKeyEverHeld === rankKey && (earning.maxTierEverHeld ?? 0) >= 4) {
            eligible = true;
          } else if (earning.maxRankKeyEverHeld) {
            const peakRow = tx.select({ order: ranks.order }).from(ranks).where(and(eq(ranks.serverId, sid), eq(ranks.key, earning.maxRankKeyEverHeld))).limit(1).all()[0];
            if (peakRow && peakRow.order > rankRow.order) eligible = true;
          }
          if (!eligible) {
            return {
              ok: false,
              status: 403,
              error: tFor(me.locale, "errors:server.earning.reachTierIvBorder"),
            };
          }
          // Already-owned check against the scope-appropriate table.
          if (characterId) {
            const already = tx.select().from(characterOwnedBorders).where(and(
              eq(characterOwnedBorders.serverId, sid),
              eq(characterOwnedBorders.characterId, characterId),
              eq(characterOwnedBorders.rankKey, rankKey),
            )).limit(1).all()[0];
            if (already) return { ok: false, status: 409, error: "already owned" };
          } else {
            const already = tx.select().from(userOwnedBorders).where(and(
              eq(userOwnedBorders.serverId, sid),
              eq(userOwnedBorders.userId, me.id),
              eq(userOwnedBorders.rankKey, rankKey),
            )).limit(1).all()[0];
            if (already) return { ok: false, status: 409, error: "already owned" };
          }
          return { ok: true, cost: tier4.borderCost };
        },
        grant: (tx) => {
          if (characterId) {
            tx.insert(characterOwnedBorders).values({ serverId: sid, characterId, rankKey }).onConflictDoNothing().run();
            // Auto-equip on first character purchase. Reads /
            // writes `character_earning.selected_border_rank_key`.
            const cur = tx.select({ selected: characterEarning.selectedBorderRankKey }).from(characterEarning).where(and(eq(characterEarning.serverId, sid), eq(characterEarning.characterId, characterId))).limit(1).all()[0];
            if (!cur?.selected) {
              tx.update(characterEarning)
                .set({ selectedBorderRankKey: rankKey, updatedAt: new Date() })
                .where(and(eq(characterEarning.serverId, sid), eq(characterEarning.characterId, characterId)))
                .run();
            }
          } else {
            tx.insert(userOwnedBorders).values({ serverId: sid, userId: me.id, rankKey }).onConflictDoNothing().run();
            const cur = tx.select({ selected: userEarning.selectedBorderRankKey }).from(userEarning).where(and(eq(userEarning.serverId, sid), eq(userEarning.userId, me.id))).limit(1).all()[0];
            if (!cur?.selected) {
              tx.update(userEarning)
                .set({ selectedBorderRankKey: rankKey, updatedAt: new Date() })
                .where(and(eq(userEarning.serverId, sid), eq(userEarning.userId, me.id)))
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
   *  Free-form borders, purchase + auto-equip
   *
   *  Companion to the rank-tier border endpoint above. The catalog
   *  lives in `freeform_borders` (independent of `rank_tiers`) and
   *  has no eligibility gate, anyone with Currency can buy. Pricing
   *  comes off `freeform_borders.cost`. Flash-sale support is
   *  intentionally omitted on the first cut; borders aren't in the
   *  rotation today and adding it later only requires extending the
   *  resolver lookup.
   *
   *  Equip: auto-equips on first purchase by writing
   *  `selected_freeform_border_key`. The existing PATCH
   *  /earning/me/settings endpoint accepts `selectedFreeformBorderKey`
   *  with ownership validation for unequip / switch.
   * ========================================================= */

  app.post<{ Params: { key: string }; Querystring: { serverId?: string }; Body: unknown }>(
    "/earning/me/freeform-borders/:key/purchase",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const sid = await resolveActiveServerId(me, req.query.serverId);
      // Per-server subsystem toggle (migration 0293): freeform borders share the
      // "borders" subsystem with rank-tier borders. Equip of an owned border
      // stays allowed; the PURCHASE is gated. DEFAULT_SERVER_ID / flag-off → ON.
      if (!(await resolveSubsystemToggles(sid)).borders) {
        reply.code(403); return { error: "subsystem_disabled" };
      }
      const borderKey = req.params.key;
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

      // Resolve today's flash sale outside the txn so the validate
      // step can compare snapshot keys without lazy-inserting inside
      // the transaction (the resolver may upsert today's row, which
      // we don't want nested under a purchase txn). Scoped to the active
      // server `sid` (migration 0299; flag off → DEFAULT_SERVER_ID).
      const flashSale = await resolveTodayFlashSale(db, new Date(), sid);
      const outcome = runPurchaseTxn(db, me.id, {
        characterId,
        serverId: sid,
        validate: (tx) => {
          const row = tx.select().from(freeformBorders).where(and(eq(freeformBorders.serverId, sid), eq(freeformBorders.key, borderKey))).limit(1).all()[0];
          if (!row || !row.enabled) return { ok: false, status: 404, error: "border not found or disabled" };
          if (characterId) {
            const already = tx.select().from(characterOwnedFreeformBorders).where(and(
              eq(characterOwnedFreeformBorders.serverId, sid),
              eq(characterOwnedFreeformBorders.characterId, characterId),
              eq(characterOwnedFreeformBorders.borderKey, borderKey),
            )).limit(1).all()[0];
            if (already) return { ok: false, status: 409, error: "already owned" };
          } else {
            const already = tx.select().from(userOwnedFreeformBorders).where(and(
              eq(userOwnedFreeformBorders.serverId, sid),
              eq(userOwnedFreeformBorders.userId, me.id),
              eq(userOwnedFreeformBorders.borderKey, borderKey),
            )).limit(1).all()[0];
            if (already) return { ok: false, status: 409, error: "already owned" };
          }
          // Server-authoritative discount: only when this border is
          // today's pick. The client surfaces the discounted price
          // for UX, but the actual debit is recomputed here.
          const cost = flashSale.freeformBorderKey === borderKey
            ? applyDiscount(row.cost, flashSale.freeformBorderDiscountPct)
            : row.cost;
          return { ok: true, cost };
        },
        grant: (tx) => {
          if (characterId) {
            tx.insert(characterOwnedFreeformBorders).values({ serverId: sid, characterId, borderKey }).onConflictDoNothing().run();
            // Auto-equip on first purchase when the freeform slot is
            // empty. Doing this regardless of the rank-tier slot is
            // deliberate: a user just paid Currency for a deliberate
            // cosmetic, and the renderer resolves freeform first, so
            // a freshly-purchased freeform with an existing rank
            // border equipped would otherwise sit invisible behind
            // the rank one until the user found the equip control.
            // The rank border equip stays untouched on
            // user/character_earning.selectedBorderRankKey and
            // re-emerges automatically if the user later unequips
            // the freeform.
            tx.insert(characterEarning).values({ serverId: sid, characterId }).onConflictDoNothing().run();
            const cur = tx.select({
              freeform: characterEarning.selectedFreeformBorderKey,
            }).from(characterEarning).where(and(eq(characterEarning.serverId, sid), eq(characterEarning.characterId, characterId))).limit(1).all()[0];
            if (!cur?.freeform) {
              tx.update(characterEarning)
                .set({ selectedFreeformBorderKey: borderKey, updatedAt: new Date() })
                .where(and(eq(characterEarning.serverId, sid), eq(characterEarning.characterId, characterId)))
                .run();
            }
          } else {
            tx.insert(userOwnedFreeformBorders).values({ serverId: sid, userId: me.id, borderKey }).onConflictDoNothing().run();
            tx.insert(userEarning).values({ serverId: sid, userId: me.id }).onConflictDoNothing().run();
            const cur = tx.select({
              freeform: userEarning.selectedFreeformBorderKey,
            }).from(userEarning).where(and(eq(userEarning.serverId, sid), eq(userEarning.userId, me.id))).limit(1).all()[0];
            if (!cur?.freeform) {
              tx.update(userEarning)
                .set({ selectedFreeformBorderKey: borderKey, updatedAt: new Date() })
                .where(and(eq(userEarning.serverId, sid), eq(userEarning.userId, me.id)))
                .run();
            }
          }
        },
        reason: `freeform_border_purchase_${borderKey}`,
        metadata: { kind: "freeform_border", borderKey },
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
        `freeform_border_purchase_${borderKey}`,
        characterId ? { scope: "character", ownerId: characterId } : { scope: "user" },
      );
      await rebroadcastPresenceForUser(me.id);
      return { ok: true };
    },
  );

  /* =========================================================
   *  Free-form border color customization (migration 0158).
   *
   *  Mirror of /earning/me/name-styles/:key/config, per-identity
   *  JSON map of CSS custom-property values. The catalog row's CSS
   *  references customizable colors via `var(--c-<name>, <fallback>)`;
   *  this endpoint writes the user's override values into
   *  `<scope>_owned_freeform_borders.config_json`. The renderer
   *  inlines them as `--c-<name>: <value>` on the BorderedAvatar
   *  wrapper so the cascade reaches the `.av .b-<key>` template.
   *
   *  Pass `config: null` to clear all overrides for this border on
   *  this identity (reverts to the catalog row's CSS fallbacks).
   *
   *  Server-side filter: any key not in the catalog's
   *  `extractFreeformBorderVars()` set is dropped. This is the
   *  first line of defense against a malformed client trying to
   *  write arbitrary CSS variables. The second line is the
   *  renderer applying the same filter on read.
   * ========================================================= */

  const patchFreeformBorderConfigBody = z.object({
    /** Map of var-name (without `--c-` prefix) → CSS color string.
     *  Pass null/omit to clear. */
    config: z.record(z.string(), z.string()).nullable(),
    /** Per-identity scope. Null/omitted = master. */
    characterId: z.string().nullable().optional(),
  }).strict();

  app.patch<{ Params: { key: string }; Querystring: { serverId?: string }; Body: unknown }>(
    "/earning/me/freeform-borders/:key/config",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const sid = await resolveActiveServerId(me, req.query.serverId);
      let body: z.infer<typeof patchFreeformBorderConfigBody>;
      try { body = patchFreeformBorderConfigBody.parse(req.body); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

      const borderKey = req.params.key;
      const characterId = body.characterId ?? null;

      // Look up the catalog row so we can extract the set of
      // customizable vars and filter the incoming config to that
      // set. A row that's been disabled or deleted between the
      // client fetching and submitting falls through to the
      // ownership lookup which 404s cleanly.
      const borderRow = (await db
        .select({ styleCss: freeformBorders.styleCss })
        .from(freeformBorders)
        .where(and(eq(freeformBorders.serverId, sid), eq(freeformBorders.key, borderKey)))
        .limit(1))[0];
      if (!borderRow) { reply.code(404); return { error: "border not found" }; }

      // Build the filtered config. Drop unknown keys silently
      // (client may know about more vars than the current CSS
      // declares, e.g. after an admin edit that removed a slot),
      // and validate each remaining value.
      let cleaned: Record<string, string> | null = null;
      if (body.config) {
        const allowed = new Set(extractFreeformBorderVars(borderRow.styleCss ?? ""));
        cleaned = {};
        let count = 0;
        for (const [k, v] of Object.entries(body.config)) {
          if (!allowed.has(k)) continue;
          if (!isValidFreeformBorderConfigKey(k)) continue;
          if (!isValidFreeformBorderConfigValue(v)) continue;
          cleaned[k] = v;
          count += 1;
          if (count >= FREEFORM_CONFIG_MAX_ENTRIES) break;
        }
        // An entirely-empty config after filtering is the same as
        // null, store null so the snapshot view can render "no
        // overrides" without distinguishing between the two states.
        if (count === 0) cleaned = null;
      }

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
          .select({ borderKey: characterOwnedFreeformBorders.borderKey })
          .from(characterOwnedFreeformBorders)
          .where(and(
            eq(characterOwnedFreeformBorders.serverId, sid),
            eq(characterOwnedFreeformBorders.characterId, characterId),
            eq(characterOwnedFreeformBorders.borderKey, borderKey),
          ))
          .limit(1))[0];
        if (!owned) { reply.code(404); return { error: "not owned" }; }
        await db
          .update(characterOwnedFreeformBorders)
          .set({ configJson: cleaned ? JSON.stringify(cleaned) : null })
          .where(and(
            eq(characterOwnedFreeformBorders.serverId, sid),
            eq(characterOwnedFreeformBorders.characterId, characterId),
            eq(characterOwnedFreeformBorders.borderKey, borderKey),
          ));
      } else {
        const owned = (await db
          .select({ borderKey: userOwnedFreeformBorders.borderKey })
          .from(userOwnedFreeformBorders)
          .where(and(
            eq(userOwnedFreeformBorders.serverId, sid),
            eq(userOwnedFreeformBorders.userId, me.id),
            eq(userOwnedFreeformBorders.borderKey, borderKey),
          ))
          .limit(1))[0];
        if (!owned) { reply.code(404); return { error: "not owned" }; }
        await db
          .update(userOwnedFreeformBorders)
          .set({ configJson: cleaned ? JSON.stringify(cleaned) : null })
          .where(and(
            eq(userOwnedFreeformBorders.serverId, sid),
            eq(userOwnedFreeformBorders.userId, me.id),
            eq(userOwnedFreeformBorders.borderKey, borderKey),
          ));
      }
      // Borders render on every chat line + userlist row of this
      // user. Once we surface configs in the occupant payload (a
      // future broadcast extension), peer renders pick up new
      // colors here too. For now this rebroadcast is a no-op for
      // peers but cheap.
      await rebroadcastPresenceForUser(me.id);
      return { ok: true };
    },
  );

  /* =========================================================
   *  Items, shop purchase
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
   *  Currency and inventory both partition cleanly, buying as
   *  Character A only debits A's pool and only stocks A's inventory.
   * ========================================================= */

  const buyItemBody = z.object({
    quantity: z.number().int().min(1).max(999),
    characterId: z.string().nullable().optional(),
  }).strict();

  app.post<{ Params: { key: string }; Querystring: { serverId?: string }; Body: unknown }>(
    "/earning/me/items/:key/buy",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const sid = await resolveActiveServerId(me, req.query.serverId);
      // Per-server subsystem toggle (migration 0293): the items shop can be off
      // for this server. Inventory the user already owns stays usable; only
      // BUYING is gated. DEFAULT_SERVER_ID / flag-off → ON.
      if (!(await resolveSubsystemToggles(sid)).shop) {
        reply.code(403); return { error: "subsystem_disabled" };
      }
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

      // Scoped to the active server `sid` (migration 0299; flag off →
      // DEFAULT_SERVER_ID, byte-identical) so item discounts match this
      // server's sale picks.
      const flashSale = await resolveTodayFlashSale(db, new Date(), sid);
      const outcome = runPurchaseTxn(db, me.id, {
        characterId,
        serverId: sid,
        validate: (tx) => {
          const item = tx.select().from(items).where(and(eq(items.serverId, sid), eq(items.key, req.params.key))).limit(1).all()[0];
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
          // No stack-cap gate: players accumulate without ceiling, by
          // design — matching the /give, raffle, and admin-grant paths
          // (the catalog's `stackLimit` is an admin-facing hint only, NOT
          // a runtime purchase limit). Enforcing it here was the lone
          // straggler: a second buy of a low-`stackLimit` item (e.g. a
          // Bat) hit a 409 the client — which caps nothing and shows the
          // error only in a top-of-tab box — surfaced merely as the Buy
          // button snapping back with the owned count stuck.
          //
          // Flash-sale discount applies per UNIT (not per stack), so a
          // bulk-buy of an on-sale item gets the discount on every unit.
          const unitPrice = flashSale.itemKey === req.params.key
            ? applyDiscount(item.price, flashSale.itemDiscountPct)
            : item.price;
          return { ok: true, cost: unitPrice * body.quantity };
        },
        grant: (tx) => {
          // Upsert: increment quantity if a row already exists for this
          // (identity, itemKey) tuple; otherwise insert fresh.
          const existing = tx.select({ qty: identityInventory.quantity })
            .from(identityInventory)
            .where(and(
              eq(identityInventory.serverId, sid),
              eq(identityInventory.ownerScope, ownerScope),
              eq(identityInventory.ownerId, ownerId),
              eq(identityInventory.itemKey, req.params.key),
            )).limit(1).all()[0];
          if (existing) {
            tx.update(identityInventory)
              .set({ quantity: existing.qty + body.quantity, updatedAt: new Date() })
              .where(and(
                eq(identityInventory.serverId, sid),
                eq(identityInventory.ownerScope, ownerScope),
                eq(identityInventory.ownerId, ownerId),
                eq(identityInventory.itemKey, req.params.key),
              ))
              .run();
          } else {
            tx.insert(identityInventory).values({
              serverId: sid,
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
   *  Collection, per-identity 10-slot pinned showcase.
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

  app.put<{ Querystring: { serverId?: string }; Body: unknown }>("/earning/me/collection", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const sid = await resolveActiveServerId(me, req.query.serverId);
    let body: z.infer<typeof setCollectionBody>;
    try { body = setCollectionBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

    // Reject duplicate slot indexes in the same request, the slot
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
              eq(identityInventory.serverId, sid),
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
          // Category guard, pets belong in identity_pet_collection,
          // not here. Read the relevant category rows once and
          // reject any pet keys before the writes start.
          const catRows = tx.select({ key: items.key, category: items.category })
            .from(items)
            .where(and(eq(items.serverId, sid), inArray(items.key, itemKeysToCheck)))
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
              eq(identityCollection.serverId, sid),
              eq(identityCollection.ownerScope, ownerScope),
              eq(identityCollection.ownerId, ownerId),
              eq(identityCollection.slot, s.slot),
            )).run();
          } else {
            // Upsert via delete-then-insert. SQLite's ON CONFLICT
            // DO UPDATE works too, but this idiom matches the rest
            // of the codebase's per-row writes.
            tx.delete(identityCollection).where(and(
              eq(identityCollection.serverId, sid),
              eq(identityCollection.ownerScope, ownerScope),
              eq(identityCollection.ownerId, ownerId),
              eq(identityCollection.slot, s.slot),
            )).run();
            tx.insert(identityCollection).values({
              serverId: sid,
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
        return { error: tFor(me.locale, "errors:server.earning.dontHoldItem", { name: msg.slice("__pin_not_owned__:".length) }) };
      }
      if (msg.startsWith("__pin_wrong_collection__:")) {
        reply.code(403);
        return { error: tFor(me.locale, "errors:server.earning.pinIsPet", { name: msg.slice("__pin_wrong_collection__:".length) }) };
      }
      throw err;
    }

    return { ok: true };
  });

  /* =========================================================
   *  Pet Collection, 5-slot pinned pet showcase
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

  app.put<{ Querystring: { serverId?: string }; Body: unknown }>("/earning/me/pet-collection", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const sid = await resolveActiveServerId(me, req.query.serverId);
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
              eq(identityInventory.serverId, sid),
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
          // Inverse category guard, only pets allowed here.
          const catRows = tx.select({ key: items.key, category: items.category })
            .from(items)
            .where(and(eq(items.serverId, sid), inArray(items.key, itemKeysToCheck)))
            .all();
          for (const r of catRows) {
            if (r.category !== "pet") {
              throw new Error(`__pin_wrong_collection__:${r.key}`);
            }
          }
        }
        // Snapshot existing nicknames per itemKey BEFORE any deletes so
        // we can preserve them when the same pet is moved to a different
        // slot. The PUT body is a slot-keyed diff, so "move Whiskers
        // from slot 0 to slot 2" comes in as { slot:0, itemKey:null }
        // + { slot:2, itemKey:'maine_coon' }, without this snapshot the
        // delete at slot 0 would drop the nickname and the insert at
        // slot 2 would re-pin the pet anonymous. Re-pinning a DIFFERENT
        // itemKey in a slot still drops the nickname because it
        // belonged to a different creature.
        const priorRows = tx.select({
          itemKey: identityPetCollection.itemKey,
          nickname: identityPetCollection.nickname,
        })
          .from(identityPetCollection)
          .where(and(
            eq(identityPetCollection.serverId, sid),
            eq(identityPetCollection.ownerScope, ownerScope),
            eq(identityPetCollection.ownerId, ownerId),
          ))
          .all();
        const priorNicknameByItem = new Map<string, string | null>();
        for (const r of priorRows) priorNicknameByItem.set(r.itemKey, r.nickname ?? null);
        for (const s of body.slots) {
          if (s.itemKey === null) {
            tx.delete(identityPetCollection).where(and(
              eq(identityPetCollection.serverId, sid),
              eq(identityPetCollection.ownerScope, ownerScope),
              eq(identityPetCollection.ownerId, ownerId),
              eq(identityPetCollection.slot, s.slot),
            )).run();
          } else {
            tx.delete(identityPetCollection).where(and(
              eq(identityPetCollection.serverId, sid),
              eq(identityPetCollection.ownerScope, ownerScope),
              eq(identityPetCollection.ownerId, ownerId),
              eq(identityPetCollection.slot, s.slot),
            )).run();
            tx.insert(identityPetCollection).values({
              serverId: sid,
              ownerScope,
              ownerId,
              slot: s.slot,
              itemKey: s.itemKey,
              // Carry the prior nickname forward when this pet was
              // previously pinned (possibly in a different slot).
              nickname: priorNicknameByItem.get(s.itemKey) ?? null,
            }).run();
          }
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.startsWith("__pin_not_owned__:")) {
        reply.code(403);
        return { error: tFor(me.locale, "errors:server.earning.dontHoldItem", { name: msg.slice("__pin_not_owned__:".length) }) };
      }
      if (msg.startsWith("__pin_wrong_collection__:")) {
        reply.code(403);
        return { error: tFor(me.locale, "errors:server.earning.pinNotPet", { name: msg.slice("__pin_wrong_collection__:".length) }) };
      }
      throw err;
    }

    return { ok: true };
  });

  /* =========================================================
   *  Pet nickname rename
   *
   *  PATCH /earning/me/pet-collection/:slot/nickname
   *    Body: { nickname: string | null, characterId?: string | null }
   *    Sets or clears the owner's nickname for the pet pinned in
   *    `slot`. Owner-only (the route resolves the pool from the
   *    session; non-owners can't reach this endpoint). The slot must
   *    actually hold a pet, renaming an empty slot is a no-op error
   *    so the client can't silently lose a nickname write.
   * ========================================================= */
  const renamePetBody = z.object({
    nickname: z.string().max(PET_NICKNAME_MAX_LENGTH).nullable(),
    characterId: z.string().nullable().optional(),
  }).strict();

  app.patch<{ Params: { slot: string }; Querystring: { serverId?: string }; Body: unknown }>(
    "/earning/me/pet-collection/:slot/nickname",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const sid = await resolveActiveServerId(me, req.query.serverId);
      const slot = Number.parseInt(req.params.slot, 10);
      if (!Number.isInteger(slot) || slot < 0 || slot > 4) {
        reply.code(400);
        return { error: "slot must be 0..4" };
      }
      let body: z.infer<typeof renamePetBody>;
      try { body = renamePetBody.parse(req.body); }
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

      // Normalize: trim, collapse internal whitespace runs to single
      // space, treat empty-after-trim as null (matches the "clear the
      // nickname" semantics callers expect without forcing them to
      // send literal null).
      const cleaned = body.nickname == null
        ? null
        : body.nickname.replace(/\s+/g, " ").trim();
      const next = cleaned && cleaned.length > 0 ? cleaned : null;

      const existing = (await db
        .select({ itemKey: identityPetCollection.itemKey })
        .from(identityPetCollection)
        .where(and(
          eq(identityPetCollection.serverId, sid),
          eq(identityPetCollection.ownerScope, ownerScope),
          eq(identityPetCollection.ownerId, ownerId),
          eq(identityPetCollection.slot, slot),
        ))
        .limit(1))[0];
      if (!existing) {
        reply.code(404);
        return { error: "no pet in that slot" };
      }
      await db
        .update(identityPetCollection)
        .set({ nickname: next, updatedAt: new Date() })
        .where(and(
          eq(identityPetCollection.serverId, sid),
          eq(identityPetCollection.ownerScope, ownerScope),
          eq(identityPetCollection.ownerId, ownerId),
          eq(identityPetCollection.slot, slot),
        ));
      return { ok: true, slot, nickname: next };
    },
  );
}
