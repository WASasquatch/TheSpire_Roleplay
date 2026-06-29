/**
 * Earning, public + self routes.
 *
 * - `GET /earning/me` returns the caller's wallet + active-character
 *   earning + unacknowledged rank-up notifications + the catalog
 *   slice the dashboard needs (ranks, tiers, name styles, cosmetics).
 *
 * - `GET /earning/users/:id` returns the public slice, rank/tier
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
import { and, asc, desc, eq, inArray, like, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import {
  normalizePresenceTemplate,
  validatePresenceTemplate,
} from "@thekeep/shared";
import {
  extractFreeformBorderVars,
  isValidFreeformBorderConfigKey,
  isValidFreeformBorderConfigValue,
  FREEFORM_CONFIG_MAX_ENTRIES,
  PET_NICKNAME_MAX_LENGTH,
} from "@thekeep/shared";
import { getRoomTransition } from "@thekeep/shared";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;
import { nanoid } from "nanoid";
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
  users,
} from "../db/schema.js";
import { getSessionUser } from "./auth.js";
import { hasPermission } from "../auth/permissions.js";
import {
  ack as ackNotification,
  ackAllForUser,
  listUnacknowledged,
} from "../earning/notifications.js";
import {
  applyDiscount,
  resolveTodayFlashSale,
} from "../earning/flashSale.js";
import { buildRankings } from "../earning/rankings.js";
import { buildGameRankings } from "../earning/gameRankings.js";
import { buildFamiliarRankings } from "../earning/familiarRankings.js";
import { buildScriptoriumRankings } from "../earning/scriptoriumRankings.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
// creditPool is no longer called directly here, purchase endpoints
// run their own sqlite transaction (see `runPurchaseTxn` below) for
// atomicity. The award engine still imports it for the live earn
// paths (chat / forum / presence).

const LEDGER_PAGE_LIMIT = 50;

const patchSettingsBody = z.object({
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
  /** Freeform border equip slot, independent of the rank-tier slot.
   *  Resolution precedence (BorderedAvatar): freeform first, rank
   *  border as fallback. Null means no freeform border equipped. */
  selectedFreeformBorderKey: string | null;
  /** Only emitted on master pool, character pools cascade off this flag. */
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

