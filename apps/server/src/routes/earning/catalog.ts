/**
 * Earning routes — CATALOG / read sub-registrar.
 *
 * MOVE-ONLY split (Phase 3): the GET/read endpoints below were
 * relocated verbatim out of ./earning.ts. `registerEarningRoutes`
 * invokes this after building the shared `EarningRouteDeps`. Route
 * bodies are unchanged; they reference `app` / `db` / the resolver
 * closures via the destructured deps, exactly as they did when they
 * were closures inside `registerEarningRoutes`.
 */

import { and, asc, desc, eq, inArray, like, lt, or, sql } from "drizzle-orm";
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
  earningLedger,
  userActiveCosmetics,
  userOwnedBorders,
  userOwnedNameStyles,
  userEarning,
  users,
} from "../../db/schema.js";
import { getSessionUser } from "../auth.js";
import {
  listUnacknowledged,
} from "../../earning/notifications.js";
import {
  applyDiscount,
  resolveTodayFlashSale,
} from "../../earning/flashSale.js";
import { buildRankings } from "../../earning/rankings.js";
import { buildGameRankings } from "../../earning/gameRankings.js";
import { buildFamiliarRankings } from "../../earning/familiarRankings.js";
import { buildScriptoriumRankings } from "../../earning/scriptoriumRankings.js";
import { DEFAULT_SERVER_ID, resolveProfileServerId } from "../../earning/pool.js";
import { cursorPageSlice } from "../../lib/pagination.js";
import type { EarningRouteDeps, PoolView } from "./shared.js";
import {
  LEDGER_PAGE_LIMIT,
  buildCharacterPoolView,
  buildTransitionCatalog,
  buildUserPoolView,
  groupByCharacter,
  loadRankTierLookup,
  safeParse,
  shapeItemCatalogRow,
} from "./shared.js";

export async function registerEarningCatalogRoutes(deps: EarningRouteDeps): Promise<void> {
  const { app, db, resolveActiveServerId, resolveSubsystemToggles } = deps;

// === ROUTES BELOW ===
  /**
   * Full earning snapshot for the caller. Drives the Earning
   * dashboard wallet + ledger sections + the catalog + own
   * notifications. The catalog slice is now PER-SERVER (migrations
   * 0295-0299), so any future cache on it MUST key on the resolved
   * `sid` (no longer "everyone sees the same catalog"); the
   * wallet/ledger slices remain per-user (and per-server).
   */
  app.get<{ Querystring: { serverId?: string } }>("/earning/me", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    // Per-server economy: the dashboard reflects ONE server's pool
    // snapshot. The optional `?serverId=` picks it via the canonical
    // resolver (see resolveActiveServerId above); absent / non-member /
    // flag-off resolves to DEFAULT_SERVER_ID, so every read below is
    // byte-identical to the legacy single-server behavior. The response
    // SHAPE is unchanged — only the source server varies.
    const sid = await resolveActiveServerId(me, req.query.serverId);

    // Per-server subsystem toggles (migration 0293). A disabled subsystem
    // surfaces as an EMPTY catalog section below so the client hides its tab;
    // the wallet/ownership slices stay intact (a user keeps what they already
    // bought). DEFAULT_SERVER_ID / flag-off → every subsystem ON, byte-identical.
    const toggles = await resolveSubsystemToggles(sid);

    const { rankRows, tierRows, rankByKey, tierByKey } = await loadRankTierLookup(db, sid);

    const master = await buildUserPoolView(db, me.id, me.username, rankByKey, tierByKey, sid);

    // Every character of the user (active or not) with a non-zero
    // earning row. We include zero-XP characters too if they have a
    // row at all, so the dashboard can show characters the user has
    // started but not yet earned on. Cap at 50 just to bound payload
    //, a user with 100 characters is an edge case worth bounding.
    const charsOfMine = await db
      .select({ id: characters.id, name: characters.name })
      .from(characters)
      .where(and(eq(characters.userId, me.id), sql`${characters.deletedAt} IS NULL`))
      .limit(50);
    const characterViews: PoolView[] = [];
    for (const c of charsOfMine) {
      const v = await buildCharacterPoolView(db, c.id, c.name, rankByKey, tierByKey, sid);
      if (v) characterViews.push(v);
    }

    // Owned cosmetics + currently-equipped state. Per-identity:
    // master rows from user_owned_*, character rows from
    // character_owned_*. Each set is independent, a master who
    // bought Embers does NOT make their character own it, and vice
    // versa.
    // Per-server economy: this dashboard reflects the CHOSEN server's
    // ownership (sid). Every ownership read below is scoped to sid so
    // /earning/me stays backward-compatible (flag off → DEFAULT_SERVER_ID,
    // today's single-server view) while showing the active server's pool
    // when the flag is on.
    const ownedStyleRows = await db
      .select()
      .from(userOwnedNameStyles)
      .where(and(eq(userOwnedNameStyles.serverId, sid), eq(userOwnedNameStyles.userId, me.id)));
    const ownedBorderRows = await db
      .select()
      .from(userOwnedBorders)
      .where(and(eq(userOwnedBorders.serverId, sid), eq(userOwnedBorders.userId, me.id)));
    const charIdsForOwnership = charsOfMine.map((c) => c.id);
    const charOwnedStyleRows = charIdsForOwnership.length
      ? await db
          .select()
          .from(characterOwnedNameStyles)
          .where(and(eq(characterOwnedNameStyles.serverId, sid), inArray(characterOwnedNameStyles.characterId, charIdsForOwnership)))
      : [];
    const charOwnedBorderRows = charIdsForOwnership.length
      ? await db
          .select()
          .from(characterOwnedBorders)
          .where(and(eq(characterOwnedBorders.serverId, sid), inArray(characterOwnedBorders.characterId, charIdsForOwnership)))
      : [];
    // Free-form border ownership, parallel to rank-tier borders. Two
    // independent ledgers per the migration 0149 comment.
    const ownedFreeformBorderRows = await db
      .select()
      .from(userOwnedFreeformBorders)
      .where(and(eq(userOwnedFreeformBorders.serverId, sid), eq(userOwnedFreeformBorders.userId, me.id)));
    const charOwnedFreeformBorderRows = charIdsForOwnership.length
      ? await db
          .select()
          .from(characterOwnedFreeformBorders)
          .where(and(eq(characterOwnedFreeformBorders.serverId, sid), inArray(characterOwnedFreeformBorders.characterId, charIdsForOwnership)))
      : [];
    const activeCosmeticsRow = (await db
      .select()
      .from(userActiveCosmetics)
      .where(and(eq(userActiveCosmetics.serverId, sid), eq(userActiveCosmetics.userId, me.id)))
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
            profileBannerUrl: characterEarning.profileBannerUrl,
            selectedFreeformBorderKey: characterEarning.selectedFreeformBorderKey,
            typingPhrase: characterEarning.typingPhrase,
            lurkingMasterEnabled: characterEarning.lurkingMasterEnabled,
            roomJoinTemplate: characterEarning.roomJoinTemplate,
            roomLeaveTemplate: characterEarning.roomLeaveTemplate,
            activeRoomTransitionKey: characterEarning.activeRoomTransitionKey,
          })
          .from(characterEarning)
          .where(and(eq(characterEarning.serverId, sid), inArray(characterEarning.characterId, charIds)))
      : [];
    // Owned room-transition keys per identity, from the earning ledger
    // (reason `purchase_transition_<key>`). Free `slide` is implicitly owned
    // by every identity. One query covers master + all characters.
    const transitionOwnerRows = await db
      .select({ scope: earningLedger.scope, ownerId: earningLedger.ownerId, reason: earningLedger.reason })
      .from(earningLedger)
      .where(and(
        eq(earningLedger.serverId, sid),
        like(earningLedger.reason, "purchase_transition_%"),
        or(
          and(eq(earningLedger.scope, "user"), eq(earningLedger.ownerId, me.id)),
          ...(charIds.length > 0
            ? [and(eq(earningLedger.scope, "character"), inArray(earningLedger.ownerId, charIds))]
            : []),
        ),
      ));
    const TRANSITION_REASON_PREFIX = "purchase_transition_";
    // No free default: nothing is owned until purchased (the default is an
    // instant switch — equip nothing). Ownership comes solely from the ledger.
    const masterOwnedTransitions = new Set<string>();
    const characterOwnedTransitions = new Map<string, Set<string>>();
    for (const r of transitionOwnerRows) {
      const key = r.reason.slice(TRANSITION_REASON_PREFIX.length);
      if (r.scope === "user") {
        masterOwnedTransitions.add(key);
      } else {
        const set = characterOwnedTransitions.get(r.ownerId) ?? new Set<string>();
        set.add(key);
        characterOwnedTransitions.set(r.ownerId, set);
      }
    }
    // Master's typing phrase + presence templates live on user_earning
    // (NOT user_active_cosmetics). The pool view query a few lines up
    // already touches user_earning, but it doesn't pull these columns,
    // so one extra single-row read here.
    const masterEarningRow = (await db
      .select({
        typingPhrase: userEarning.typingPhrase,
        roomJoinTemplate: userEarning.roomJoinTemplate,
        roomLeaveTemplate: userEarning.roomLeaveTemplate,
        sessionConnectTemplate: userEarning.sessionConnectTemplate,
        sessionExitTemplate: userEarning.sessionExitTemplate,
      })
      .from(userEarning)
      .where(and(eq(userEarning.serverId, sid), eq(userEarning.userId, me.id)))
      .limit(1))[0];
    // Flair-purchase ownership lookup: which identities (master +
    // characters) have bought `flair_profile_banner` from the
    // earning ledger? Used by the Flair tab to gate the "Set
    // banner URL" form behind a purchase, and by the per-identity
    // dropdown so an admin who cleared one identity's URL doesn't
    // see "Buy" on an identity that already owns it. One query
    // covers both scopes via an OR.
    const bannerOwnerRows = await db
      .select({
        scope: earningLedger.scope,
        ownerId: earningLedger.ownerId,
      })
      .from(earningLedger)
      .where(and(
        eq(earningLedger.serverId, sid),
        eq(earningLedger.reason, "purchase_flair_profile_banner"),
        or(
          and(eq(earningLedger.scope, "user"), eq(earningLedger.ownerId, me.id)),
          ...(charIds.length > 0
            ? [and(eq(earningLedger.scope, "character"), inArray(earningLedger.ownerId, charIds))]
            : []),
        ),
      ));
    const masterOwnsBanner = bannerOwnerRows.some((r) => r.scope === "user");
    const characterBannerOwnership = new Set(
      bannerOwnerRows.filter((r) => r.scope === "character").map((r) => r.ownerId),
    );
    // Same shape, for the Phase 5 typing-phrase Flair. Twin lookup
    // against `purchase_flair_typing_phrase` ledger rows.
    const typingPhraseOwnerRows = await db
      .select({
        scope: earningLedger.scope,
        ownerId: earningLedger.ownerId,
      })
      .from(earningLedger)
      .where(and(
        eq(earningLedger.serverId, sid),
        eq(earningLedger.reason, "purchase_flair_typing_phrase"),
        or(
          and(eq(earningLedger.scope, "user"), eq(earningLedger.ownerId, me.id)),
          ...(charIds.length > 0
            ? [and(eq(earningLedger.scope, "character"), inArray(earningLedger.ownerId, charIds))]
            : []),
        ),
      ));
    const masterOwnsTypingPhrase = typingPhraseOwnerRows.some((r) => r.scope === "user");
    const characterTypingPhraseOwnership = new Set(
      typingPhraseOwnerRows.filter((r) => r.scope === "character").map((r) => r.ownerId),
    );
    // Phase 6, Lurking Master Flair. Same ownership-lookup shape
    // as the banner / typing-phrase rows above.
    const lurkingOwnerRows = await db
      .select({
        scope: earningLedger.scope,
        ownerId: earningLedger.ownerId,
      })
      .from(earningLedger)
      .where(and(
        eq(earningLedger.serverId, sid),
        eq(earningLedger.reason, "purchase_flair_lurking_master"),
        or(
          and(eq(earningLedger.scope, "user"), eq(earningLedger.ownerId, me.id)),
          ...(charIds.length > 0
            ? [and(eq(earningLedger.scope, "character"), inArray(earningLedger.ownerId, charIds))]
            : []),
        ),
      ));
    const masterOwnsLurking = lurkingOwnerRows.some((r) => r.scope === "user");
    const characterLurkingOwnership = new Set(
      lurkingOwnerRows.filter((r) => r.scope === "character").map((r) => r.ownerId),
    );
    // Phase 7 (migration 0161), room-presence Flair ownership. Same
    // lookup shape; gates the Flair tab's "Custom Room Entrance"
    // editor + the broadcaster's template substitution.
    const roomPresenceOwnerRows = await db
      .select({
        scope: earningLedger.scope,
        ownerId: earningLedger.ownerId,
      })
      .from(earningLedger)
      .where(and(
        eq(earningLedger.serverId, sid),
        eq(earningLedger.reason, "purchase_flair_room_presence"),
        or(
          and(eq(earningLedger.scope, "user"), eq(earningLedger.ownerId, me.id)),
          ...(charIds.length > 0
            ? [and(eq(earningLedger.scope, "character"), inArray(earningLedger.ownerId, charIds))]
            : []),
        ),
      ));
    const masterOwnsRoomPresence = roomPresenceOwnerRows.some((r) => r.scope === "user");
    const characterRoomPresenceOwnership = new Set(
      roomPresenceOwnerRows.filter((r) => r.scope === "character").map((r) => r.ownerId),
    );
    // Session-presence is master-only, no character lookup needed.
    const masterOwnsSessionPresence = (await db
      .select({ ownerId: earningLedger.ownerId })
      .from(earningLedger)
      .where(and(
        eq(earningLedger.serverId, sid),
        eq(earningLedger.reason, "purchase_flair_session_presence"),
        eq(earningLedger.scope, "user"),
        eq(earningLedger.ownerId, me.id),
      ))
      .limit(1)).length > 0;
    // Migration 0192, profile visitors counter + quote marquee
    // flairs. Same ownership-lookup shape; the CosmeticsTab card
    // reads `*Owned` to flip between Buy and Equip CTAs, and the
    // ProfileEditor Flair tab reads it independently for editor
    // gating on the matching identity.
    const profileVisitorsOwnerRows = await db
      .select({ scope: earningLedger.scope, ownerId: earningLedger.ownerId })
      .from(earningLedger)
      .where(and(
        eq(earningLedger.serverId, sid),
        eq(earningLedger.reason, "purchase_flair_profile_visitors"),
        or(
          and(eq(earningLedger.scope, "user"), eq(earningLedger.ownerId, me.id)),
          ...(charIds.length > 0
            ? [and(eq(earningLedger.scope, "character"), inArray(earningLedger.ownerId, charIds))]
            : []),
        ),
      ));
    const masterOwnsProfileVisitors = profileVisitorsOwnerRows.some((r) => r.scope === "user");
    const characterProfileVisitorsOwnership = new Set(
      profileVisitorsOwnerRows.filter((r) => r.scope === "character").map((r) => r.ownerId),
    );
    const profileMarqueeOwnerRows = await db
      .select({ scope: earningLedger.scope, ownerId: earningLedger.ownerId })
      .from(earningLedger)
      .where(and(
        eq(earningLedger.serverId, sid),
        eq(earningLedger.reason, "purchase_flair_profile_marquee"),
        or(
          and(eq(earningLedger.scope, "user"), eq(earningLedger.ownerId, me.id)),
          ...(charIds.length > 0
            ? [and(eq(earningLedger.scope, "character"), inArray(earningLedger.ownerId, charIds))]
            : []),
        ),
      ));
    const masterOwnsProfileMarquee = profileMarqueeOwnerRows.some((r) => r.scope === "user");
    const characterProfileMarqueeOwnership = new Set(
      profileMarqueeOwnerRows.filter((r) => r.scope === "character").map((r) => r.ownerId),
    );
    // Bundle every ENABLED name style on this response so the client
    // can inject the CSS + template lookup map once on app load
    // without a separate /earning/catalog fetch. Disabled rows are
    // omitted so the dashboard's Available list stays in sync with
    // what users can actually equip. Built-in rows ship with the
    // catalog regardless of `enabled` (admin can disable a seed
    // style temporarily), `enabled: false` filters them out from
    // both the rendering map and the buy list, which is what we
    // want.
    // Per-server catalog (migrations 0295-0299): the name-style, freeform-
    // border, and item catalogs now carry (server_id, key) PKs, so every read
    // is scoped to the resolved active server `sid`. Flag off → sid =
    // DEFAULT_SERVER_ID → today's Spire catalog, byte-identical.
    const styleRows = await db
      .select()
      .from(nameStyles)
      .where(and(eq(nameStyles.serverId, sid), eq(nameStyles.enabled, true)))
      .orderBy(asc(nameStyles.order));

    // Free-form borders catalog. Same enabled-only filter as name
    // styles, disabled rows still resolve on the renderer side
    // (owned but admin-disabled rows keep displaying), but they're
    // hidden from the buy list.
    const freeformBorderRows = await db
      .select()
      .from(freeformBorders)
      .where(and(eq(freeformBorders.serverId, sid), eq(freeformBorders.enabled, true)))
      .orderBy(asc(freeformBorders.order));

    // Items catalog. We ship ALL items (enabled or not) so the
    // inventory view can still resolve display data for items the
    // admin disabled after a user acquired them. The client filters
    // the Shop view down to `purchasable=true`. Payload is small,
    // typically <50 rows.
    const itemRows = await db
      .select()
      .from(items)
      .where(eq(items.serverId, sid))
      .orderBy(asc(items.order));
    const nowMs = Date.now();
    const itemCatalog = itemRows.map((r) => shapeItemCatalogRow(r, nowMs));

    // Room-transition catalog (migrations 0295-0299). Price / enabled /
    // sort_order are now PER-SERVER in the `room_transitions` table; the
    // human-readable label + description stay in the shared ROOM_TRANSITIONS
    // const (one source of truth for copy across every server). We COALESCE:
    // a server with a row overrides cost/enabled/order, a server with NO row
    // for a key falls back to the const default (ROOM_TRANSITION_PRICE,
    // enabled, const display order). Flag off → sid = DEFAULT_SERVER_ID →
    // whatever The Spire's rows say (or const defaults if unseeded).
    const transitionCatalog = await buildTransitionCatalog(db, sid);

    // Per-identity inventory. Master rows scope='user', character
    // rows scope='character'. Pulled in one query and partitioned
    // client-side into master/byCharacter shapes mirroring the
    // owned-styles / owned-borders payload structure.
    const charIdSet = new Set(charsOfMine.map((c) => c.id));
    const inventoryRows = await db
      .select()
      .from(identityInventory)
      .where(sql`${identityInventory.serverId} = ${sid} AND ((${identityInventory.ownerScope} = 'user' AND ${identityInventory.ownerId} = ${me.id})
        OR (${identityInventory.ownerScope} = 'character' AND ${identityInventory.ownerId} IN (${
        // Empty IN () is invalid SQL, guard with a sentinel that
        // can't match any real character id when the user has none.
        charIdSet.size > 0
          ? sql.join(Array.from(charIdSet).map((id) => sql`${id}`), sql`, `)
          : sql`''`
      })))`);
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

    // Per-identity Collection, 10-slot pinned showcase keyed by
    // (ownerScope, ownerId). Same partitioning as inventory; each
    // identity's pins are independent. The client renders sparse
    // slot maps directly, so we ship the rows as-is rather than
    // normalizing to a length-10 array.
    const collectionRows = await db
      .select()
      .from(identityCollection)
      .where(sql`${identityCollection.serverId} = ${sid} AND ((${identityCollection.ownerScope} = 'user' AND ${identityCollection.ownerId} = ${me.id})
        OR (${identityCollection.ownerScope} = 'character' AND ${identityCollection.ownerId} IN (${
        charIdSet.size > 0
          ? sql.join(Array.from(charIdSet).map((id) => sql`${id}`), sql`, `)
          : sql`''`
      })))`);
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

    // Pet Collection, separate 5-slot table for items with
    // category='pet'. Same partition structure; client renders these
    // under a distinct "Pets" sub-view in the Items tab and as a
    // distinct section on the profile.
    const petCollectionRows = await db
      .select()
      .from(identityPetCollection)
      .where(sql`${identityPetCollection.serverId} = ${sid} AND ((${identityPetCollection.ownerScope} = 'user' AND ${identityPetCollection.ownerId} = ${me.id})
        OR (${identityPetCollection.ownerScope} = 'character' AND ${identityPetCollection.ownerId} IN (${
        charIdSet.size > 0
          ? sql.join(Array.from(charIdSet).map((id) => sql`${id}`), sql`, `)
          : sql`''`
      })))`);
    const petCollectionMaster: { slot: number; itemKey: string; nickname: string | null }[] = [];
    const petCollectionByCharacter: Record<string, { slot: number; itemKey: string; nickname: string | null }[]> = {};
    for (const row of petCollectionRows) {
      const shaped = { slot: row.slot, itemKey: row.itemKey, nickname: row.nickname ?? null };
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
      // Per-server subsystem toggles (migration 0293): a disabled subsystem
      // ships an EMPTY section so the client hides its tab. ranks_enabled gates
      // BOTH ranks + rankTiers (the ladder is one subsystem); borders_enabled
      // gates freeformBorders (rank-tier borders ride rankTiers, so they fall
      // away with ranks too). DEFAULT_SERVER_ID / flag-off → all-ON.
      catalog: {
        ranks: toggles.ranks ? rankRows.map((r) => ({
          key: r.key,
          name: r.name,
          order: r.order,
          enabled: !!r.enabled,
        })) : [],
        rankTiers: toggles.ranks ? tierRows.map((t) => ({
          id: t.id,
          rankKey: t.rankKey,
          tier: t.tier,
          label: t.label,
          xpThreshold: t.xpThreshold,
          sigilImageUrl: t.sigilImageUrl,
          borderImageUrl: t.borderImageUrl,
          borderCost: t.borderCost,
          enabled: !!t.enabled,
        })) : [],
        nameStyles: toggles.nameStyles ? styleRows.map((r) => ({
          key: r.key,
          name: r.name,
          description: r.description,
          template: r.template,
          styleCss: r.styleCss,
          cost: r.cost,
          isBuiltin: !!r.isBuiltin,
          order: r.order,
        })) : [],
        // Free-form borders catalog, shipped alongside name styles so
        // the client can inject any template+CSS rows once on the
        // dashboard open. `image_url` rows render as overlay <img>;
        // `template`+`style_css` rows feed the catalog CSS injector
        // (mirror of the name-style injector).
        freeformBorders: toggles.borders ? freeformBorderRows.map((r) => ({
          key: r.key,
          name: r.name,
          description: r.description,
          imageUrl: r.imageUrl,
          template: r.template,
          styleCss: r.styleCss,
          rarity: r.rarity,
          cost: r.cost,
          isBuiltin: !!r.isBuiltin,
          order: r.order,
        })) : [],
        items: toggles.shop ? itemCatalog : [],
        // Per-server room-transition catalog (migrations 0295-0299). cost /
        // enabled / order come from this server's `room_transitions` rows
        // (const defaults when unseeded); label + description from the shared
        // const. The client previously read the whole catalog from the shared
        // const — surfacing it here lets a server re-price / disable / re-rank
        // its transitions without a code change.
        roomTransitions: toggles.roomTransitions ? transitionCatalog : [],
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
      ownedFreeformBorders: ownedFreeformBorderRows.map((r) => ({
        borderKey: r.borderKey,
        // Per-identity color customization (migration 0158). JSON
        // string keyed by var-name without the `--c-` prefix; the
        // client parses + filters against the catalog's declared
        // var set when rendering.
        configJson: r.configJson,
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
      ownedFreeformBordersByCharacter: groupByCharacter(charOwnedFreeformBorderRows, (r) => ({
        borderKey: r.borderKey,
        configJson: r.configJson,
        acquiredAt: +r.acquiredAt,
      })),
      // Per-identity inventory. `inventory` is the master/OOC pool;
      // `inventoryByCharacter[characterId]` is the character pool.
      // Every identity is fully isolated, moving items across them
      // requires `/give` between two of the user's own identities, the
      // only legal cross-partition transfer.
      inventory: inventoryMaster,
      inventoryByCharacter,
      // Per-identity Collection pins (10-slot showcase), same
      // partition rules as inventory. Slots are sparse; each entry
      // carries `slot` (0..9) + `itemKey`. Items pinned here have
      // category != 'pet'; pets live in `petCollection`.
      collection: collectionMaster,
      collectionByCharacter,
      // Per-identity Pet Collection pins (5-slot showcase). Same
      // partition rules. Only items with `category='pet'` are
      // pinnable here, the PUT endpoint validates and rejects
      // mismatches with a 403.
      petCollection: petCollectionMaster,
      petCollectionByCharacter,
      activeCosmetics: {
        // Master / OOC slot. Same shape as before, the existing
        // dashboard reads these two fields directly for the master
        // identity tab.
        inlineAvatarEnabled: !!activeCosmeticsRow?.inlineAvatarEnabled,
        activeNameStyleKey: activeCosmeticsRow?.activeNameStyleKey ?? null,
        // Profile-banner URL for master/OOC. Null = no banner. Gated
        // server-side by the `flair_profile_banner` purchase; the
        // column is only writable through PATCH /earning/me/banner.
        profileBannerUrl: activeCosmeticsRow?.profileBannerUrl ?? null,
        profileBannerOwned: masterOwnsBanner,
        // Phase 5 custom typing phrase, same per-identity pattern
        // as the banner. Null phrase = use the default "is typing…"
        // suffix. The Flair tab uses `typingPhraseOwned` to gate
        // the editor between "Buy" and "Set phrase".
        typingPhrase: masterEarningRow?.typingPhrase ?? null,
        typingPhraseOwned: masterOwnsTypingPhrase,
        // Phase 6 Lurking Master Flair, when true, the typing
        // indicator hides this user from non-admin receivers.
        lurkingMasterEnabled: !!activeCosmeticsRow?.lurkingMasterEnabled,
        lurkingMasterOwned: masterOwnsLurking,
        // Phase 7 (migration 0161), custom room-presence templates
        // for the master/OOC identity. The Flair tab uses
        // `roomPresenceOwned` to gate the editor between Buy / Set;
        // the broadcaster reads these column values to substitute
        // into the join/leave system lines.
        roomJoinTemplate: masterEarningRow?.roomJoinTemplate ?? null,
        roomLeaveTemplate: masterEarningRow?.roomLeaveTemplate ?? null,
        roomPresenceOwned: masterOwnsRoomPresence,
        // Session-presence (master only). No per-character mirror,
        // characters are sub-identities of the account session.
        sessionConnectTemplate: masterEarningRow?.sessionConnectTemplate ?? null,
        sessionExitTemplate: masterEarningRow?.sessionExitTemplate ?? null,
        sessionPresenceOwned: masterOwnsSessionPresence,
        // Migration 0192, profile flairs. `*Owned` gates the
        // CosmeticsTab Buy/Equip CTA; the per-identity values + the
        // editor live on the actual profile-flair endpoints (this
        // snapshot only carries the ownership flag for the catalog).
        profileVisitorsOwned: masterOwnsProfileVisitors,
        profileMarqueeOwned: masterOwnsProfileMarquee,
        // Room-transition cosmetic (migration 0219). `activeRoomTransitionKey`
        // null = instant switch (the default). `ownedTransitionKeys` lists only
        // purchased transitions — none are free. The shop reads both for the
        // Buy/Equip CTAs.
        activeRoomTransitionKey: activeCosmeticsRow?.activeRoomTransitionKey ?? null,
        ownedTransitionKeys: Array.from(masterOwnedTransitions),
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
              profileBannerUrl: r.profileBannerUrl ?? null,
              profileBannerOwned: characterBannerOwnership.has(r.characterId),
              selectedFreeformBorderKey: r.selectedFreeformBorderKey ?? null,
              typingPhrase: r.typingPhrase ?? null,
              typingPhraseOwned: characterTypingPhraseOwnership.has(r.characterId),
              lurkingMasterEnabled: !!r.lurkingMasterEnabled,
              lurkingMasterOwned: characterLurkingOwnership.has(r.characterId),
              roomJoinTemplate: r.roomJoinTemplate ?? null,
              roomLeaveTemplate: r.roomLeaveTemplate ?? null,
              roomPresenceOwned: characterRoomPresenceOwnership.has(r.characterId),
              // Migration 0192, per-character profile flair ownership.
              profileVisitorsOwned: characterProfileVisitorsOwnership.has(r.characterId),
              profileMarqueeOwned: characterProfileMarqueeOwnership.has(r.characterId),
              // Room transition (migration 0219), per character.
              activeRoomTransitionKey: r.activeRoomTransitionKey ?? null,
              ownedTransitionKeys: Array.from(
                characterOwnedTransitions.get(r.characterId) ?? new Set<string>(),
              ),
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
  // Public earning view for one IDENTITY.
  //
  // The endpoint takes a userId in the path and an OPTIONAL
  // `?characterId=` query. The identity rule is the project's
  // load-bearing contract: a character is its own account from the
  // earning system's perspective, distinct pool row, distinct rank,
  // distinct cosmetics, distinct privacy flags. Reading the master
  // pool to render a character profile leaks the OOC owner's XP /
  // currency / border / rank onto a fresh character that should be
  // showing zero across the board. The `characterId` query routes
  // through `characterEarning` so character profiles read their own
  // pool exclusively; without the query (or with characterId = "")
  // the response is the master/OOC pool, as before.
  //
  // We still validate the character against `users.id` in the path
  // so callers can't ask for "user X's pool for character Y" when Y
  // belongs to a different account, that'd be a per-identity
  // ownership leak in the other direction.
  app.get<{ Params: { id: string }; Querystring: { characterId?: string } }>(
    "/earning/users/:id",
    async (req, reply) => {
      const target = (await db
        .select({ id: users.id, username: users.username, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, req.params.id))
        .limit(1))[0];
      if (!target || target.disabledAt) { reply.code(404); return { error: "not found" }; }
      const me = await getSessionUser(req, db);

      const rawCharId = req.query.characterId;
      const characterId = typeof rawCharId === "string" && rawCharId.length > 0 ? rawCharId : null;
      let character: { id: string; name: string } | null = null;
      if (characterId) {
        const c = (await db
          .select({ id: characters.id, name: characters.name, userId: characters.userId, deletedAt: characters.deletedAt })
          .from(characters)
          .where(eq(characters.id, characterId))
          .limit(1))[0];
        // Character must exist, belong to the path's user, and not
        // be soft-deleted. Mismatch → 404 (don't reveal whether the
        // id is wrong vs cross-account).
        if (!c || c.userId !== target.id || c.deletedAt) {
          reply.code(404);
          return { error: "not found" };
        }
        character = { id: c.id, name: c.name };
      }

      // Multi-Server Lift: anchor this profile slice to the OWNER's favorite
      // server (resolveProfileServerId), matching profileFlair.ts and the
      // /profile command — so the rank / XP / currency / border a profile
      // card shows all come from the SAME server as its equipped flair,
      // instead of always the home server. The hide-currency / hide-xp flags
      // stay on the master row below; they're account-level privacy prefs,
      // not per-server.
      const profileServerId = await resolveProfileServerId(db, target.id);
      const { rankByKey, tierByKey } = await loadRankTierLookup(db);
      const view = character
        ? await buildCharacterPoolView(db, character.id, character.name, rankByKey, tierByKey, profileServerId)
        : await buildUserPoolView(db, target.id, target.username, rankByKey, tierByKey, profileServerId);
      if (!view) { reply.code(404); return { error: "no earning" }; }

      // Privacy flags live on the master row (per-account preference),
      // even for character views. `buildCharacterPoolView` doesn't
      // populate `hideCurrencyCount` / `hideXpCount` because the
      // character pool has no privacy concept of its own; pull the
      // flags from the master pool view if we need them for redaction.
      const isSelf = me?.id === target.id;
      let hideCurrencyCount = false;
      let hideXpCount = false;
      if (character) {
        const masterFlags = (await db
          .select({ hideCurrencyCount: userEarning.hideCurrencyCount, hideXpCount: userEarning.hideXpCount })
          .from(userEarning)
          .where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, target.id)))
          .limit(1))[0];
        hideCurrencyCount = masterFlags?.hideCurrencyCount ?? false;
        hideXpCount = masterFlags?.hideXpCount ?? false;
      } else {
        hideCurrencyCount = view.hideCurrencyCount ?? false;
        hideXpCount = view.hideXpCount ?? false;
      }
      const showCurrency = !hideCurrencyCount || isSelf;
      const showXp = !hideXpCount || isSelf;

      // Defense-in-depth ownership re-verification.
      //
      // The equip endpoints already validate ownership on WRITE, so a
      // valid path can't persist a border the identity doesn't own.
      // BUT, admin revokes, migrations, manual SQL, and any future
      // bug can leave a stale `selected_*_border_*` value pointing at
      // a key that's no longer in the identity's ownership table. If
      // we returned the stale key, the BorderedAvatar client renderer
      // would happily paint the catalog row (it doesn't re-check
      // ownership), leaking a locked border onto a profile that
      // doesn't actually own it.
      //
      // Re-checking here costs at most two indexed lookups per request
      // and guarantees the public profile never shows a border the
      // identity has lost (or never owned via a stale row write).
      let resolvedRankBorderKey: string | null = view.selectedBorderRankKey;
      let resolvedFreeformBorderKey: string | null = view.selectedFreeformBorderKey;
      if (resolvedRankBorderKey) {
        const ownsRank = character
          ? (await db
              .select({ rankKey: characterOwnedBorders.rankKey })
              .from(characterOwnedBorders)
              .where(and(
                eq(characterOwnedBorders.serverId, profileServerId),
                eq(characterOwnedBorders.characterId, character.id),
                eq(characterOwnedBorders.rankKey, resolvedRankBorderKey),
              ))
              .limit(1))[0]
          : (await db
              .select({ rankKey: userOwnedBorders.rankKey })
              .from(userOwnedBorders)
              .where(and(
                eq(userOwnedBorders.serverId, profileServerId),
                eq(userOwnedBorders.userId, target.id),
                eq(userOwnedBorders.rankKey, resolvedRankBorderKey),
              ))
              .limit(1))[0];
        if (!ownsRank) resolvedRankBorderKey = null;
      }
      if (resolvedFreeformBorderKey) {
        const ownsFreeform = character
          ? (await db
              .select({ borderKey: characterOwnedFreeformBorders.borderKey })
              .from(characterOwnedFreeformBorders)
              .where(and(
                eq(characterOwnedFreeformBorders.serverId, profileServerId),
                eq(characterOwnedFreeformBorders.characterId, character.id),
                eq(characterOwnedFreeformBorders.borderKey, resolvedFreeformBorderKey),
              ))
              .limit(1))[0]
          : (await db
              .select({ borderKey: userOwnedFreeformBorders.borderKey })
              .from(userOwnedFreeformBorders)
              .where(and(
                eq(userOwnedFreeformBorders.serverId, profileServerId),
                eq(userOwnedFreeformBorders.userId, target.id),
                eq(userOwnedFreeformBorders.borderKey, resolvedFreeformBorderKey),
              ))
              .limit(1))[0];
        if (!ownsFreeform) resolvedFreeformBorderKey = null;
      }

      // Hero portrait on the public profile renders the OWNING
      // identity's free-form border with that identity's per-identity
      // color customization. Char-scope customizations come from
      // `character_owned_freeform_borders`; master from
      // `user_owned_freeform_borders`. Only fetched when ownership
      // survived the re-check above.
      let freeformBorderConfigJson: string | null = null;
      if (resolvedFreeformBorderKey) {
        if (character) {
          const row = (await db
            .select({ configJson: characterOwnedFreeformBorders.configJson })
            .from(characterOwnedFreeformBorders)
            .where(and(
              eq(characterOwnedFreeformBorders.serverId, profileServerId),
              eq(characterOwnedFreeformBorders.characterId, character.id),
              eq(characterOwnedFreeformBorders.borderKey, resolvedFreeformBorderKey),
            ))
            .limit(1))[0];
          freeformBorderConfigJson = row?.configJson ?? null;
        } else {
          const row = (await db
            .select({ configJson: userOwnedFreeformBorders.configJson })
            .from(userOwnedFreeformBorders)
            .where(and(
              eq(userOwnedFreeformBorders.serverId, profileServerId),
              eq(userOwnedFreeformBorders.userId, target.id),
              eq(userOwnedFreeformBorders.borderKey, resolvedFreeformBorderKey),
            ))
            .limit(1))[0];
          freeformBorderConfigJson = row?.configJson ?? null;
        }
      }
      return {
        userId: target.id,
        username: target.username,
        ...(character ? { characterId: character.id } : {}),
        // Both XP and Currency honor independent privacy flags. Rank +
        // tier + sigil stay public regardless, rank is the identity's
        // public tag.
        xp: showXp ? view.xp : null,
        currency: showCurrency ? view.currency : null,
        rankKey: view.rankKey,
        tier: view.tier,
        rankName: view.rankName,
        tierLabel: view.tierLabel,
        sigilImageUrl: view.sigilImageUrl,
        selectedBorderRankKey: resolvedRankBorderKey,
        selectedFreeformBorderKey: resolvedFreeformBorderKey,
        freeformBorderConfigJson,
      };
    },
  );

  /**
   * Public leaderboards across the nine earning boards. No auth,
   * the dashboard's Rankings tab paints this for anyone with the
   * modal open. Per-pool privacy filters (`hideCurrencyCount`,
   * `hideXpCount`, `users.isPublic = false`, soft-delete) live
   * inside the engine so each board enforces its own gates.
   */
  // Public leaderboards are recomputed live per request (full-table COUNT/SUM
  // aggregates over messages/inventory/stories), so an uncapped poll or a
  // looping client turns them into a DB-load amplifier on the synchronous
  // SQLite loop. Per-IP cap is generous vs the dashboard's occasional fetch;
  // the proper follow-up is a short-TTL server cache on the ranking builders.
  const rankingsLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } } as const;
  app.get("/earning/rankings", rankingsLimit, async () => {
    return await buildRankings(db);
  });

  /**
   * Public per-game rankings for the social-game system. Returns one
   * leaderboard per game_kind that has any data, plus an "overall"
   * combined leaderboard summing wins across all games. The set of
   * games is derived from the `game_stats` table at read time, so a
   * newly added social game lights up here automatically the moment
   * its first winner is recorded.
   *
   * Friendly labels: known game kinds get hand-tuned labels; unknown
   * kinds fall back to titlecasing the kind itself. Both `wins` and
   * `points` are surfaced per row so the UI can offer the right
   * sort for accumulating-score games (scramble) vs binary-win
   * games (rps, trivia, duel, raffle).
   */
  app.get("/earning/game-rankings", rankingsLimit, async () => {
    return await buildGameRankings(db);
  });

  app.get("/earning/familiar-rankings", rankingsLimit, async () => {
    return await buildFamiliarRankings(db);
  });

  /**
   * Public Scriptorium leaderboards. AUTHOR boards (Top Publishers, Most Words)
   * rank authoring identities; BOOK boards (Top Books by applause, Highest
   * Rated by reviews) rank the books themselves. Computed live from the story
   * rollups — no registration, surfaces the moment data exists.
   */
  app.get("/earning/scriptorium-rankings", rankingsLimit, async () => {
    return await buildScriptoriumRankings(db);
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
  app.get<{ Querystring: { cursor?: string; limit?: string; scope?: string; characterId?: string; serverId?: string } }>(
    "/earning/me/ledger",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      // Per-server economy (migration 0299): earning_ledger rows carry a
      // server_id, so the activity history is scoped to ONE server's pool.
      // Resolve the active server the same way every other earning route does;
      // flag off / non-member / default → DEFAULT_SERVER_ID, byte-identical to
      // the legacy single-pool history.
      const sid = await resolveActiveServerId(me, req.query.serverId);
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
            eq(earningLedger.serverId, sid),
            eq(earningLedger.scope, scope),
            eq(earningLedger.ownerId, ownerId),
            lt(earningLedger.createdAt, new Date(cursorMs)),
          )
        : and(eq(earningLedger.serverId, sid), eq(earningLedger.scope, scope), eq(earningLedger.ownerId, ownerId));
      const rows = await db
        .select()
        .from(earningLedger)
        .where(where)
        .orderBy(desc(earningLedger.createdAt))
        .limit(limit + 1);
      const { page, nextCursor } = cursorPageSlice(rows, limit, (r) => +r.createdAt);
      return {
        entries: page.map((r) => ({
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
   * Unacknowledged rank-ups for the chat ribbon. Cap defaults to 25
   * (the notifications helper enforces this).
   */
  app.get("/earning/me/notifications", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    return { notifications: await listUnacknowledged(db, me.id) };
  });

  /**
   * Catalog endpoint, what's available to buy / equip. Public so the
   * dashboard can render previews to users who haven't bought
   * anything yet. Returns enabled name styles + cosmetics, but
   * filters disabled rows so the UI doesn't accidentally let users
   * try to buy something the admin has shut off.
   */
  app.get<{ Querystring: { serverId?: string } }>("/earning/catalog", async (req) => {
    // Per-server catalog (migrations 0295-0299). The endpoint stays public,
    // but the catalog it returns is now server-scoped: an authenticated member
    // passing `?serverId=` gets that server's slice; anonymous callers (or a
    // non-member / flag-off) fall back to DEFAULT_SERVER_ID so the previews on
    // the splash stay byte-identical to the legacy single-server behavior.
    const me = await getSessionUser(req, db);
    const sid = me ? await resolveActiveServerId(me, req.query.serverId) : DEFAULT_SERVER_ID;
    // Per-server subsystem toggles (migration 0293): an off subsystem ships an
    // EMPTY section so the preview hides it. name_styles_enabled → nameStyles;
    // cosmetics_enabled → cosmetics; shop_enabled → items. DEFAULT_SERVER_ID /
    // flag-off → all-ON, byte-identical.
    const toggles = await resolveSubsystemToggles(sid);
    const styleRows = await db
      .select()
      .from(nameStyles)
      .where(and(eq(nameStyles.serverId, sid), eq(nameStyles.enabled, true)))
      .orderBy(asc(nameStyles.order));
    const cosmeticRows = await db
      .select()
      .from(cosmetics)
      .where(and(eq(cosmetics.serverId, sid), eq(cosmetics.enabled, true)));
    const itemRows = await db
      .select()
      .from(items)
      .where(and(eq(items.serverId, sid), eq(items.enabled, true)))
      .orderBy(asc(items.order));
    const nowMs = Date.now();
    return {
      nameStyles: toggles.nameStyles ? styleRows.map((r) => ({
        key: r.key,
        name: r.name,
        description: r.description,
        template: r.template,
        styleCss: r.styleCss,
        cost: r.cost,
        isBuiltin: !!r.isBuiltin,
        order: r.order,
      })) : [],
      cosmetics: toggles.cosmetics ? cosmeticRows.map((r) => ({
        key: r.key,
        name: r.name,
        description: r.description,
        cost: r.cost,
        config: r.configJson ? safeParse(r.configJson) : null,
      })) : [],
      items: toggles.shop ? itemRows.map((r) => shapeItemCatalogRow(r, nowMs)) : [],
    };
  });

  /**
   * GET /earning/flash-sale
   *
   * Today's flash-sale picks across all categories, with the
   * effective discount % per pick and a hydrated catalog snippet
   * so the client can render the Overview section without a
   * second fetch (name + base price → discounted price). Anonymous
   * callers get the same payload, sale info is public so the
   * "Currency 25% off Embers today" banner can show on the splash.
   *
   * The resolver lazily writes today's row on first read, so this
   * endpoint is the canonical "kick off rollover" path. Calls are
   * cheap (single row read on the warm path).
   */
  app.get<{ Querystring: { serverId?: string } }>("/earning/flash-sale", async (req) => {
    // Per-server flash sales + catalog hydration (migration 0299). The sale
    // PICKS now resolve per server (resolveTodayFlashSale is scoped to `sid`),
    // and the catalog rows we hydrate against (name_styles / items / cosmetics /
    // freeform_borders) carry (server_id, key) PKs so they're read scoped to the
    // active server too, or a key would resolve ambiguously across servers.
    // Anonymous / non-member / flag-off → DEFAULT_SERVER_ID (byte-identical).
    const me = await getSessionUser(req, db);
    const sid = me ? await resolveActiveServerId(me, req.query.serverId) : DEFAULT_SERVER_ID;
    const sale = await resolveTodayFlashSale(db, new Date(), sid);
    // Hydrate, but only surface rows the user can actually buy right
    // now. Admin overrides win at PICK time (intent over availability),
    // but if the admin then disables the picked row mid-day, the user
    // shouldn't see "Embers on sale!" with a Buy button that'd 404 on
    // click. Same gate the purchase path uses (enabled / for_sale /
    // sale window).
    const nowMs = Date.now();
    const styleRow = sale.nameStyleKey
      ? (await db.select().from(nameStyles).where(and(eq(nameStyles.serverId, sid), eq(nameStyles.key, sale.nameStyleKey))).limit(1))[0] ?? null
      : null;
    const styleBuyable = !!styleRow && styleRow.enabled && styleRow.cost > 0;
    const itemRow = sale.itemKey
      ? (await db.select().from(items).where(and(eq(items.serverId, sid), eq(items.key, sale.itemKey))).limit(1))[0] ?? null
      : null;
    const itemBuyable = !!itemRow
      && itemRow.enabled
      && itemRow.forSale
      && itemRow.price > 0
      && (!itemRow.saleStartsAt || +itemRow.saleStartsAt <= nowMs)
      && (!itemRow.saleEndsAt || +itemRow.saleEndsAt > nowMs);
    const cosmeticRow = sale.cosmeticKey
      ? (await db.select().from(cosmetics).where(and(eq(cosmetics.serverId, sid), eq(cosmetics.key, sale.cosmeticKey))).limit(1))[0] ?? null
      : null;
    const cosmeticBuyable = !!cosmeticRow && cosmeticRow.enabled && cosmeticRow.cost > 0;
    const freeformBorderRow = sale.freeformBorderKey
      ? (await db.select().from(freeformBorders).where(and(eq(freeformBorders.serverId, sid), eq(freeformBorders.key, sale.freeformBorderKey))).limit(1))[0] ?? null
      : null;
    const freeformBorderBuyable = !!freeformBorderRow && freeformBorderRow.enabled && freeformBorderRow.cost > 0;
    return {
      forDate: sale.forDate,
      nameStyle: styleBuyable && styleRow ? {
        key: styleRow.key,
        name: styleRow.name,
        basePrice: styleRow.cost,
        salePrice: applyDiscount(styleRow.cost, sale.nameStyleDiscountPct),
        discountPct: sale.nameStyleDiscountPct,
      } : null,
      item: itemBuyable && itemRow ? {
        key: itemRow.key,
        name: itemRow.name,
        iconUrl: itemRow.iconUrl,
        basePrice: itemRow.price,
        salePrice: applyDiscount(itemRow.price, sale.itemDiscountPct),
        discountPct: sale.itemDiscountPct,
      } : null,
      cosmetic: cosmeticBuyable && cosmeticRow ? {
        key: cosmeticRow.key,
        name: cosmeticRow.name,
        basePrice: cosmeticRow.cost,
        salePrice: applyDiscount(cosmeticRow.cost, sale.cosmeticDiscountPct),
        discountPct: sale.cosmeticDiscountPct,
      } : null,
      freeformBorder: freeformBorderBuyable && freeformBorderRow ? {
        key: freeformBorderRow.key,
        name: freeformBorderRow.name,
        basePrice: freeformBorderRow.cost,
        salePrice: applyDiscount(freeformBorderRow.cost, sale.freeformBorderDiscountPct),
        discountPct: sale.freeformBorderDiscountPct,
      } : null,
    };
  });

  /** Lightweight read of the equipped room transition for the current
   *  identity, so the chat client can play it on room switch without
   *  pulling the whole /earning/me snapshot. */
  app.get<{ Querystring: { characterId?: string; serverId?: string } }>("/earning/me/active-room-transition", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const sid = await resolveActiveServerId(me, req.query.serverId);
    const characterId = req.query.characterId ?? null;
    let key: string | null = null;
    if (characterId) {
      // Only read the caller's own character (consistent with purchase/equip).
      const c = (await db
        .select({ userId: characters.userId, deletedAt: characters.deletedAt })
        .from(characters).where(eq(characters.id, characterId)).limit(1))[0];
      if (!c || c.userId !== me.id || c.deletedAt) return { key: null };
      const row = (await db
        .select({ key: characterEarning.activeRoomTransitionKey })
        .from(characterEarning).where(and(eq(characterEarning.serverId, sid), eq(characterEarning.characterId, characterId))).limit(1))[0];
      key = row?.key ?? null;
    } else {
      const row = (await db
        .select({ key: userActiveCosmetics.activeRoomTransitionKey })
        .from(userActiveCosmetics).where(and(eq(userActiveCosmetics.serverId, sid), eq(userActiveCosmetics.userId, me.id))).limit(1))[0];
      key = row?.key ?? null;
    }
    return { key };
  });

}