async function buildCharacterPoolView(
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

export async function registerEarningRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /**
   * Re-broadcast occupant presence in every room the user has a live
   * socket in. Called after any change that affects how the user's
   * name renders to peers (name-style equip, border equip, inline-
   * avatar toggle, name-style color config), those cosmetics ride
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
   * same catalog), the wallet/ledger slices are per-user.
   */
  app.get<{ Querystring: { serverId?: string } }>("/earning/me", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    // Per-server economy: the dashboard reflects ONE server's pool
    // snapshot. The optional `?serverId=` picks it; absent (today's
    // single-server world, flag off) it resolves to DEFAULT_SERVER_ID, so
    // every read below is byte-identical to the legacy behavior. The
    // response SHAPE is unchanged — only the source server varies.
    const sid = req.query.serverId ?? DEFAULT_SERVER_ID;

    const { rankRows, tierRows, rankByKey, tierByKey } = await loadRankTierLookup(db);

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
    const styleRows = await db
      .select()
      .from(nameStyles)
      .where(eq(nameStyles.enabled, true))
      .orderBy(asc(nameStyles.order));

    // Free-form borders catalog. Same enabled-only filter as name
    // styles, disabled rows still resolve on the renderer side
    // (owned but admin-disabled rows keep displaying), but they're
    // hidden from the buy list.
    const freeformBorderRows = await db
      .select()
      .from(freeformBorders)
      .where(eq(freeformBorders.enabled, true))
      .orderBy(asc(freeformBorders.order));

    // Items catalog. We ship ALL items (enabled or not) so the
    // inventory view can still resolve display data for items the
    // admin disabled after a user acquired them. The client filters
    // the Shop view down to `purchasable=true`. Payload is small,
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
        // Free-form borders catalog, shipped alongside name styles so
        // the client can inject any template+CSS rows once on the
        // dashboard open. `image_url` rows render as overlay <img>;
        // `template`+`style_css` rows feed the catalog CSS injector
        // (mirror of the name-style injector).
        freeformBorders: freeformBorderRows.map((r) => ({
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

      const { rankByKey, tierByKey } = await loadRankTierLookup(db);
      const view = character
        ? await buildCharacterPoolView(db, character.id, character.name, rankByKey, tierByKey)
        : await buildUserPoolView(db, target.id, target.username, rankByKey, tierByKey);
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
                eq(characterOwnedBorders.serverId, DEFAULT_SERVER_ID),
                eq(characterOwnedBorders.characterId, character.id),
                eq(characterOwnedBorders.rankKey, resolvedRankBorderKey),
              ))
              .limit(1))[0]
          : (await db
              .select({ rankKey: userOwnedBorders.rankKey })
              .from(userOwnedBorders)
              .where(and(
                eq(userOwnedBorders.serverId, DEFAULT_SERVER_ID),
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
                eq(characterOwnedFreeformBorders.serverId, DEFAULT_SERVER_ID),
                eq(characterOwnedFreeformBorders.characterId, character.id),
                eq(characterOwnedFreeformBorders.borderKey, resolvedFreeformBorderKey),
              ))
              .limit(1))[0]
          : (await db
              .select({ borderKey: userOwnedFreeformBorders.borderKey })
              .from(userOwnedFreeformBorders)
              .where(and(
                eq(userOwnedFreeformBorders.serverId, DEFAULT_SERVER_ID),
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
              eq(characterOwnedFreeformBorders.serverId, DEFAULT_SERVER_ID),
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
              eq(userOwnedFreeformBorders.serverId, DEFAULT_SERVER_ID),
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
  app.get("/earning/rankings", async () => {
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
  app.get("/earning/game-rankings", async () => {
    return await buildGameRankings(db);
  });

  app.get("/earning/familiar-rankings", async () => {
    return await buildFamiliarRankings(db);
  });

  /**
   * Public Scriptorium leaderboards. AUTHOR boards (Top Publishers, Most Words)
   * rank authoring identities; BOOK boards (Top Books by applause, Highest
   * Rated by reviews) rank the books themselves. Computed live from the story
   * rollups — no registration, surfaces the moment data exists.
   */
  app.get("/earning/scriptorium-rankings", async () => {
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
   *     (validated against `user_owned_borders`, caller can't equip
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
      await db.insert(characterEarning).values({ serverId: DEFAULT_SERVER_ID, characterId }).onConflictDoNothing();
      if (body.selectedBorderRankKey !== undefined) {
        let value: string | null = null;
        if (body.selectedBorderRankKey !== null) {
          const owned = (await db
            .select()
            .from(characterOwnedBorders)
            .where(and(
              eq(characterOwnedBorders.serverId, DEFAULT_SERVER_ID),
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
          .where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, characterId)));
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
              eq(characterOwnedFreeformBorders.serverId, DEFAULT_SERVER_ID),
              eq(characterOwnedFreeformBorders.characterId, characterId),
              eq(characterOwnedFreeformBorders.borderKey, body.selectedFreeformBorderKey),
            ))
            .limit(1))[0];
          if (!owned) {
            reply.code(403);
            return { error: "this character doesn't own that border" };
          }
          value = body.selectedFreeformBorderKey;
        }
        await db
          .update(characterEarning)
          .set({ selectedFreeformBorderKey: value, updatedAt: new Date() })
          .where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, characterId)));
      }
      await rebroadcastPresenceForUser(me.id);
      return { ok: true };
    }

    // Master path, unchanged behavior.
    await db.insert(userEarning).values({ serverId: DEFAULT_SERVER_ID, userId: me.id }).onConflictDoNothing();

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
            eq(userOwnedBorders.serverId, DEFAULT_SERVER_ID),
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
    if (body.selectedFreeformBorderKey !== undefined) {
      if (body.selectedFreeformBorderKey === null) {
        update.selectedFreeformBorderKey = null;
      } else {
        const owned = (await db
          .select()
          .from(userOwnedFreeformBorders)
          .where(and(
            eq(userOwnedFreeformBorders.serverId, DEFAULT_SERVER_ID),
            eq(userOwnedFreeformBorders.userId, me.id),
            eq(userOwnedFreeformBorders.borderKey, body.selectedFreeformBorderKey),
          ))
          .limit(1))[0];
        if (!owned) {
          reply.code(403);
          return { error: "you don't own that border" };
        }
        update.selectedFreeformBorderKey = body.selectedFreeformBorderKey;
      }
    }
    if (Object.keys(update).length === 1) return { ok: true }; // only updatedAt, nothing to do
    await db.update(userEarning).set(update).where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, me.id)));
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
   * Catalog endpoint, what's available to buy / equip. Public so the
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
  app.get("/earning/flash-sale", async () => {
    const sale = await resolveTodayFlashSale(db);
    // Hydrate, but only surface rows the user can actually buy right
    // now. Admin overrides win at PICK time (intent over availability),
    // but if the admin then disables the picked row mid-day, the user
    // shouldn't see "Embers on sale!" with a Buy button that'd 404 on
    // click. Same gate the purchase path uses (enabled / for_sale /
    // sale window).
    const nowMs = Date.now();
    const styleRow = sale.nameStyleKey
      ? (await db.select().from(nameStyles).where(eq(nameStyles.key, sale.nameStyleKey)).limit(1))[0] ?? null
      : null;
    const styleBuyable = !!styleRow && styleRow.enabled && styleRow.cost > 0;
    const itemRow = sale.itemKey
      ? (await db.select().from(items).where(eq(items.key, sale.itemKey)).limit(1))[0] ?? null
      : null;
    const itemBuyable = !!itemRow
      && itemRow.enabled
      && itemRow.forSale
      && itemRow.price > 0
      && (!itemRow.saleStartsAt || +itemRow.saleStartsAt <= nowMs)
      && (!itemRow.saleEndsAt || +itemRow.saleEndsAt > nowMs);
    const cosmeticRow = sale.cosmeticKey
      ? (await db.select().from(cosmetics).where(eq(cosmetics.key, sale.cosmeticKey)).limit(1))[0] ?? null
      : null;
    const cosmeticBuyable = !!cosmeticRow && cosmeticRow.enabled && cosmeticRow.cost > 0;
    const freeformBorderRow = sale.freeformBorderKey
      ? (await db.select().from(freeformBorders).where(eq(freeformBorders.key, sale.freeformBorderKey)).limit(1))[0] ?? null
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

      // Resolve today's flash sale OUTSIDE the txn (resolveTodayFlashSale
      // may lazy-insert the day's row, which has to be async). Inside
      // validate() the lookup against this snapshot is a pure compare,
      // if the user is buying today's pick, the discount applies.
      const flashSale = await resolveTodayFlashSale(db);
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
              eq(characterOwnedNameStyles.serverId, DEFAULT_SERVER_ID),
              eq(characterOwnedNameStyles.characterId, characterId),
              eq(characterOwnedNameStyles.styleKey, req.params.key),
            )).limit(1).all()[0];
            if (already) return { ok: false, status: 409, error: "already owned" };
          } else {
            const already = tx.select().from(userOwnedNameStyles).where(and(
              eq(userOwnedNameStyles.serverId, DEFAULT_SERVER_ID),
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
              serverId: DEFAULT_SERVER_ID,
              characterId,
              styleKey: req.params.key,
              configJson: null,
            }).run();
          } else {
            tx.insert(userOwnedNameStyles).values({
              serverId: DEFAULT_SERVER_ID,
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
            eq(characterOwnedNameStyles.serverId, DEFAULT_SERVER_ID),
            eq(characterOwnedNameStyles.characterId, characterId),
            eq(characterOwnedNameStyles.styleKey, req.params.key),
          ))
          .limit(1))[0];
        if (!owned) { reply.code(404); return { error: "not owned" }; }
        await db
          .update(characterOwnedNameStyles)
          .set({ configJson: body.config ? JSON.stringify(body.config) : null })
          .where(and(
            eq(characterOwnedNameStyles.serverId, DEFAULT_SERVER_ID),
            eq(characterOwnedNameStyles.characterId, characterId),
            eq(characterOwnedNameStyles.styleKey, req.params.key),
          ));
      } else {
        const owned = (await db
          .select()
          .from(userOwnedNameStyles)
          .where(and(eq(userOwnedNameStyles.serverId, DEFAULT_SERVER_ID), eq(userOwnedNameStyles.userId, me.id), eq(userOwnedNameStyles.styleKey, req.params.key)))
          .limit(1))[0];
        if (!owned) { reply.code(404); return { error: "not owned" }; }
        await db
          .update(userOwnedNameStyles)
          .set({ configJson: body.config ? JSON.stringify(body.config) : null })
          .where(and(eq(userOwnedNameStyles.serverId, DEFAULT_SERVER_ID), eq(userOwnedNameStyles.userId, me.id), eq(userOwnedNameStyles.styleKey, req.params.key)));
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
      // a character equip the same style, they have to buy it
      // from their own pool.
      if (body.characterId) {
        const owned = (await db
          .select()
          .from(characterOwnedNameStyles)
          .where(and(
            eq(characterOwnedNameStyles.serverId, DEFAULT_SERVER_ID),
            eq(characterOwnedNameStyles.characterId, body.characterId),
            eq(characterOwnedNameStyles.styleKey, body.styleKey),
          ))
          .limit(1))[0];
        if (!owned) { reply.code(403); return { error: "this character doesn't own that style" }; }
      } else {
        const owned = (await db
          .select()
          .from(userOwnedNameStyles)
          .where(and(eq(userOwnedNameStyles.serverId, DEFAULT_SERVER_ID), eq(userOwnedNameStyles.userId, me.id), eq(userOwnedNameStyles.styleKey, body.styleKey)))
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
        .values({ serverId: DEFAULT_SERVER_ID, characterId: c.id, activeNameStyleKey: body.styleKey })
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
        .where(and(eq(userActiveCosmetics.serverId, DEFAULT_SERVER_ID), eq(userActiveCosmetics.userId, me.id)))
        .limit(1))[0];
      if (existing) {
        await db.update(userActiveCosmetics).set({
          activeNameStyleKey: body.styleKey,
          updatedAt: new Date(),
        }).where(and(eq(userActiveCosmetics.serverId, DEFAULT_SERVER_ID), eq(userActiveCosmetics.userId, me.id)));
      } else {
        await db.insert(userActiveCosmetics).values({
          serverId: DEFAULT_SERVER_ID,
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

  app.post<{ Params: { key: string }; Body: unknown }>(
    "/earning/me/cosmetics/:key/purchase",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
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
      const flashSale = await resolveTodayFlashSale(db);
      const outcome = runPurchaseTxn(db, me.id, {
        characterId,
        validate: (tx) => {
          const cosmetic = tx.select().from(cosmetics).where(eq(cosmetics.key, req.params.key)).limit(1).all()[0];
          if (!cosmetic || !cosmetic.enabled) return { ok: false, status: 404, error: "cosmetic not found or disabled" };
          // Per-identity ownership check. Master's prior purchase
          // does NOT count as ownership for a character (and vice
          // versa), each identity has its own ledger trail.
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
            tx.insert(characterEarning).values({ serverId: DEFAULT_SERVER_ID, characterId, inlineAvatarEnabled: true }).onConflictDoUpdate({
              target: [characterEarning.serverId, characterEarning.characterId],
              set: { inlineAvatarEnabled: true, updatedAt: new Date() },
            }).run();
          } else {
            const existing = tx.select().from(userActiveCosmetics).where(and(eq(userActiveCosmetics.serverId, DEFAULT_SERVER_ID), eq(userActiveCosmetics.userId, me.id))).limit(1).all()[0];
            if (existing) {
              tx.update(userActiveCosmetics)
                .set({ inlineAvatarEnabled: true, updatedAt: new Date() })
                .where(and(eq(userActiveCosmetics.serverId, DEFAULT_SERVER_ID), eq(userActiveCosmetics.userId, me.id)))
                .run();
            } else {
              tx.insert(userActiveCosmetics).values({
                serverId: DEFAULT_SERVER_ID,
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

  app.post<{ Params: { key: string }; Body: unknown }>(
    "/earning/me/cosmetics/:key/equip",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
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
        if (body.enabled && !(await hasPurchased("character", body.characterId, key))) {
          reply.code(403);
          return { error: "this character hasn't purchased it" };
        }
        await db
          .insert(characterEarning)
          .values({ serverId: DEFAULT_SERVER_ID, characterId: c.id, [cols.characterField]: body.enabled })
          .onConflictDoUpdate({
            target: [characterEarning.serverId, characterEarning.characterId],
            set: { [cols.characterField]: body.enabled, updatedAt: new Date() },
          });
      } else {
        if (body.enabled && !(await hasPurchased("user", me.id, key))) {
          reply.code(403);
          return { error: "purchase required" };
        }
        const existing = (await db
          .select()
          .from(userActiveCosmetics)
          .where(and(eq(userActiveCosmetics.serverId, DEFAULT_SERVER_ID), eq(userActiveCosmetics.userId, me.id)))
          .limit(1))[0];
        if (existing) {
          await db.update(userActiveCosmetics)
            .set({ [cols.masterField]: body.enabled, updatedAt: new Date() })
            .where(and(eq(userActiveCosmetics.serverId, DEFAULT_SERVER_ID), eq(userActiveCosmetics.userId, me.id)));
        } else {
          await db.insert(userActiveCosmetics).values({
            serverId: DEFAULT_SERVER_ID,
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
  app.post<{ Params: { key: string }; Body: unknown }>(
    "/earning/me/transitions/:key/purchase",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      if (!(await hasPermission(me, "use_room_transitions", db))) {
        reply.code(403); return { error: "Room transitions aren't available to you." };
      }
      const transition = getRoomTransition(req.params.key);
      if (!transition) { reply.code(404); return { error: "unknown transition" }; }
      if (transition.cost <= 0) { reply.code(409); return { error: "this transition is free" }; }
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
        validate: (tx) => {
          const existing = characterId
            ? tx.select({ id: earningLedger.id }).from(earningLedger).where(and(
                eq(earningLedger.serverId, DEFAULT_SERVER_ID),
                eq(earningLedger.scope, "character"),
                eq(earningLedger.ownerId, characterId),
                eq(earningLedger.reason, reason),
              )).limit(1).all()[0]
            : tx.select({ id: earningLedger.id }).from(earningLedger).where(and(
                eq(earningLedger.serverId, DEFAULT_SERVER_ID),
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
            tx.insert(characterEarning).values({ serverId: DEFAULT_SERVER_ID, characterId }).onConflictDoNothing().run();
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

  app.post<{ Body: unknown }>("/earning/me/active-room-transition", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "use_room_transitions", db))) {
      reply.code(403); return { error: "Room transitions aren't available to you." };
    }
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
      if (!(await hasPurchased(scope, ownerId, `transition_${key}`))) {
        reply.code(403); return { error: "you don't own that transition" };
      }
    }
    if (characterId) {
      const c = (await db
        .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
        .from(characters).where(eq(characters.id, characterId)).limit(1))[0];
      if (!c || c.userId !== me.id || c.deletedAt) { reply.code(403); return { error: "not your character" }; }
      await db
        .insert(characterEarning)
        .values({ serverId: DEFAULT_SERVER_ID, characterId: c.id, activeRoomTransitionKey: key })
        .onConflictDoUpdate({
          target: [characterEarning.serverId, characterEarning.characterId],
          set: { activeRoomTransitionKey: key, updatedAt: new Date() },
        });
    } else {
      const existing = (await db
        .select().from(userActiveCosmetics).where(and(eq(userActiveCosmetics.serverId, DEFAULT_SERVER_ID), eq(userActiveCosmetics.userId, me.id))).limit(1))[0];
      if (existing) {
        await db.update(userActiveCosmetics)
          .set({ activeRoomTransitionKey: key, updatedAt: new Date() })
          .where(and(eq(userActiveCosmetics.serverId, DEFAULT_SERVER_ID), eq(userActiveCosmetics.userId, me.id)));
      } else {
        await db.insert(userActiveCosmetics).values({ serverId: DEFAULT_SERVER_ID, userId: me.id, activeRoomTransitionKey: key });
      }
    }
    return { ok: true };
  });

  /** Lightweight read of the equipped room transition for the current
   *  identity, so the chat client can play it on room switch without
   *  pulling the whole /earning/me snapshot. */
  app.get<{ Querystring: { characterId?: string } }>("/earning/me/active-room-transition", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
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
        .from(characterEarning).where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, characterId))).limit(1))[0];
      key = row?.key ?? null;
    } else {
      const row = (await db
        .select({ key: userActiveCosmetics.activeRoomTransitionKey })
        .from(userActiveCosmetics).where(and(eq(userActiveCosmetics.serverId, DEFAULT_SERVER_ID), eq(userActiveCosmetics.userId, me.id))).limit(1))[0];
      key = row?.key ?? null;
    }
    return { key };
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

  app.patch<{ Body: unknown }>("/earning/me/banner", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
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
        return { error: "banner URL must start with http:// or https://" };
      }
      // Ownership gate is required only when SETTING (not clearing).
      // A user who lost the cosmetic via admin revoke can still clear
      // their stale banner; they just can't set a new one.
      const scope: "user" | "character" = characterId ? "character" : "user";
      const ownerId = characterId ?? me.id;
      if (!(await hasPurchased(scope, ownerId, "flair_profile_banner"))) {
        reply.code(403);
        return { error: "purchase 'Custom Profile Banner' to set a banner URL" };
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
          return { error: `URL doesn't appear to be an image (Content-Type: ${ct})` };
        }
      } catch {
        // Network blip, CORS, abort, server hates HEAD, allow.
      }
    }
    if (characterId) {
      await db
        .insert(characterEarning)
        .values({ serverId: DEFAULT_SERVER_ID, characterId, profileBannerUrl: final })
        .onConflictDoUpdate({
          target: [characterEarning.serverId, characterEarning.characterId],
          set: { profileBannerUrl: final, updatedAt: new Date() },
        });
    } else {
      const existing = (await db
        .select()
        .from(userActiveCosmetics)
        .where(and(eq(userActiveCosmetics.serverId, DEFAULT_SERVER_ID), eq(userActiveCosmetics.userId, me.id)))
        .limit(1))[0];
      if (existing) {
        await db.update(userActiveCosmetics)
          .set({ profileBannerUrl: final, updatedAt: new Date() })
          .where(and(eq(userActiveCosmetics.serverId, DEFAULT_SERVER_ID), eq(userActiveCosmetics.userId, me.id)));
      } else {
        await db.insert(userActiveCosmetics).values({
          serverId: DEFAULT_SERVER_ID,
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

  app.patch<{ Body: unknown }>("/earning/me/typing-phrase", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
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
        return { error: `phrase must be ${TYPING_PHRASE_MAX} characters or fewer` };
      }
      // Ownership gate only when SETTING (clearing is always allowed
      //, a user whose flair was revoked can still drop their stale
      // phrase). Same pattern as the banner.
      const scope: "user" | "character" = characterId ? "character" : "user";
      const ownerId = characterId ?? me.id;
      if (!(await hasPurchased(scope, ownerId, "flair_typing_phrase"))) {
        reply.code(403);
        return { error: "purchase 'Custom Typing Phrase' to set a custom phrase" };
      }
    }
    if (characterId) {
      await db
        .insert(characterEarning)
        .values({ serverId: DEFAULT_SERVER_ID, characterId, typingPhrase: final })
        .onConflictDoUpdate({
          target: [characterEarning.serverId, characterEarning.characterId],
          set: { typingPhrase: final, updatedAt: new Date() },
        });
    } else {
      await db
        .insert(userEarning)
        .values({ serverId: DEFAULT_SERVER_ID, userId: me.id, typingPhrase: final })
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

  app.patch<{ Body: unknown }>("/earning/me/room-presence", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
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
      if (!(await hasPurchased(scope, ownerId, "flair_room_presence"))) {
        reply.code(403);
        return { error: "purchase 'Custom Room Entrance' to set custom presence templates" };
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
          .values({ serverId: DEFAULT_SERVER_ID, characterId, ...updates })
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
        .where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, characterId)))
        .limit(1))[0];
      return { ok: true, joinTemplate: row?.roomJoinTemplate ?? null, leaveTemplate: row?.roomLeaveTemplate ?? null };
    }
    if (Object.keys(updates).length > 1) {
      await db
        .insert(userEarning)
        .values({ serverId: DEFAULT_SERVER_ID, userId: me.id, ...updates })
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
      .where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, me.id)))
      .limit(1))[0];
    return { ok: true, joinTemplate: row?.roomJoinTemplate ?? null, leaveTemplate: row?.roomLeaveTemplate ?? null };
  });

  const setSessionPresenceBody = z.object({
    connectTemplate: z.string().max(500).nullable().optional(),
    exitTemplate: z.string().max(500).nullable().optional(),
  }).strict();

  app.patch<{ Body: unknown }>("/earning/me/session-presence", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
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
      if (!(await hasPurchased("user", me.id, "flair_session_presence"))) {
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
        .values({ serverId: DEFAULT_SERVER_ID, userId: me.id, ...updates })
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
      .where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, me.id)))
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
            tx.insert(characterEarning).values({ serverId: DEFAULT_SERVER_ID, characterId }).onConflictDoNothing().run();
            const row = tx.select().from(characterEarning).where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, characterId))).limit(1).all()[0]!;
            earning = { maxRankKeyEverHeld: row.maxRankKeyEverHeld, maxTierEverHeld: row.maxTierEverHeld };
          } else {
            tx.insert(userEarning).values({ serverId: DEFAULT_SERVER_ID, userId: me.id }).onConflictDoNothing().run();
            const row = tx.select().from(userEarning).where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, me.id))).limit(1).all()[0]!;
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
              eq(characterOwnedBorders.serverId, DEFAULT_SERVER_ID),
              eq(characterOwnedBorders.characterId, characterId),
              eq(characterOwnedBorders.rankKey, rankKey),
            )).limit(1).all()[0];
            if (already) return { ok: false, status: 409, error: "already owned" };
          } else {
            const already = tx.select().from(userOwnedBorders).where(and(
              eq(userOwnedBorders.serverId, DEFAULT_SERVER_ID),
              eq(userOwnedBorders.userId, me.id),
              eq(userOwnedBorders.rankKey, rankKey),
            )).limit(1).all()[0];
            if (already) return { ok: false, status: 409, error: "already owned" };
          }
          return { ok: true, cost: tier4.borderCost };
        },
        grant: (tx) => {
          if (characterId) {
            tx.insert(characterOwnedBorders).values({ serverId: DEFAULT_SERVER_ID, characterId, rankKey }).onConflictDoNothing().run();
            // Auto-equip on first character purchase. Reads /
            // writes `character_earning.selected_border_rank_key`.
            const cur = tx.select({ selected: characterEarning.selectedBorderRankKey }).from(characterEarning).where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, characterId))).limit(1).all()[0];
            if (!cur?.selected) {
              tx.update(characterEarning)
                .set({ selectedBorderRankKey: rankKey, updatedAt: new Date() })
                .where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, characterId)))
                .run();
            }
          } else {
            tx.insert(userOwnedBorders).values({ serverId: DEFAULT_SERVER_ID, userId: me.id, rankKey }).onConflictDoNothing().run();
            const cur = tx.select({ selected: userEarning.selectedBorderRankKey }).from(userEarning).where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, me.id))).limit(1).all()[0];
            if (!cur?.selected) {
              tx.update(userEarning)
                .set({ selectedBorderRankKey: rankKey, updatedAt: new Date() })
                .where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, me.id)))
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

  app.post<{ Params: { key: string }; Body: unknown }>(
    "/earning/me/freeform-borders/:key/purchase",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
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
      // we don't want nested under a purchase txn).
      const flashSale = await resolveTodayFlashSale(db);
      const outcome = runPurchaseTxn(db, me.id, {
        characterId,
        validate: (tx) => {
          const row = tx.select().from(freeformBorders).where(eq(freeformBorders.key, borderKey)).limit(1).all()[0];
          if (!row || !row.enabled) return { ok: false, status: 404, error: "border not found or disabled" };
          if (characterId) {
            const already = tx.select().from(characterOwnedFreeformBorders).where(and(
              eq(characterOwnedFreeformBorders.serverId, DEFAULT_SERVER_ID),
              eq(characterOwnedFreeformBorders.characterId, characterId),
              eq(characterOwnedFreeformBorders.borderKey, borderKey),
            )).limit(1).all()[0];
            if (already) return { ok: false, status: 409, error: "already owned" };
          } else {
            const already = tx.select().from(userOwnedFreeformBorders).where(and(
              eq(userOwnedFreeformBorders.serverId, DEFAULT_SERVER_ID),
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
            tx.insert(characterOwnedFreeformBorders).values({ serverId: DEFAULT_SERVER_ID, characterId, borderKey }).onConflictDoNothing().run();
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
            tx.insert(characterEarning).values({ serverId: DEFAULT_SERVER_ID, characterId }).onConflictDoNothing().run();
            const cur = tx.select({
              freeform: characterEarning.selectedFreeformBorderKey,
            }).from(characterEarning).where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, characterId))).limit(1).all()[0];
            if (!cur?.freeform) {
              tx.update(characterEarning)
                .set({ selectedFreeformBorderKey: borderKey, updatedAt: new Date() })
                .where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, characterId)))
                .run();
            }
          } else {
            tx.insert(userOwnedFreeformBorders).values({ serverId: DEFAULT_SERVER_ID, userId: me.id, borderKey }).onConflictDoNothing().run();
            tx.insert(userEarning).values({ serverId: DEFAULT_SERVER_ID, userId: me.id }).onConflictDoNothing().run();
            const cur = tx.select({
              freeform: userEarning.selectedFreeformBorderKey,
            }).from(userEarning).where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, me.id))).limit(1).all()[0];
            if (!cur?.freeform) {
              tx.update(userEarning)
                .set({ selectedFreeformBorderKey: borderKey, updatedAt: new Date() })
                .where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, me.id)))
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

  app.patch<{ Params: { key: string }; Body: unknown }>(
    "/earning/me/freeform-borders/:key/config",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
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
        .where(eq(freeformBorders.key, borderKey))
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
            eq(characterOwnedFreeformBorders.serverId, DEFAULT_SERVER_ID),
            eq(characterOwnedFreeformBorders.characterId, characterId),
            eq(characterOwnedFreeformBorders.borderKey, borderKey),
          ))
          .limit(1))[0];
        if (!owned) { reply.code(404); return { error: "not owned" }; }
        await db
          .update(characterOwnedFreeformBorders)
          .set({ configJson: cleaned ? JSON.stringify(cleaned) : null })
          .where(and(
            eq(characterOwnedFreeformBorders.serverId, DEFAULT_SERVER_ID),
            eq(characterOwnedFreeformBorders.characterId, characterId),
            eq(characterOwnedFreeformBorders.borderKey, borderKey),
          ));
      } else {
        const owned = (await db
          .select({ borderKey: userOwnedFreeformBorders.borderKey })
          .from(userOwnedFreeformBorders)
          .where(and(
            eq(userOwnedFreeformBorders.serverId, DEFAULT_SERVER_ID),
            eq(userOwnedFreeformBorders.userId, me.id),
            eq(userOwnedFreeformBorders.borderKey, borderKey),
          ))
          .limit(1))[0];
        if (!owned) { reply.code(404); return { error: "not owned" }; }
        await db
          .update(userOwnedFreeformBorders)
          .set({ configJson: cleaned ? JSON.stringify(cleaned) : null })
          .where(and(
            eq(userOwnedFreeformBorders.serverId, DEFAULT_SERVER_ID),
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

      const flashSale = await resolveTodayFlashSale(db);
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
          // partial-buying, the client should disable the Buy button
          // when at cap, so a 409 here is a defensive backstop.
          const existing = tx.select({ qty: identityInventory.quantity })
            .from(identityInventory)
            .where(and(
              eq(identityInventory.serverId, DEFAULT_SERVER_ID),
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
          // Flash-sale discount applies per UNIT (not per stack), a
          // bulk-buy of an on-sale item gets the discount on every
          // unit. Done after the stack-cap check so the discounted
          // cost reflects the actual quantity going through.
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
              eq(identityInventory.serverId, DEFAULT_SERVER_ID),
              eq(identityInventory.ownerScope, ownerScope),
              eq(identityInventory.ownerId, ownerId),
              eq(identityInventory.itemKey, req.params.key),
            )).limit(1).all()[0];
          if (existing) {
            tx.update(identityInventory)
              .set({ quantity: existing.qty + body.quantity, updatedAt: new Date() })
              .where(and(
                eq(identityInventory.serverId, DEFAULT_SERVER_ID),
                eq(identityInventory.ownerScope, ownerScope),
                eq(identityInventory.ownerId, ownerId),
                eq(identityInventory.itemKey, req.params.key),
              ))
              .run();
          } else {
            tx.insert(identityInventory).values({
              serverId: DEFAULT_SERVER_ID,
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

  app.put<{ Body: unknown }>("/earning/me/collection", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
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
              eq(identityInventory.serverId, DEFAULT_SERVER_ID),
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
              eq(identityCollection.serverId, DEFAULT_SERVER_ID),
              eq(identityCollection.ownerScope, ownerScope),
              eq(identityCollection.ownerId, ownerId),
              eq(identityCollection.slot, s.slot),
            )).run();
          } else {
            // Upsert via delete-then-insert. SQLite's ON CONFLICT
            // DO UPDATE works too, but this idiom matches the rest
            // of the codebase's per-row writes.
            tx.delete(identityCollection).where(and(
              eq(identityCollection.serverId, DEFAULT_SERVER_ID),
              eq(identityCollection.ownerScope, ownerScope),
              eq(identityCollection.ownerId, ownerId),
              eq(identityCollection.slot, s.slot),
            )).run();
            tx.insert(identityCollection).values({
              serverId: DEFAULT_SERVER_ID,
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
        return { error: `"${msg.slice("__pin_wrong_collection__:".length)}" is a pet, pin it to your Pet Collection instead.` };
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
              eq(identityInventory.serverId, DEFAULT_SERVER_ID),
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
            .where(inArray(items.key, itemKeysToCheck))
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
            eq(identityPetCollection.serverId, DEFAULT_SERVER_ID),
            eq(identityPetCollection.ownerScope, ownerScope),
            eq(identityPetCollection.ownerId, ownerId),
          ))
          .all();
        const priorNicknameByItem = new Map<string, string | null>();
        for (const r of priorRows) priorNicknameByItem.set(r.itemKey, r.nickname ?? null);
        for (const s of body.slots) {
          if (s.itemKey === null) {
            tx.delete(identityPetCollection).where(and(
              eq(identityPetCollection.serverId, DEFAULT_SERVER_ID),
              eq(identityPetCollection.ownerScope, ownerScope),
              eq(identityPetCollection.ownerId, ownerId),
              eq(identityPetCollection.slot, s.slot),
            )).run();
          } else {
            tx.delete(identityPetCollection).where(and(
              eq(identityPetCollection.serverId, DEFAULT_SERVER_ID),
              eq(identityPetCollection.ownerScope, ownerScope),
              eq(identityPetCollection.ownerId, ownerId),
              eq(identityPetCollection.slot, s.slot),
            )).run();
            tx.insert(identityPetCollection).values({
              serverId: DEFAULT_SERVER_ID,
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
        return { error: `you don't hold item "${msg.slice("__pin_not_owned__:".length)}" on this identity` };
      }
      if (msg.startsWith("__pin_wrong_collection__:")) {
        reply.code(403);
        return { error: `"${msg.slice("__pin_wrong_collection__:".length)}" isn't a pet, pin it to your Item Collection instead.` };
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

  app.patch<{ Params: { slot: string }; Body: unknown }>(
    "/earning/me/pet-collection/:slot/nickname",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
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
          eq(identityPetCollection.serverId, DEFAULT_SERVER_ID),
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
          eq(identityPetCollection.serverId, DEFAULT_SERVER_ID),
          eq(identityPetCollection.ownerScope, ownerScope),
          eq(identityPetCollection.ownerId, ownerId),
          eq(identityPetCollection.slot, slot),
        ));
      return { ok: true, slot, nickname: next };
    },
  );
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
 * give/throw/drop have non-empty message arrays, the dashboard +
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
 * one round trip, the dashboard reads the map indexed by the
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
